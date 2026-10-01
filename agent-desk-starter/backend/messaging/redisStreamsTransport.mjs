import { randomUUID } from "node:crypto";
import { TransportError } from "./transport.mjs";

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export class RedisStreamsTransport {
  #subscriptions = new Set();
  #recipients = new Set();

  constructor({
    url = process.env.REDIS_URL || "redis://127.0.0.1:6379",
    client = null,
    prefix = "agentdesk:a2a",
    maxStreamLength = 10_000,
    maxDeadLetters = 2_000,
    blockMs = 1_000,
    claimMinIdleMs = 30_000,
    recoveryIntervalMs = 10_000,
  } = {}) {
    this.url = url;
    this.client = client;
    this.prefix = prefix;
    this.maxStreamLength = maxStreamLength;
    this.maxDeadLetters = maxDeadLetters;
    this.blockMs = blockMs;
    this.claimMinIdleMs = claimMinIdleMs;
    this.recoveryIntervalMs = recoveryIntervalMs;
    this.connected = false;
    this.ownsClient = !client;
    this.lastError = null;
    this.lastSuccessAt = null;
  }

  streamKey(recipient) { return `${this.prefix}:${recipient}`; }
  attemptsKey(recipient) { return `${this.prefix}:attempts:${recipient}`; }
  deadLetterKey() { return `${this.prefix}:dead-letter`; }

  async connect() {
    if (this.connected) return this;
    if (!this.client) {
      const { createClient } = await import("redis");
      this.client = createClient({ url: this.url });
    }
    this.client.on?.("error", (error) => { this.lastError = error?.message || String(error); });
    if (!this.client.isOpen) await this.client.connect();
    this.connected = true;
    return this;
  }

  async close() {
    this.connected = false;
    const subscriptions = [...this.#subscriptions];
    for (const subscription of subscriptions) subscription.stopped = true;
    for (const subscription of subscriptions) {
      if (subscription.recoveryTimer) clearInterval(subscription.recoveryTimer);
      try { if (subscription.client?.isOpen) await subscription.client.close(); } catch { /* Best effort shutdown. */ }
    }
    this.#subscriptions.clear();
    if (this.ownsClient && this.client?.isOpen) await this.client.close();
  }

  async publish(recipient, payload, { messageId = null } = {}) {
    if (!this.connected) throw new TransportError("TRANSPORT_NOT_CONNECTED", "Redis transport is not connected.");
    const key = this.streamKey(recipient);
    this.#recipients.add(recipient);
    const id = await this.client.xAdd(key, "*", {
      messageId: messageId || "",
      payload,
      enqueuedAt: new Date().toISOString(),
    }, { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: this.maxStreamLength } });
    return { id, messageId, recipient, persisted: true };
  }

  async #ensureGroup(recipient, consumerId) {
    try {
      await this.client.xGroupCreate(this.streamKey(recipient), consumerId, "0", { MKSTREAM: true });
    } catch (error) {
      if (!String(error?.message || error).includes("BUSYGROUP")) throw error;
    }
  }

  async #toDelivery(recipient, consumerId, entry) {
    const attempt = Number(await this.client.hIncrBy(this.attemptsKey(recipient), entry.id, 1));
    return Object.freeze({
      id: entry.id,
      messageId: entry.message.messageId || null,
      recipient,
      payload: entry.message.payload,
      attempt,
      enqueuedAt: entry.message.enqueuedAt || null,
      claimedAt: new Date().toISOString(),
      consumerId,
      group: consumerId,
    });
  }

  async #dispatchEntries(subscription, entries) {
    for (const entry of entries) {
      if (subscription.stopped) return;
      const delivery = await this.#toDelivery(subscription.recipient, subscription.consumerId, entry);
      try {
        await subscription.handler(delivery);
        this.lastSuccessAt = new Date().toISOString();
      } catch (error) {
        this.lastError = error?.message || String(error);
        await this.nack(delivery, this.lastError);
      }
    }
  }

  async #readLoop(subscription) {
    while (this.connected && !subscription.stopped) {
      try {
        const streams = await subscription.client.xReadGroup(
          subscription.consumerId,
          subscription.consumerName,
          [{ key: this.streamKey(subscription.recipient), id: ">" }],
          { COUNT: subscription.concurrency, BLOCK: this.blockMs },
        );
        for (const stream of streams || []) await this.#dispatchEntries(subscription, stream.messages || []);
      } catch (error) {
        if (subscription.stopped || !this.connected) break;
        this.lastError = error?.message || String(error);
        await sleep(Math.min(1_000, this.blockMs));
      }
    }
  }

  async consume({ recipient, consumerId, concurrency = 1 }, handler) {
    if (!this.connected) throw new TransportError("TRANSPORT_NOT_CONNECTED", "Redis transport is not connected.");
    await this.#ensureGroup(recipient, consumerId);
    this.#recipients.add(recipient);
    const blockingClient = this.client.duplicate();
    blockingClient.on?.("error", (error) => { this.lastError = error?.message || String(error); });
    await blockingClient.connect();
    const subscription = {
      recipient, consumerId, concurrency: Math.max(1, Number(concurrency) || 1), handler,
      consumerName: `${consumerId}-${process.pid}-${randomUUID()}`,
      client: blockingClient, stopped: false, recoveryTimer: null,
    };
    this.#subscriptions.add(subscription);
    subscription.recoveryTimer = setInterval(() => {
      this.recover({ recipient, consumerId, consumerName: subscription.consumerName, handler }).catch((error) => {
        this.lastError = error?.message || String(error);
      });
    }, this.recoveryIntervalMs);
    subscription.recoveryTimer.unref?.();
    this.#readLoop(subscription);
    return async () => {
      subscription.stopped = true;
      clearInterval(subscription.recoveryTimer);
      this.#subscriptions.delete(subscription);
      if (subscription.client.isOpen) await subscription.client.close();
    };
  }

  async ack(delivery) {
    const count = Number(await this.client.xAck(this.streamKey(delivery.recipient), delivery.group || delivery.consumerId, delivery.id));
    if (count) {
      await Promise.all([
        this.client.hDel(this.attemptsKey(delivery.recipient), delivery.id),
        this.client.xDel(this.streamKey(delivery.recipient), delivery.id),
      ]);
    }
    return count > 0;
  }

  async nack(delivery, reason, { delayMs = 0 } = {}) {
    await this.client.hSet(`${this.prefix}:failures:${delivery.recipient}`, delivery.id, JSON.stringify({
      reason: String(reason || "consumer_failed").slice(0, 240),
      retryAfter: Date.now() + Math.max(delayMs, this.claimMinIdleMs),
    }));
    // Leaving the entry in the PEL is the Redis at-least-once retry mechanism.
    // XAUTOCLAIM recovers it after the configured idle/backoff period.
    return true;
  }

  async recover({ recipient, consumerId, consumerName = `${consumerId}-${process.pid}`, handler = null, minIdleMs = this.claimMinIdleMs } = {}) {
    if (!handler) {
      const subscription = [...this.#subscriptions].find((item) =>
        !item.stopped && item.recipient === recipient && item.consumerId === consumerId);
      if (subscription) {
        handler = subscription.handler;
        consumerName = subscription.consumerName;
      }
    }
    const result = await this.client.xAutoClaim(
      this.streamKey(recipient), consumerId, consumerName, minIdleMs, "0-0", { COUNT: 100 },
    );
    const entries = result?.messages || [];
    if (handler && entries.length) {
      await this.#dispatchEntries({ recipient, consumerId, consumerName, handler, stopped: false }, entries);
    }
    return { recipient, consumerId, recovered: entries.length, deletedIds: result?.deletedMessages || [] };
  }

  async deadLetter(delivery, metadata = {}) {
    await this.client.xAdd(this.deadLetterKey(), "*", {
      recipient: delivery.recipient,
      deliveryId: delivery.id,
      messageId: delivery.messageId || "",
      payload: delivery.payload,
      failure: JSON.stringify(metadata),
      at: new Date().toISOString(),
    }, { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: this.maxDeadLetters } });
    await this.ack(delivery);
    return { id: delivery.id, recipient: delivery.recipient, ...metadata };
  }

  async deadLetters({ count = 100 } = {}) {
    const entries = await this.client.xRevRange(this.deadLetterKey(), "+", "-", { COUNT: count });
    return entries.map((entry) => ({ id: entry.id, ...entry.message }));
  }

  async health() {
    let queued = 0;
    let pending = 0;
    let oldestPendingAgeMs = 0;
    for (const recipient of this.#recipients) {
      queued += Number(await this.client.xLen(this.streamKey(recipient)));
      for (const subscription of [...this.#subscriptions].filter((item) => item.recipient === recipient)) {
        try {
          const summary = await this.client.xPending(this.streamKey(recipient), subscription.consumerId);
          pending += Number(summary?.pending || 0);
          if (summary?.minimumId) {
            const timestamp = Number(String(summary.minimumId).split("-")[0]);
            oldestPendingAgeMs = Math.max(oldestPendingAgeMs, Date.now() - timestamp);
          }
        } catch { /* Group may be initializing. */ }
      }
    }
    return {
      transport: "redis",
      connected: this.connected && Boolean(this.client?.isReady),
      publishReady: Boolean(this.client?.isReady),
      consumeReady: this.connected,
      queued, pending, oldestPendingAgeMs,
      deadLetters: Number(await this.client.xLen(this.deadLetterKey())),
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
    };
  }
}
