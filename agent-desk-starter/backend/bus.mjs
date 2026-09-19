// backend/bus.mjs — tiny pub/sub. In production: Redis Streams / NATS.
import { EventEmitter } from "node:events";
const emitter = new EventEmitter();
emitter.setMaxListeners(100);
const log = [];
export function publish(channel, event) {
  const evt = { channel, ...event, at: new Date().toISOString() };
  log.push(evt);
  emitter.emit("evt", evt);
  return evt;
}
export function subscribe(fn) { emitter.on("evt", fn); return () => emitter.off("evt", fn); }
export function history() { return log.slice(); }
