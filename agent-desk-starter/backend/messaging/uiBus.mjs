import { EventEmitter } from "node:events";

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export class UiBus {
  #emitter = new EventEmitter();
  #history = [];

  constructor({ historyLimit = 500, clock = () => Date.now() } = {}) {
    this.historyLimit = positiveInteger(historyLimit, 500);
    this.clock = clock;
    this.#emitter.setMaxListeners(100);
  }

  publish(channel, event = {}) {
    if (typeof channel !== "string" || !channel) throw new TypeError("UI channel is required.");
    const published = Object.freeze({ channel, ...event, at: new Date(this.clock()).toISOString() });
    this.#history.push(published);
    if (this.#history.length > this.historyLimit) {
      this.#history.splice(0, this.#history.length - this.historyLimit);
    }
    // One broken UI/SSE listener must not affect durable message processing.
    for (const listener of this.#emitter.listeners("event")) {
      try { listener(published); } catch { /* Isolated telemetry failure. */ }
    }
    return published;
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("UI subscriber must be a function.");
    this.#emitter.on("event", listener);
    return () => this.#emitter.off("event", listener);
  }

  history({ channel = null } = {}) {
    return this.#history.filter((event) => !channel || event.channel === channel).slice();
  }

  clear() { this.#history.length = 0; }
}

export const defaultUiBus = new UiBus({ historyLimit: process.env.UI_HISTORY_LIMIT });
export const publishUi = defaultUiBus.publish.bind(defaultUiBus);
export const subscribeUi = defaultUiBus.subscribe.bind(defaultUiBus);
export const uiHistory = defaultUiBus.history.bind(defaultUiBus);

