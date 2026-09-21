// backend/seed.mjs — demo fixtures for the pre-filing validation flow.
// Modeled on the brief's own "THE DEMO · DATASET" slide: one client, one
// quarter — master data, chart of accounts + VAT codes (the rate<->category
// table), invoices with the three seeded anomalies, and the prior period for
// consistency checks.
// Real taxpayer data isn't public (the brief says so explicitly) — this is
// synthetic data built on the real official rules (DPR 633/1972 Table A rates,
// the real Partita IVA check-digit algorithm), not a real client's numbers.
// >>> TODO (real): once the studio can share one real, anonymized period +
//     their actual chart of accounts, this whole file gets replaced by that —
//     not extended further.

// ---- Master data ------------------------------------------------------
export const period = "2026-Q3";
export const client = {
  id: "rossi_srl",
  name: "Rossi Srl",
  regime: "ordinaria",
  piva: "12345678903",       // valid check digit — computed, not guessed
  codiceFiscale: "12345678903",
  ateco: "46.90.00",         // non-specialised wholesale trade
  hasAmministrativo: true,
};

// ---- Chart of accounts + VAT codes -------------------------------------
// `rate` is the client's own signed-off taxonomy (Rulebook Section 6.2) — the
// reference truth vatRules.mjs checks every line against.
// >>> TODO (real): load this from the client's configuration profile, not here.
export const chartOfAccounts = [
  { code: "60.10", name: "Consulenze e servizi", rate: 22, natura: null },
  { code: "60.20", name: "Utenze", rate: 22, natura: null },
  { code: "30.10", name: "Merci c/acquisti", rate: 22, natura: null },
  { code: "70.05", name: "Cancelleria", rate: 22, natura: null },
  { code: "60.30", name: "Alberghi e ristoranti", rate: 10, natura: null }, // Table A, Part III
];

// ---- The batch as handed over by TeamSystem. confidence < 0.85 => tail. --
// Lines L1-L4 are the original demo fixtures (unchanged, so nothing that
// already depends on their ids/values breaks). L6/L7 are the brief's own two
// seeded test cases that aren't a missing document: a rate/category mismatch
// and an invalid supplier identifier.
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
    // ---- seeded test case: rate/category mismatch (brief's own example) ----
    // Posted at 22%; "Alberghi e ristoranti" expects 10% -> CST-04 anomaly.
    { id: "L6", supplier: "Hotel Milano", desc: "Soggiorno trasferta cliente", net: 300.0, vat: 66.0, account: "60.30", confidence: 0.9 },
    // ---- seeded test case: invalid supplier Partita IVA -> FMT-03 anomaly ----
    { id: "L7", supplier: "Gamma Forniture Srl", desc: "Materiale vario", net: 150.0, vat: 33.0, account: "30.10", confidence: 0.92, piva: "55667788991" },
  ],
  // ---- anomaly: a purchase invoice the ledger expects but does not have ----
  expected: [
    { docType: "invoice", supplier: "Verdi Srl", period, note: "recurring monthly supply, not yet received" },
  ],
};

// The same client's PRIOR period, for the validator's cross-period comparison
// (see validator.mjs's checkPriorPeriod — this is NOT one of the rulebook's
// 21 catalogued rules, tagged PRIOR-PERIOD rather than borrowing an ID that
// means something else). Values are close to the current period on purpose,
// so the demo's recurring suppliers reconcile cleanly; nudge one to see the
// validator flag a real swing.
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
