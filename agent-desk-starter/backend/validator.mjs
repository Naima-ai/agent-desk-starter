// backend/validator.mjs — L'Addetto IVA's brain.
// Validates a compiled VAT batch: completeness (are all expected documents present?)
// and coherence (is every line posted above the confidence threshold?).
// Returns the low-confidence TAIL and any ANOMALIES for the rest of the flow.
// >>> TODO (real): compare against prior periods from L3 and the ledger in TeamSystem.
const THRESHOLD = 0.85;

export function validateBatch(batch, receivedDocs = []) {
  const tail = batch.lines.filter((l) => (l.confidence ?? 0) < THRESHOLD || !l.account);
  const receivedKeys = new Set(receivedDocs.map((d) => `${d.supplier}:${d.period}`));
  const anomalies = (batch.expected || [])
    .filter((e) => !receivedKeys.has(`${e.supplier}:${e.period}`))
    .map((e) => ({ kind: "item_missing", expected: `${e.docType} ${e.supplier}`, period: e.period }));
  const ok = tail.length === 0 && anomalies.length === 0;
  return { ok, tail, anomalies, threshold: THRESHOLD, total: batch.lines.length };
}
