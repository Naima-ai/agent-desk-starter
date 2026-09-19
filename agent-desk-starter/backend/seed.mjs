// backend/seed.mjs — demo fixtures for the pre-filing validation flow.
// A periodic VAT batch that TeamSystem has compiled from the ledger. Most lines
// are high-confidence; a short low-confidence TAIL needs Il Classificatore; one
// ANOMALY (a missing purchase invoice) needs the client loop.
//
// `rate` on each category is the client's own signed-off taxonomy (Rulebook
// Section 6.2) — the reference truth vatRules.mjs checks every line against.
// >>> TODO (real): load this from the client's configuration profile, not here.
export const chartOfAccounts = [
  { code: "60.10", name: "Consulenze e servizi", rate: 22, natura: null },
  { code: "60.20", name: "Utenze", rate: 22, natura: null },
  { code: "30.10", name: "Merci c/acquisti", rate: 22, natura: null },
  { code: "70.05", name: "Cancelleria", rate: 22, natura: null },
];

export const period = "2026-Q3";
export const client = { id: "rossi_srl", name: "Rossi Srl", regime: "ordinaria", hasAmministrativo: true };

// The batch as handed over by TeamSystem. confidence < 0.85 => tail.
export const vatBatch = {
  period,
  client: client.id,
  kind: "LIPE",
  lines: [
    { id: "L1", supplier: "Enel Energia",   desc: "Utenze elettriche luglio", net: 420.0,  vat: 92.4,  account: "60.20", confidence: 0.97 },
    { id: "L2", supplier: "TIM",             desc: "Canone connettività",       net: 59.0,   vat: 12.98, account: "60.20", confidence: 0.96 },
    { id: "L3", supplier: "Cartoleria Sole", desc: "Materiale ufficio",         net: 84.0,   vat: 18.48, account: "70.05", confidence: 0.93 },
    // ---- low-confidence tail (new supplier, ambiguous description) ----
    { id: "L4", supplier: "Bianchi Studio",  desc: "Prestazione settembre",     net: 1000.0, vat: 220.0, account: null,    confidence: 0.41 },
  ],
  // ---- anomaly: a purchase invoice the ledger expects but does not have ----
  expected: [
    { docType: "invoice", supplier: "Verdi Srl", period, note: "recurring monthly supply, not yet received" },
  ],
};

// The same client's PRIOR period, for the validator's prior-period comparison
// (Rulebook CST-05 — cross-period reconciliation). Values are close to the
// current period on purpose, so the demo's recurring suppliers reconcile
// cleanly; nudge one to see the validator flag a real swing.
export const priorPeriodBatch = {
  period: "2026-Q2",
  client: client.id,
  kind: "LIPE",
  lines: [
    { id: "P1", supplier: "Enel Energia", desc: "Utenze elettriche aprile", net: 400.0, vat: 88.0 },
    { id: "P2", supplier: "TIM", desc: "Canone connettività", net: 59.0, vat: 12.98 },
    { id: "P3", supplier: "Cartoleria Sole", desc: "Materiale ufficio", net: 80.0, vat: 17.6 },
  ],
};
