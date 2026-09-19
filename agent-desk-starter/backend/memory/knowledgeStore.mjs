// backend/memory/knowledgeStore.mjs — typed, versioned objects. "What is believed."
// Persists to data/knowledge.json so learned rules survive a restart — the
// in-memory Map alone (the original starter behaviour) forgot every learned
// rule the moment the server stopped.
// >>> TODO (real): back this with LanceDB / memory-wiki, per-client partitioned.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "..", "data");
const file = join(dataDir, "knowledge.json");

function load() {
  if (!existsSync(file)) return new Map();
  const raw = JSON.parse(readFileSync(file, "utf8"));
  return new Map(Object.entries(raw));
}

const store = load();

function persist() {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify(Object.fromEntries(store), null, 2), "utf8");
}

export function upsert(obj) {
  // obj: { key, kind, scope, value, confidence, source, confirmedBy, evidenceId }
  const prev = store.get(obj.key);
  const rec = {
    ...obj,
    version: (prev?.version ?? 0) + 1,
    lastVerified: new Date().toISOString(),
  };
  store.set(obj.key, rec);
  persist();
  return rec;
}
export function get(key) { return store.get(key) || null; }
export function all() { return [...store.values()]; }
