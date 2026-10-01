import { A2AMessageSchema, messageDigest, verifyMessage } from "../../contracts/a2aSchema.mjs";
import { MemoryIdempotencyStore, RedisIdempotencyStore } from "./idempotencyStore.mjs";
import { InMemoryTransport } from "./inMemoryTransport.mjs";
import { RedisStreamsTransport } from "./redisStreamsTransport.mjs";
import { createRetryPolicy } from "./retryPolicy.mjs";
import { assertTransport } from "./transport.mjs";
import { defaultUiBus } from "./uiBus.mjs";

export class MessagingError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = "MessagingError";
    this.code = code;
    this.retryable = retryable;
  }
}

function safeFailure(error, classification) {
  return {
    code: classification.code,
    reason: classification.reason,
    message: String(error?.message || "Message processing failed.").slice(0, 240),
  };
}

export class A2ABus {
  #connecting = null;
  #subscriptions = new Set();

  constructor({
    transport,
    idempotencyStore = new MemoryIdempotencyStore(),
    retryPolicy = createRetryPolicy(),
    uiBus = defaultUiBus,
    verify = verifyMessage,
    recipientAllowed = () => true,
  } = {}) {
    this.transport = assertTransport(transport);
    this.idempotencyStore = idempotencyStore;
    this.retryPolicy = retryPolicy;
    this.uiBus = uiBus;
    this.verify = verify;
    this.recipientAllowed = recipientAllowed;
    this.connected = false;
    this.closed = false;
  }

  async connect() {
    if (this.closed) throw new MessagingError("A2A_BUS_CLOSED", "A2A bus is closed.");
    if (this.connected) return this;
    if (!this.#connecting) {
      this.#connecting = this.transport.connect().then(() => {
        this.connected = true;
        return this;
      }).finally(() => { this.#connecting = null; });
    }
    return this.#connecting;
  }

  #parseAndVerify(value) {
    const parsed = A2AMessageSchema.safeParse(value);
    if (!parsed.success) throw new MessagingError("INVALID_A2A_MESSAGE", "A2A message failed strict schema validation.");
    if (!this.verify(parsed.data)) throw new MessagingError("INVALID_A2A_SIGNATURE", "A2A message signature is invalid.");
    return parsed.data;
  }

  async publishA2A(rawMessage, { publisher = rawMessage?.from } = {}) {
    await this.connect();
    const message = this.#parseAndVerify(rawMessage);
    if (publisher !== message.from) throw new MessagingError("PUBLISHER_MISMATCH", "Publisher identity does not match message sender.");
    if (!await this.recipientAllowed(message.to, message)) {
      throw new MessagingError("RECIPIENT_NOT_ALLOWED", `Recipient "${message.to}" is not authorized.`);
    }
    const digest = messageDigest(message);
    const admission = await this.idempotencyStore.admit(message.id, digest);
    if (admission === "conflict") throw new MessagingError("MESSAGE_ID_CONFLICT", "Message ID was reused with different signed content.");
    if (admission === "duplicate") return { status: "duplicate", messageId: message.id, persisted: true };

    let persisted;
    try {
      persisted = await this.transport.publish(message.to, JSON.stringify(message), { messageId: message.id });
    } catch (error) {
      await this.idempotencyStore.forgetAdmission?.(message.id, digest);
      throw new MessagingError("A2A_PERSIST_FAILED", "A2A message could not be persisted.", { retryable: true, cause: error });
    }
    try { this.uiBus.publish("a2a", { message }); } catch { /* UI is never part of durable success. */ }
    return { status: "persisted", messageId: message.id, deliveryId: persisted.id, persisted: true };
  }

  async subscribeA2A({ recipient, consumerId, concurrency = 1 }, handler) {
    await this.connect();
    if (typeof handler !== "function") throw new TypeError("A2A consumer handler is required.");
    const off = await this.transport.consume({ recipient, consumerId, concurrency }, async (delivery) => {
      let message;
      try {
        message = this.#parseAndVerify(JSON.parse(delivery.payload));
        if (message.to !== recipient) throw new MessagingError("RECIPIENT_NOT_ALLOWED", "Delivery reached the wrong recipient.");
        if (!await this.recipientAllowed(recipient, message)) {
          throw new MessagingError("RECIPIENT_NOT_ALLOWED", `Recipient "${recipient}" is not authorized.`);
        }
      } catch (error) {
        await this.transport.deadLetter(delivery, safeFailure(error, { code: error.code || "INVALID_A2A_MESSAGE", reason: "permanent_failure" }));
        return;
      }

      if (await this.idempotencyStore.isCompleted(consumerId, message.id)) {
        await this.transport.ack(delivery);
        return;
      }

      try {
        const result = await handler(message, {
          deliveryId: delivery.id,
          attempt: delivery.attempt,
          correlationId: message.correlationId || message.id,
          causationId: message.causationId || null,
        });
        // Refusal and approval-wait are durable business outcomes, not retryable
        // transport failures. The approval store owns later resumption.
        await this.idempotencyStore.markCompleted(consumerId, message.id);
        await this.transport.ack(delivery);
        return result;
      } catch (error) {
        const classification = this.retryPolicy.classify(error, delivery.attempt);
        if (!classification.retry) {
          await this.transport.deadLetter(delivery, safeFailure(error, classification));
          return;
        }
        await this.transport.nack(delivery, classification.code, { delayMs: classification.delayMs });
      }
    });
    this.#subscriptions.add(off);
    return async () => {
      this.#subscriptions.delete(off);
      await off();
    };
  }

  async recover(options) {
    await this.connect();
    return this.transport.recover(options);
  }

  async health() {
    await this.connect();
    return this.transport.health();
  }

  async deadLetters(options) {
    await this.connect();
    return typeof this.transport.deadLetters === "function" ? this.transport.deadLetters(options) : [];
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const off of [...this.#subscriptions]) await off();
    this.#subscriptions.clear();
    await this.transport.close();
    this.connected = false;
  }
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function createDefaultA2ABus() {
  const selected = (process.env.A2A_TRANSPORT || "memory").toLowerCase();
  if (selected === "redis") {
    const transport = new RedisStreamsTransport({
      maxStreamLength: numberFromEnv("A2A_RETENTION", 10_000),
      claimMinIdleMs: numberFromEnv("A2A_CLAIM_IDLE_MS", 30_000),
    });
    return new A2ABus({
      transport,
      idempotencyStore: new RedisIdempotencyStore({ clientProvider: () => transport.client }),
      retryPolicy: createRetryPolicy({ maxAttempts: numberFromEnv("A2A_MAX_ATTEMPTS", 5) }),
    });
  }
  if (selected !== "memory") throw new Error(`Unsupported A2A_TRANSPORT "${selected}".`);
  return new A2ABus({
    transport: new InMemoryTransport({ maxStreamLength: numberFromEnv("A2A_RETENTION", 1_000) }),
    retryPolicy: createRetryPolicy({ maxAttempts: numberFromEnv("A2A_MAX_ATTEMPTS", 5) }),
  });
}

export const defaultA2ABus = createDefaultA2ABus();
export const publishA2A = defaultA2ABus.publishA2A.bind(defaultA2ABus);
export const subscribeA2A = defaultA2ABus.subscribeA2A.bind(defaultA2ABus);
