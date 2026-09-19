// backend/memory/evidenceStore.mjs — immutable, append-only. "What proves."
import { createHash } from "node:crypto";
const items = [];
export function put(evidence) {
  const hash = createHash("sha256").update(JSON.stringify(evidence)).digest("hex").slice(0, 12);
  const rec = Object.freeze({ id: `ev_${items.length + 1}`, hash, ...evidence, at: new Date().toISOString() });
  items.push(rec); // append-only: never mutated, never deleted
  return rec;
}
export function all() { return items.slice(); }
