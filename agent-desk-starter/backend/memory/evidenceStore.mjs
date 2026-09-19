// backend/memory/evidenceStore.mjs — immutable, append-only. "What proves."
// Persists to data/evidence.jsonl so evidence survives a restart — the in-memory
// array alone (the original starter behaviour) forgot everything on every restart.
// >>> TODO (real): back this with a real append-only store (object storage + a
//     database index, per-client partitioned) instead of a local file.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "..", "data");
const file = join(dataDir, "evidence.jsonl");

function load() {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8").trim();
  if (!text) return [];
  return text.split("\n").map((line) => JSON.parse(line));
}

const items = load();

function persist(rec) {
  mkdirSync(dataDir, { recursive: true });
  appendFileSync(file, JSON.stringify(rec) + "\n", "utf8");
}

export function put(evidence) {
  const hash = createHash("sha256").update(JSON.stringify(evidence)).digest("hex").slice(0, 12);
  const rec = Object.freeze({ id: `ev_${items.length + 1}`, hash, ...evidence, at: new Date().toISOString() });
  items.push(rec); // append-only in memory: never mutated, never deleted
  persist(rec);     // append-only on disk: survives a restart
  return rec;
}
export function all() { return items.slice(); }
