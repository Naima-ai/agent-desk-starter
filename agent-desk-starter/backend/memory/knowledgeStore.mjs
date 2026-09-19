// backend/memory/knowledgeStore.mjs — typed, versioned objects. "What is believed."
const store = new Map(); // key -> object with provenance
export function upsert(obj) {
  // obj: { key, kind, scope, value, confidence, source, confirmedBy, evidenceId }
  const prev = store.get(obj.key);
  const rec = {
    ...obj,
    version: (prev?.version ?? 0) + 1,
    lastVerified: new Date().toISOString(),
  };
  store.set(obj.key, rec);
  return rec;
}
export function get(key) { return store.get(key) || null; }
export function all() { return [...store.values()]; }
