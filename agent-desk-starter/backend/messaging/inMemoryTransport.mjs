import { randomUUID } from "node:crypto";
import { TransportError } from "./transport.mjs";

export function createInMemoryTransportState() {
  return { streams: new Map(), groups: new Map(), deadLetters: [], sequence: 0 };
}

export class InMemoryTransport {
  #subscriptions = new Map();
  #pumping = new Set();
  #timers = new Set();

  constructor({ state = null, clock = () => Date.now(), maxStreamLength = 1_000, maxDeadLetters = 500 } = {}) {
    this.state = state || createInMemoryTransportState();
    this.clock = clock;
    this.maxStreamLength = maxStreamLength;
    this.maxDeadLetters = maxDeadLetters;
    this.connected = false;
  }

  async connect() { this.connected = true; return this; }

  async close() {
    this.connected = false;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#subscriptions.clear();
  }

  async publish(recipient, payload, { messageId = null } = {}) {
    if (!this.connected) throw new TransportError("TRANSPORT_NOT_CONNECTED", "A2A transport is not connected.");
    const stream = this.state.streams.get(recipient) || [];
    if (stream.length >= this.maxStreamLength) {
      throw new TransportError("TRANSPORT_CAPACITY_EXCEEDED", `Recipient stream "${recipient}" reached its safe capacity.`);
    }
    const entry = {
      id: `mem-${++this.state.sequence}`,
      messageId,
      recipient,
      payload,
      status: "available",
      availableAt: this.clock(),
      enqueuedAt: this.clock(),
      claimedAt: null,
      claimedBy: null,
      attempts: 0,
    };
    stream.push(entry);
    this.state.streams.set(recipient, stream);
    this.#schedulePump(recipient);
    return { id: entry.id, messageId, recipient, persisted: true };
  }

  async consume({ recipient, consumerId, concurrency = 1 }, handler) {
    if (!this.connected) throw new TransportError("TRANSPORT_NOT_CONNECTED", "A2A transport is not connected.");
    if (typeof handler !== "function") throw new TypeError("Transport consumer handler is required.");
    const existingGroup = this.state.groups.get(recipient);
    if (existingGroup && existingGroup !== consumerId) {
      throw new TransportError("CONSUMER_GROUP_CONFLICT", `Recipient "${recipient}" already uses consumer group "${existingGroup}".`, { retryable: false });
    }
    this.state.groups.set(recipient, consumerId);
    const subscription = {
      id: randomUUID(), recipient, consumerId, handler,
      concurrency: Math.max(1, Number(concurrency) || 1), inFlight: 0, active: true,
    };
    const list = this.#subscriptions.get(recipient) || [];
    list.push(subscription);
    this.#subscriptions.set(recipient, list);
    this.#schedulePump(recipient);
    return async () => {
      subscription.active = false;
      this.#subscriptions.set(recipient, (this.#subscriptions.get(recipient) || []).filter((item) => item !== subscription));
    };
  }

