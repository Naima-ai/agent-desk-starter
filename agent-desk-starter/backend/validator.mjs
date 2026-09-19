// backend/validator.mjs — L'Addetto IVA's brain.
// Validates a compiled VAT batch across four things: completeness (are all
// expected documents present?), coherence (is every line posted above the
// confidence threshold?), consistency against the prior period, and the
// Italian VAT business rules (Rulebook Section 6, via vatRules.mjs).
// Returns the low-confidence TAIL and every ANOMALY for the rest of the flow.
import { runVatRules } from "./vatRules.mjs";

const THRESHOLD = 0.85;
const VALUE_DEVIATION_TOLERANCE = 0.2; // a >20% swing vs. the same supplier, prior period, "does not reconcile"

/** Cross-period reconciliation: a recurring supplier whose value swings by more
 *  than the tolerance needs a look before it's trusted.
 *  NOTE: this is NOT one of the rulebook's 21 catalogued rules — the rulebook's
 *  actual CST-05 is "cross-document references valid" (e.g. a credit note
 *  references a real invoice), a different check this codebase doesn't have
 *  yet. This control is a genuine, useful addition in the spirit of Section
 *  5.5 ("coherent... across related records") and Section 3's own mention of
 *  comparing against prior periods — but it gets its own tag, not a borrowed
 *  rule ID, so it's never confused with something the rulebook actually names. */
function checkPriorPeriod(lines, priorPeriod) {
  if (!priorPeriod?.lines?.length) return [];
  const bySupplier = new Map(priorPeriod.lines.map((l) => [l.supplier, l]));
  const anomalies = [];
  for (const line of lines) {
    const prior = bySupplier.get(line.supplier);
    if (!prior || !prior.net) continue;
    const deltaPct = Math.round((Math.abs(line.net - prior.net) / prior.net) * 1000) / 10;
    if (deltaPct / 100 > VALUE_DEVIATION_TOLERANCE) {
      anomalies.push({
        ruleId: "PRIOR-PERIOD", severity: "Major", kind: "value_deviation", line: line.id, supplier: line.supplier,
        observed: line.net, priorNet: prior.net, deltaPct,
        message: `${line.supplier}: €${line.net} this period vs €${prior.net} last period (${deltaPct}% change) — does not reconcile.`,
      });
    }
  }
  return anomalies;
}

/**
 * @param {object} batch - the VAT batch (as handed over by TeamSystem).
 * @param {object} [opts]
 * @param {Array}  [opts.receivedDocs] - documents actually on file this period.
 * @param {object} [opts.priorPeriod]  - the same client's prior-period batch.
 * @param {Array}  [opts.taxonomy]     - the client's chart of accounts (code -> expected rate).
 */
export function validateBatch(batch, { receivedDocs = [], priorPeriod = null, taxonomy = [] } = {}) {
  const tail = batch.lines.filter((l) => (l.confidence ?? 0) < THRESHOLD || !l.account);

  // NOTE: also not one of the 21 catalogued rules — the rulebook's STR-02 is
  // about fields missing WITHIN one document, not a whole expected document
  // being absent from the batch. This is a batch-level completeness check
  // (Section 3's "Ingestion... register the item" / "fail closed" principle),
  // tagged separately rather than borrowing STR-02's ID for something it
  // doesn't mean.
  const receivedKeys = new Set(receivedDocs.map((d) => `${d.supplier}:${d.period}`));
  const missing = (batch.expected || [])
    .filter((e) => !receivedKeys.has(`${e.supplier}:${e.period}`))
    .map((e) => ({ ruleId: "DOC-MISSING", severity: "Blocking", kind: "item_missing", expected: `${e.docType} ${e.supplier}`, period: e.period }));

  const priorPeriodAnomalies = checkPriorPeriod(batch.lines, priorPeriod);
  const vatRuleAnomalies = runVatRules(batch.lines, taxonomy);

  const anomalies = [...missing, ...priorPeriodAnomalies, ...vatRuleAnomalies];
  const blocking = anomalies.filter((a) => a.severity === "Blocking");
  const ok = tail.length === 0 && anomalies.length === 0;

  return { ok, tail, anomalies, blocking, threshold: THRESHOLD, total: batch.lines.length };
}
