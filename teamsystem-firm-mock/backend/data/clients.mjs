// backend/data/clients.mjs — the TeamSystem Firm's client book: 10 clients,
// each with master data, a chart of accounts, and one quarter's VAT batch.
// Real taxpayer data isn't public (per the brief) — every P.IVA here is
// synthetic but passes the real Italian check-digit algorithm, computed, not
// guessed. Each client is built to demonstrate ONE specific edge case from
// the Rulebook, not a pile of unrelated problems on top of each other — that
// makes each one legible on its own, and three are deliberately clean
// (a system that only ever finds problems isn't trustworthy either).
//
// `edgeCase` on each client is documentation, not data the system reads —
// it's here so anyone opening this file knows why that client looks the way
// it does, and which Rulebook rule it's there to exercise.

const PERIOD = "2026-Q3";
const PRIOR_PERIOD = "2026-Q2";

export const clients = [
  // ---- 1. Rossi Srl — the original proven client: rate mismatch, missing
  // invoice, bad supplier ID, one tail line. Unchanged from what's already
  // tested end-to-end against the real Fatture in Cloud account. ----
  {
    id: "rossi_srl", name: "Rossi Srl", regime: "ordinaria", sourceFormat: "xml",
    piva: "12345678903", codiceFiscale: "12345678903", ateco: "46.90.00",
    edgeCase: "CST-04 rate/category mismatch, DOC-MISSING, FMT-03 bad supplier P.IVA",
    chartOfAccounts: [
      { code: "60.10", name: "Consulenze e servizi", rate: 22, natura: null },
      { code: "60.20", name: "Utenze", rate: 22, natura: null },
      { code: "30.10", name: "Merci c/acquisti", rate: 22, natura: null },
      { code: "70.05", name: "Cancelleria", rate: 22, natura: null },
      { code: "60.30", name: "Alberghi e ristoranti", rate: 10, natura: null },
    ],
    period: PERIOD,
    lines: [
      { id: "L1", supplier: "Enel Energia", desc: "Utenze elettriche luglio", net: 420.0, vat: 92.4, account: "60.20", confidence: 0.97, date: "2026-07-15" },
      { id: "L2", supplier: "TIM", desc: "Canone connettività", net: 59.0, vat: 12.98, account: "60.20", confidence: 0.96, date: "2026-07-20" },
      { id: "L3", supplier: "Cartoleria Sole", desc: "Materiale ufficio", net: 84.0, vat: 18.48, account: "70.05", confidence: 0.93, date: "2026-07-25" },
      { id: "L4", supplier: "Bianchi Studio", desc: "Prestazione settembre", net: 1000.0, vat: 220.0, account: null, confidence: 0.41, date: "2026-09-01" },
      { id: "L6", supplier: "Hotel Milano", desc: "Soggiorno trasferta cliente", net: 300.0, vat: 66.0, account: "60.30", confidence: 0.9, date: "2026-08-05" },
      { id: "L7", supplier: "Gamma Forniture Srl", desc: "Materiale vario", net: 150.0, vat: 33.0, account: "30.10", confidence: 0.92, piva: "55667788991", date: "2026-08-10" },
    ],
    expected: [{ docType: "invoice", supplier: "Verdi Srl", period: PERIOD, note: "recurring monthly supply, not yet received" }],
    priorPeriod: PRIOR_PERIOD,
    priorLines: [
      { supplier: "Enel Energia", net: 400.0, vat: 88.0 },
      { supplier: "TIM", net: 59.0, vat: 12.98 },
      { supplier: "Cartoleria Sole", net: 80.0, vat: 17.6 },
    ],
  },

  // ---- 2. Verdi Costruzioni Srl — reverse charge, done RIGHT (positive case). ----
  {
    id: "verdi_costruzioni", name: "Verdi Costruzioni Srl", regime: "ordinaria", sourceFormat: "json",
    attachments: [{ docId: "contract-ref-L1", kind: "contract_reference", lineId: "L1", filename: "contract-ref-L1.pdf" }],
    piva: "20000000016", codiceFiscale: "20000000016", ateco: "41.20.00",
    edgeCase: "Reverse charge (art. 17) on a construction subcontract — should PASS cleanly (CST-03/SEM-01 positive case)",
    chartOfAccounts: [
      { code: "40.10", name: "Subappalti edilizia (reverse charge)", rate: 0, natura: "N6.7" },
      { code: "60.10", name: "Consulenze e servizi", rate: 22, natura: null },
    ],
    period: PERIOD,
    lines: [
      { id: "L1", supplier: "Subappalto Edile Napoli Srl", desc: "Lavori di subappalto — ristrutturazione", net: 5000.0, vat: 0, natura: "N6.7", account: "40.10", confidence: 0.95, date: "2026-08-12", legalWording: "Inversione contabile", requiresEvidence: true, evidenceAttached: true },
    ],
    expected: [],
  },

  // ---- 3. Bianchi Export Srl — export sale, valid Natura, but missing the
  // customs/transport evidence the rulebook requires for it (CON-02 gap). ----
  {
    id: "bianchi_export", name: "Bianchi Export Srl", regime: "ordinaria", sourceFormat: "json",
    piva: "21000000014", codiceFiscale: "21000000014", ateco: "46.19.00",
    edgeCase: "CON-02: export sale (N3.1) with no customs/transport evidence attached",
    chartOfAccounts: [
      { code: "10.10", name: "Vendite export (extra-UE)", rate: 0, natura: "N3.1" },
      { code: "30.10", name: "Merci c/acquisti", rate: 22, natura: null },
    ],
    period: PERIOD,
    lines: [
      { id: "L1", supplier: "Cliente USA Inc.", desc: "Fornitura macchinari — export extra-UE", net: 8000.0, vat: 0, natura: "N3.1", account: "10.10", confidence: 0.9, date: "2026-08-01", requiresEvidence: true, evidenceAttached: false },
    ],
    expected: [],
  },

  // ---- 4. Ferrari Forfettario — flat-rate regime, done right (positive case). ----
  {
    id: "ferrari_forfettario", name: "Ferrari Forfettario", regime: "forfettario", sourceFormat: "json",
    piva: "22000000012", codiceFiscale: "22000000012", ateco: "74.10.00",
    edgeCase: "Regime forfettario (L. 190/2014) — N2.2 towards an Italian customer — should PASS (positive case)",
    chartOfAccounts: [
      { code: "60.10", name: "Consulenze e servizi (forfettario)", rate: 0, natura: "N2.2" },
    ],
    period: PERIOD,
    lines: [
      { id: "L1", supplier: "Studio Grafico Ferrari", desc: "Servizio di design — regime forfettario", net: 1200.0, vat: 0, natura: "N2.2", account: "60.10", confidence: 0.95, date: "2026-07-30" },
    ],
    expected: [],
  },

  // ---- 5. Colombo Gruppo IVA Srl — a VAT Group member invoiced under the
  // GROUP's Codice Fiscale instead of its own (SdI error 00327 territory). ----
  {
    id: "colombo_gruppo", name: "Colombo Gruppo IVA Srl", regime: "ordinaria", sourceFormat: "json",
    piva: "23000000010", codiceFiscale: "23000000010", ateco: "64.20.00",
    vatGroup: { isMember: true, groupCf: "23000000010", memberCf: "23000000192" },
    edgeCase: "VAT Group (art. 70-ter): invoice wrongly carries the Group CF instead of this member's own CF — SdI 00327",
    chartOfAccounts: [
      { code: "60.10", name: "Consulenze e servizi", rate: 22, natura: null },
    ],
    period: PERIOD,
    lines: [
      { id: "L1", supplier: "Consulenza Holding Spa", desc: "Servizi di consulenza direzionale", net: 3000.0, vat: 660.0, account: "60.10", confidence: 0.93, date: "2026-08-15", counterpartyCfUsed: "23000000010" },
    ],
    expected: [],
  },

  // ---- 6. Russo Ritardatario Srl — temporal coherence broken: the supply
  // happened AFTER the invoice was dated (CST-07). ----
  {
    id: "russo_ritardatario", name: "Russo Ritardatario Srl", regime: "ordinaria", sourceFormat: "json",
    piva: "24000000018", codiceFiscale: "24000000018", ateco: "47.11.00",
    edgeCase: "CST-07: temporal coherence — supply date is AFTER the invoice date",
    chartOfAccounts: [
      { code: "30.10", name: "Merci c/acquisti", rate: 22, natura: null },
    ],
    period: PERIOD,
    lines: [
      { id: "L1", supplier: "Distributore Alimentare Srl", desc: "Fornitura merci settimanale", net: 650.0, vat: 143.0, account: "30.10", confidence: 0.94, invoiceDate: "2026-08-10", supplyDate: "2026-08-18" },
    ],
    expected: [],
    priorPeriod: PRIOR_PERIOD,
    priorLines: [{ supplier: "Distributore Alimentare Srl", net: 600.0, vat: 132.0 }],
  },

  // ---- 7. Romano Duplicato Srl — two lines sharing the same line number
  // within the same document (cardinality / uniqueness). ----
  {
    id: "romano_duplicato", name: "Romano Duplicato Srl", regime: "ordinaria", sourceFormat: "json",
    piva: "25000000015", codiceFiscale: "25000000015", ateco: "47.19.00",
    edgeCase: "STR: duplicate line number within one document — each line must be uniquely numbered",
    chartOfAccounts: [
      { code: "30.10", name: "Merci c/acquisti", rate: 22, natura: null },
    ],
    period: PERIOD,
    lines: [
      { id: "L1", supplier: "Grossista Milano Srl", desc: "Articolo A", net: 200.0, vat: 44.0, account: "30.10", confidence: 0.96, date: "2026-08-05", docNumber: "FT-2026-0451", lineNumber: 1 },
      { id: "L2", supplier: "Grossista Milano Srl", desc: "Articolo B", net: 150.0, vat: 33.0, account: "30.10", confidence: 0.96, date: "2026-08-05", docNumber: "FT-2026-0451", lineNumber: 1 },
    ],
    expected: [],
  },

  // ---- 8. Marino Incompleto Srl — a mandatory field is simply missing (no
  // supply date at all) — CON-01. ----
  {
    id: "marino_incompleto", name: "Marino Incompleto Srl", regime: "ordinaria", sourceFormat: "csv",
    piva: "26000000013", codiceFiscale: "26000000013", ateco: "62.01.00",
    edgeCase: "CON-01: a mandatory field (the supply/invoice date) is missing entirely",
    chartOfAccounts: [
      { code: "60.10", name: "Consulenze e servizi", rate: 22, natura: null },
    ],
    period: PERIOD,
    lines: [
      { id: "L1", supplier: "Sviluppo Software Srl", desc: "Sviluppo applicativo gestionale", net: 4500.0, vat: 990.0, account: "60.10", confidence: 0.9, date: null },
    ],
    expected: [],
  },

  // ---- 9. Gallo Esente Srl — exempt operation, done right (positive case). ----
  {
    id: "gallo_esente", name: "Gallo Esente Srl", regime: "ordinaria", sourceFormat: "json",
    piva: "27000000011", codiceFiscale: "27000000011", ateco: "85.59.00",
    edgeCase: "Exempt operation (art. 10 DPR 633/1972) — N4 — should PASS (positive case)",
    chartOfAccounts: [
      { code: "50.10", name: "Servizi formativi (esenti)", rate: 0, natura: "N4" },
    ],
    period: PERIOD,
    lines: [
      { id: "L1", supplier: "Ente Formazione Professionale", desc: "Corso di formazione professionale esente", net: 2000.0, vat: 0, natura: "N4", account: "50.10", confidence: 0.95, date: "2026-08-20" },
    ],
    expected: [],
  },

  // ---- 10. Conti SplitPayment SpA — split payment (art. 17-ter) missing its
  // mandatory legal wording (CON-03). ----
  {
    id: "conti_splitpayment", name: "Conti SplitPayment SpA", regime: "ordinaria", sourceFormat: "json",
    piva: "28000000019", codiceFiscale: "28000000019", ateco: "84.11.00",
    edgeCase: "CON-03: split-payment invoice missing the mandatory \"Scissione dei pagamenti\" wording",
    chartOfAccounts: [
      { code: "30.10", name: "Merci c/acquisti", rate: 22, natura: null },
    ],
    period: PERIOD,
    lines: [
      { id: "L1", supplier: "Fornitore PA Srl", desc: "Fornitura per ente pubblico", net: 10000.0, vat: 2200.0, account: "30.10", confidence: 0.92, date: "2026-08-22", splitPayment: true, legalWording: null },
    ],
    expected: [],
  },
];

export function getClient(id) { return clients.find((c) => c.id === id); }
export function listClients() {
  return clients.map((c) => ({ id: c.id, name: c.name, regime: c.regime, ateco: c.ateco, piva: c.piva, period: c.period, lineCount: c.lines.length }));
}