  #delivery(entry, consumerId) {
    return Object.freeze({
      id: entry.id,
      messageId: entry.messageId,
      recipient: entry.recipient,
      payload: entry.payload,
      attempt: entry.attempts,
      enqueuedAt: new Date(entry.enqueuedAt).toISOString(),
      claimedAt: new Date(entry.claimedAt).toISOString(),
      consumerId,
    });
  }

  #schedulePump(recipient, delayMs = 0) {
    if (!this.connected) return;
    if (delayMs > 0) {
      const timer = setTimeout(() => {
        this.#timers.delete(timer);
        this.#schedulePump(recipient);
      }, delayMs);
      timer.unref?.();
      this.#timers.add(timer);
      return;
    }
    queueMicrotask(() => this.#pump(recipient));
  }

  #pump(recipient) {
    if (!this.connected || this.#pumping.has(recipient)) return;
    this.#pumping.add(recipient);
    try {
      const stream = this.state.streams.get(recipient) || [];
      const subscriptions = (this.#subscriptions.get(recipient) || []).filter((subscription) => subscription.active);
      if (!subscriptions.length) return;
      let scheduledFuture = false;
      while (true) {
        const subscription = subscriptions.find((candidate) => candidate.inFlight < candidate.concurrency);
        if (!subscription) break;
        const now = this.clock();
        const entry = stream.find((candidate) => candidate.status === "available" && candidate.availableAt <= now);
        if (!entry) {
          const next = stream.filter((candidate) => candidate.status === "available").sort((a, b) => a.availableAt - b.availableAt)[0];
          if (next && !scheduledFuture) {
            scheduledFuture = true;
            this.#schedulePump(recipient, Math.max(1, next.availableAt - now));
          }
          break;
        }
        entry.status = "pending";
        entry.claimedAt = now;
        entry.claimedBy = subscription.id;
        entry.attempts += 1;
        subscription.inFlight += 1;
        const delivery = this.#delivery(entry, subscription.consumerId);
        Promise.resolve()
          .then(() => subscription.handler(delivery))
          .catch(() => this.nack(delivery, "transport_handler_failed"))
          .finally(() => {
            subscription.inFlight -= 1;
            this.#schedulePump(recipient);
          });
      }
    } finally {
      this.#pumping.delete(recipient);
    }
  }

  #find(delivery) {
    return (this.state.streams.get(delivery.recipient) || []).find((entry) => entry.id === delivery.id);
  }

  async ack(delivery) {
    const stream = this.state.streams.get(delivery.recipient) || [];
    const index = stream.findIndex((entry) => entry.id === delivery.id && entry.status === "pending");
    if (index < 0) return false;
    stream.splice(index, 1);
    return true;
  }

  async nack(delivery, reason, { delayMs = 0 } = {}) {
    const entry = this.#find(delivery);
    if (!entry || entry.status !== "pending") return false;
    entry.status = "available";
    entry.availableAt = this.clock() + Math.max(0, delayMs);
    entry.claimedAt = null;
    entry.claimedBy = null;
    entry.lastFailure = String(reason || "consumer_failed").slice(0, 240);
    this.#schedulePump(entry.recipient, delayMs);
    return true;
  }

  async recover({ recipient, consumerId, minIdleMs = 30_000 } = {}) {
    const now = this.clock();
    let recovered = 0;
    for (const entry of this.state.streams.get(recipient) || []) {
      if (entry.status === "pending" && now - entry.claimedAt >= minIdleMs) {
        entry.status = "available";
        entry.availableAt = now;
        entry.claimedAt = null;
        entry.claimedBy = null;
        recovered += 1;
      }
    }
    if (recovered) this.#schedulePump(recipient);
    return { recipient, consumerId, recovered };
  }

  async deadLetter(delivery, metadata = {}) {
    const stream = this.state.streams.get(delivery.recipient) || [];
    const index = stream.findIndex((entry) => entry.id === delivery.id);
    const entry = index >= 0 ? stream.splice(index, 1)[0] : null;
    const record = Object.freeze({
      id: entry?.id || delivery.id,
      messageId: entry?.messageId || delivery.messageId,
      recipient: delivery.recipient,
      payload: entry?.payload || delivery.payload,
      failure: { ...metadata },
      at: new Date(this.clock()).toISOString(),
    });
    this.state.deadLetters.push(record);
    if (this.state.deadLetters.length > this.maxDeadLetters) {
      this.state.deadLetters.splice(0, this.state.deadLetters.length - this.maxDeadLetters);
    }
    return record;
  }

  async deadLetters() { return this.state.deadLetters.slice(); }

  async replayDeadLetter(id) {
    const index = this.state.deadLetters.findIndex((record) => record.id === id);
    if (index < 0) return null;
    const record = this.state.deadLetters[index];
    const persisted = await this.publish(record.recipient, record.payload, { messageId: record.messageId });
    this.state.deadLetters.splice(index, 1);
    return { ...persisted, replayedDeadLetterId: id };
  }

  async health() {
    const entries = [...this.state.streams.values()].flat();
    const pending = entries.filter((entry) => entry.status === "pending");
    return {
      transport: "memory",
      connected: this.connected,
      publishReady: this.connected,
      consumeReady: this.connected,
      queued: entries.filter((entry) => entry.status === "available").length,
      pending: pending.length,
      oldestPendingAgeMs: pending.length ? this.clock() - Math.min(...pending.map((entry) => entry.claimedAt)) : 0,
      deadLetters: this.state.deadLetters.length,
    };
  }
}
