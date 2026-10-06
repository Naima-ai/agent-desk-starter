function copyState(state) {
  return state || { admitted: new Map(), completed: new Map() };
}

export class MemoryIdempotencyStore {
  constructor({ state = null, clock = () => Date.now(), retentionMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
    this.state = copyState(state);
    this.clock = clock;
    this.retentionMs = retentionMs;
  }

  #prune() {
    const cutoff = this.clock() - this.retentionMs;
    for (const [key, record] of this.state.admitted) if (record.at < cutoff) this.state.admitted.delete(key);
    for (const [key, at] of this.state.completed) if (at < cutoff) this.state.completed.delete(key);
  }

  async admit(messageId, digest) {
    this.#prune();
    const existing = this.state.admitted.get(messageId);
    if (!existing) {
      this.state.admitted.set(messageId, { digest, at: this.clock() });
      return "new";
    }
    return existing.digest === digest ? "duplicate" : "conflict";
  }

  async forgetAdmission(messageId, digest) {
    const existing = this.state.admitted.get(messageId);
    if (existing?.digest === digest) this.state.admitted.delete(messageId);
  }

  async isCompleted(consumerId, messageId) {
    this.#prune();
    return this.state.completed.has(`${consumerId}:${messageId}`);
  }

  async markCompleted(consumerId, messageId) {
    this.#prune();
    this.state.completed.set(`${consumerId}:${messageId}`, this.clock());
  }
}

export class RedisIdempotencyStore {
  constructor({ clientProvider, prefix = "agentdesk:a2a", retentionSeconds = 7 * 24 * 60 * 60 } = {}) {
    if (typeof clientProvider !== "function") throw new TypeError("Redis idempotency requires a client provider.");
    this.clientProvider = clientProvider;
    this.prefix = prefix;
    this.retentionSeconds = retentionSeconds;
  }

  async admit(messageId, digest) {
    const client = this.clientProvider();
    const key = `${this.prefix}:admitted:${messageId}`;
    const result = await client.set(key, digest, { NX: true, EX: this.retentionSeconds });
    if (result === "OK") return "new";
    return (await client.get(key)) === digest ? "duplicate" : "conflict";
  }

  async forgetAdmission(messageId, digest) {
    const client = this.clientProvider();
    const key = `${this.prefix}:admitted:${messageId}`;
    await client.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
      { keys: [key], arguments: [digest] },
    );
  }

  async isCompleted(consumerId, messageId) {
    const client = this.clientProvider();
    return Boolean(await client.exists(`${this.prefix}:completed:${consumerId}:${messageId}`));
  }

  async markCompleted(consumerId, messageId) {
    const client = this.clientProvider();
    await client.set(`${this.prefix}:completed:${consumerId}:${messageId}`, "1", { EX: this.retentionSeconds });
  }
}
