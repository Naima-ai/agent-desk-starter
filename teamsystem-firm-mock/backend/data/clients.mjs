// backend/data/clients.mjs — the TeamSystem Firm's client book: 20 clients,
// each with master data, a chart of accounts, and one quarter's VAT batch.
// Real taxpayer data isn't public (per the brief) — every P.IVA here is
// synthetic but passes the real Italian check-digit algorithm, computed, not
// guessed. Each client is built to demonstrate ONE specific edge case from
// the Rulebook, not a pile of unrelated problems on top of each other — that
// makes each one legible on its own. Four are deliberately clean positive
// cases (a system that only ever finds problems isn't trustworthy either).
//
// Clients 12-20 close the coverage gaps of the first eleven: one per
// remaining validator rule (CST-02, SEM-02, CST-03, SEM-01, STR-01,
// PRIOR-PERIOD, FMT-01), a LEARNING client (low-confidence lines that a human
// confirms once and Il Classificatore remembers) and a MESSY client (several
// different problems in one quarter).
//
// `edgeCase` on each client is documentation, not data the system reads —
// it's here so anyone opening this file knows why that client looks the way
// it does, and which Rulebook rule it's there to exercise.

import { odooItalianChart } from "./odooItalianChart.mjs";

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

  // ---- 11. Azienda Generale Srl — a realistic, full-size book: the real
  // 189-account Italian chart from Odoo's l10n_it localization (see
  // odooItalianChart.mjs), not a 1–5 account chart built around one rule.
  // Clean on purpose: it's here to stress-test the validator and classifier
  // against a real business's chart, so a correct run should PASS. ----
  {
    id: "azienda_generale", name: "Azienda Generale Srl", regime: "ordinaria", sourceFormat: "json",
    piva: "07890123453", codiceFiscale: "07890123453", ateco: "46.69.99",
    edgeCase: "Realistic full chart (189 real Odoo l10n_it accounts) — mixed 22% and N4-exempt costs — should PASS (scale/positive case)",
    chartOfAccounts: odooItalianChart,
    period: PERIOD,
    lines: [
      { id: "L1", supplier: "Grossista Lombardo Srl", desc: "Acquisto merce per rivendita", net: 6400.0, vat: 1408.0, account: "4101", confidence: 0.95, date: "2026-07-08" },
      { id: "L2", supplier: "Enel Energia", desc: "Fornitura energia elettrica luglio", net: 780.0, vat: 171.6, account: "4202", confidence: 0.97, date: "2026-07-31" },
      { id: "L3", supplier: "Vodafone Italia", desc: "Telefonia mobile aziendale", net: 145.0, vat: 31.9, account: "4206", confidence: 0.96, date: "2026-08-03" },
      { id: "L4", supplier: "Studio Commerciale Neri", desc: "Consulenza fiscale trimestrale", net: 1800.0, vat: 396.0, account: "4204", confidence: 0.94, date: "2026-08-10" },
      { id: "L5", supplier: "Generali Italia SpA", desc: "Polizza RC aziendale — rata semestrale", net: 1250.0, vat: 0, natura: "N4", account: "4207", confidence: 0.93, date: "2026-08-14" },
      { id: "L6", supplier: "Immobiliare Duomo Srl", desc: "Canone locazione magazzino agosto", net: 2200.0, vat: 0, natura: "N4", account: "4301", confidence: 0.92, date: "2026-08-01" },
      { id: "L7", supplier: "Officina Bassi Snc", desc: "Manutenzione furgone aziendale", net: 520.0, vat: 114.4, account: "4211", confidence: 0.91, date: "2026-09-04" },
      { id: "L8", supplier: "Autonoleggi Nord SpA", desc: "Canone leasing automezzo settembre", net: 690.0, vat: 151.8, account: "4302", confidence: 0.95, date: "2026-09-10" },
    ],
    expected: [],
    priorPeriod: PRIOR_PERIOD,
    priorLines: [
      { supplier: "Grossista Lombardo Srl", net: 6100.0, vat: 1342.0 },
      { supplier: "Enel Energia", net: 820.0, vat: 180.4 },
      { supplier: "Vodafone Italia", net: 145.0, vat: 31.9 },
    ],
  },

  // ---- 12. Bruni Aritmetica Srl ----
  {
    id: "bruni_aritmetica", name: "Bruni Aritmetica Srl", regime: "ordinaria", sourceFormat: "json",
    piva: "29000000017", codiceFiscale: "29000000017", ateco: "46.90.00",
    edgeCase: "CST-02: arithmetic — the VAT amount does not equal net x rate (net 1,000.00, 22% category, VAT 215.00 instead of 220.00). The implied rate (21.5%) is still within half a point of 22%, so ONLY this rule fires.",
    chartOfAccounts: [
      { code: "60.10", name: "Consulenze e servizi", rate: 22, natura: null },
      { code: "30.10", name: "Merci c/acquisti", rate: 22, natura: null },
    ],
    period: PERIOD,
    lines: [
      { id: "L1", supplier: "Fornitore Alfa Srl", desc: "Fornitura merci", net: 800.0, vat: 176.0, account: "30.10", confidence: 0.95, date: "2026-07-14" },
      { id: "L2", supplier: "Studio Beta Associati", desc: "Consulenza organizzativa", net: 1000.0, vat: 215.0, account: "60.10", confidence: 0.94, date: "2026-08-02" },
    ],
    expected: [],
    priorPeriod: PRIOR_PERIOD,
    priorLines: [
      { supplier: "Fornitore Alfa Srl", net: 780.0, vat: 171.6 },
      { supplier: "Studio Beta Associati", net: 990.0, vat: 217.8 },
    ],
  },

  // ---- 13. Fontana Aliquota Srl ----
  {
    id: "fontana_aliquota", name: "Fontana Aliquota Srl", regime: "ordinaria", sourceFormat: "json",
    piva: "30000000015", codiceFiscale: "30000000015", ateco: "47.19.00",
    edgeCase: "SEM-02: a VAT rate that does not exist in Italy (21%; admissible rates are 0/4/5/10/22). The same wrong amount also trips CST-02 (arithmetic) and CST-04 (category expects 22%), which is realistic: one typo, three symptoms.",
    chartOfAccounts: [
      { code: "60.10", name: "Consulenze e servizi", rate: 22, natura: null },
      { code: "30.10", name: "Merci c/acquisti", rate: 22, natura: null },
    ],
    period: PERIOD,
    lines: [
      { id: "L1", supplier: "Ingrosso Delta Srl", desc: "Fornitura merci", net: 1200.0, vat: 264.0, account: "30.10", confidence: 0.95, date: "2026-07-09" },
      { id: "L2", supplier: "Servizi Epsilon Srl", desc: "Consulenza commerciale", net: 1000.0, vat: 210.0, account: "60.10", confidence: 0.93, date: "2026-08-21" },
    ],
    expected: [],
    priorPeriod: PRIOR_PERIOD,
    priorLines: [
      { supplier: "Ingrosso Delta Srl", net: 1150.0, vat: 253.0 },
      { supplier: "Servizi Epsilon Srl", net: 1000.0, vat: 220.0 },
    ],
  },

  // ---- 14. Moretti Natura Srl ----
  {
    id: "moretti_natura", name: "Moretti Natura Srl", regime: "ordinaria", sourceFormat: "json",
    piva: "31000000013", codiceFiscale: "31000000013", ateco: "86.90.00",
    edgeCase: "CST-03: rate and Natura are mutually exclusive — one line is 0% with NO Natura code (natura_missing), another is taxed at 22% yet carries Natura N4 (natura_with_rate).",
    chartOfAccounts: [
      { code: "60.10", name: "Consulenze e servizi", rate: 22, natura: null },
      { code: "50.10", name: "Prestazioni sanitarie esenti", rate: 0, natura: "N4" },
    ],
    period: PERIOD,
    lines: [
      { id: "L1", supplier: "Studio Gamma Srl", desc: "Consulenza amministrativa", net: 900.0, vat: 198.0, account: "60.10", confidence: 0.95, date: "2026-07-18" },
      { id: "L2", supplier: "Poliambulatorio Salute", desc: "Visite mediche del personale", net: 800.0, vat: 0, account: "50.10", confidence: 0.93, date: "2026-08-05" },
      { id: "L3", supplier: "Consulenti Zeta Srl", desc: "Consulenza contrattuale", net: 500.0, vat: 110.0, natura: "N4", account: "60.10", confidence: 0.92, date: "2026-08-27" },
    ],
    expected: [],
    priorPeriod: PRIOR_PERIOD,
    priorLines: [
      { supplier: "Studio Gamma Srl", net: 880.0, vat: 193.6 },
      { supplier: "Poliambulatorio Salute", net: 800.0, vat: 0.0 },
    ],
  },

  // ---- 15. Ricci Codici Natura Srl ----
  {
    id: "ricci_codici_natura", name: "Ricci Codici Natura Srl", regime: "ordinaria", sourceFormat: "json",
    piva: "32000000011", codiceFiscale: "32000000011", ateco: "41.20.00",
    edgeCase: "SEM-01: Natura codes that are not admissible — N9 does not exist (natura_invalid) and a bare N6 lacks its mandatory sub-code (natura_missing_subcode). The reverse-charge wording is present, so CON-03 stays quiet.",
    chartOfAccounts: [
      { code: "60.10", name: "Consulenze e servizi", rate: 22, natura: null },
      { code: "40.20", name: "Subappalti (inversione contabile)", rate: 0, natura: "N6.7" },
    ],
    period: PERIOD,
    lines: [
      { id: "L1", supplier: "Progetti Eta Srl", desc: "Progettazione impianti", net: 1500.0, vat: 330.0, account: "60.10", confidence: 0.95, date: "2026-07-11" },
      { id: "L2", supplier: "Edilizia Theta Srl", desc: "Subappalto opere murarie", net: 700.0, vat: 0, natura: "N9", account: "40.20", confidence: 0.93, date: "2026-08-04" },
      { id: "L3", supplier: "Impianti Iota Srl", desc: "Subappalto impianti elettrici", net: 1500.0, vat: 0, natura: "N6", legalWording: "Inversione contabile", account: "40.20", confidence: 0.92, date: "2026-09-02" },
    ],
    expected: [],
    priorPeriod: PRIOR_PERIOD,
    priorLines: [
      { supplier: "Progetti Eta Srl", net: 1450.0, vat: 319.0 },
    ],
  },

  // ---- 16. Greco Tipo Documento Srl ----
  {
    id: "greco_tipo_documento", name: "Greco Tipo Documento Srl", regime: "ordinaria", sourceFormat: "json",
    piva: "33000000019", codiceFiscale: "33000000019", ateco: "62.01.00",
    edgeCase: "STR-01: the document type must be a recognised FatturaPA type (TD01-TD29) — one line is TD01 (fine), the other TD99 (not a real type).",
    chartOfAccounts: [
      { code: "60.10", name: "Consulenze e servizi", rate: 22, natura: null },
    ],
    period: PERIOD,
    lines: [
      { id: "L1", supplier: "Software Kappa Srl", desc: "Licenze software", net: 1100.0, vat: 242.0, account: "60.10", confidence: 0.95, docType: "TD01", date: "2026-07-22" },
      { id: "L2", supplier: "Cloud Lambda Srl", desc: "Servizi cloud trimestrali", net: 640.0, vat: 140.8, account: "60.10", confidence: 0.94, docType: "TD99", date: "2026-08-14" },
    ],
    expected: [],
    priorPeriod: PRIOR_PERIOD,
    priorLines: [
      { supplier: "Software Kappa Srl", net: 1100.0, vat: 242.0 },
      { supplier: "Cloud Lambda Srl", net: 620.0, vat: 136.4 },
    ],
  },

  // ---- 17. Conte Variazione Srl ----
  {
    id: "conte_variazione", name: "Conte Variazione Srl", regime: "ordinaria", sourceFormat: "json",
    piva: "34000000017", codiceFiscale: "34000000017", ateco: "46.90.00",
    edgeCase: "PRIOR-PERIOD: a recurring supplier whose amount jumps 400% against last quarter (EUR 3,000 vs EUR 600) — every line is individually correct; only the comparison with the past gives it away.",
    chartOfAccounts: [
      { code: "30.10", name: "Merci c/acquisti", rate: 22, natura: null },
      { code: "60.20", name: "Utenze", rate: 22, natura: null },
    ],
    period: PERIOD,
    lines: [
      { id: "L1", supplier: "Energia Mu Spa", desc: "Utenze elettriche", net: 410.0, vat: 90.2, account: "60.20", confidence: 0.97, date: "2026-07-30" },
      { id: "L2", supplier: "Fornitore Costante Srl", desc: "Fornitura mensile merci", net: 3000.0, vat: 660.0, account: "30.10", confidence: 0.95, date: "2026-08-12" },
    ],
    expected: [],
    priorPeriod: PRIOR_PERIOD,
    priorLines: [
      { supplier: "Energia Mu Spa", net: 400.0, vat: 88.0 },
      { supplier: "Fornitore Costante Srl", net: 600.0, vat: 132.0 },
    ],
  },

  // ---- 18. Barbieri Feed Corrotto Srl ----
  {
    id: "barbieri_feed_corrotto", name: "Barbieri Feed Corrotto Srl", regime: "ordinaria", sourceFormat: "json",
    piva: "35000000014", codiceFiscale: "35000000014", ateco: "47.11.00",
    corruptFeed: true,
    edgeCase: "FMT-01: the raw feed arrives truncated and cannot be parsed. The data itself is clean — Agent Desk has to report the broken file as a Blocking finding instead of crashing or silently using nothing.",
    chartOfAccounts: [
      { code: "30.10", name: "Merci c/acquisti", rate: 22, natura: null },
    ],
    period: PERIOD,
    lines: [
      { id: "L1", supplier: "Grossista Ni Srl", desc: "Fornitura merci", net: 900.0, vat: 198.0, account: "30.10", confidence: 0.96, date: "2026-07-16" },
      { id: "L2", supplier: "Distribuzione Xi Srl", desc: "Fornitura merci", net: 450.0, vat: 99.0, account: "30.10", confidence: 0.95, date: "2026-08-19" },
    ],
    expected: [],
    priorPeriod: PRIOR_PERIOD,
    priorLines: [
      { supplier: "Grossista Ni Srl", net: 880.0, vat: 193.6 },
    ],
  },

  // ---- 19. Lombardi Apprendimento Srl ----
  {
    id: "lombardi_apprendimento", name: "Lombardi Apprendimento Srl", regime: "ordinaria", sourceFormat: "json",
    piva: "36000000012", codiceFiscale: "36000000012", ateco: "82.99.99",
    edgeCase: "LEARNING: five vaguely described lines from recurring suppliers and a chart with none of the codes the offline fallback knows, so each one goes to a human (low confidence). Confirm them once; on the NEXT run Il Classificatore resolves them from memory and the low-confidence tail drops to zero. (A confident local model may auto-classify some on the first run.)",
    chartOfAccounts: [
      { code: "61.00", name: "Costi generali di gestione", rate: 22, natura: null },
      { code: "61.10", name: "Servizi professionali", rate: 22, natura: null },
      { code: "62.00", name: "Acquisti di materiali", rate: 22, natura: null },
      { code: "63.00", name: "Spese di rappresentanza", rate: 22, natura: null },
    ],
    period: PERIOD,
    lines: [
      { id: "L1", supplier: "Servizi Integrati Lombardi Srl", desc: "Servizio mensile", net: 450.0, vat: 99.0, account: null, confidence: 0.48, date: "2026-07-31" },
      { id: "L2", supplier: "Pulizie Duomo Snc", desc: "Pulizia uffici ottobre", net: 320.0, vat: 70.4, account: null, confidence: 0.52, date: "2026-08-31" },
      { id: "L3", supplier: "NetSupport Srl", desc: "Assistenza tecnica", net: 680.0, vat: 149.6, account: null, confidence: 0.45, date: "2026-09-05" },
      { id: "L4", supplier: "Tipografia Milano", desc: "Fornitura stampati", net: 210.0, vat: 46.2, account: null, confidence: 0.55, date: "2026-09-12" },
      { id: "L5", supplier: "Abbonamenti Pro Spa", desc: "Canone annuale", net: 540.0, vat: 118.8, account: null, confidence: 0.5, date: "2026-09-20" },
    ],
    expected: [],
    priorPeriod: PRIOR_PERIOD,
    priorLines: [
      { supplier: "Servizi Integrati Lombardi Srl", net: 440.0, vat: 96.8 },
      { supplier: "Pulizie Duomo Snc", net: 310.0, vat: 68.2 },
      { supplier: "NetSupport Srl", net: 660.0, vat: 145.2 },
      { supplier: "Tipografia Milano", net: 200.0, vat: 44.0 },
      { supplier: "Abbonamenti Pro Spa", net: 540.0, vat: 118.8 },
    ],
  },

  // ---- 20. Esposito Misto Srl ----
  {
    id: "esposito_misto", name: "Esposito Misto Srl", regime: "ordinaria", sourceFormat: "json",
    piva: "37000000010", codiceFiscale: "37000000010", ateco: "46.69.99",
    edgeCase: "MESSY: a realistic bad quarter with six different problems at once — wrong hotel rate (CST-04), a 10-digit supplier P.IVA (FMT-03), a 400%+ jump (PRIOR-PERIOD), a missing date (CON-01), supply after invoice (CST-07), a missing expected invoice (DOC-MISSING) — plus one unclassified line. Tests ordering by severity and how many tasks and requests TeamSystem opens.",
    chartOfAccounts: [
      { code: "60.10", name: "Consulenze e servizi", rate: 22, natura: null },
      { code: "60.20", name: "Utenze", rate: 22, natura: null },
      { code: "30.10", name: "Merci c/acquisti", rate: 22, natura: null },
      { code: "60.30", name: "Alberghi e ristoranti", rate: 10, natura: null },
    ],
    period: PERIOD,
    lines: [
      { id: "L1", supplier: "Enel Energia", desc: "Utenze elettriche", net: 500.0, vat: 110.0, account: "60.20", confidence: 0.97, date: "2026-07-15" },
      { id: "L2", supplier: "Hotel Aurora", desc: "Soggiorno trasferta cliente", net: 600.0, vat: 132.0, account: "60.30", confidence: 0.92, date: "2026-08-03" },
      { id: "L3", supplier: "Gamma Sud Srl", desc: "Materiale vario", net: 900.0, vat: 198.0, account: "30.10", confidence: 0.93, piva: "1234567890", date: "2026-08-08" },
      { id: "L4", supplier: "Studio Verde", desc: "Consulenza strategica", net: 5000.0, vat: 1100.0, account: "60.10", confidence: 0.94, date: "2026-08-20" },
      { id: "L5", supplier: "Logistica Rapida Srl", desc: "Servizio di trasporto", net: 300.0, vat: 66.0, account: "60.10", confidence: 0.9, date: null },
      { id: "L6", supplier: "Officina Nord Snc", desc: "Manutenzione impianti", net: 210.0, vat: 46.2, account: "30.10", confidence: 0.91, invoiceDate: "2026-08-05", supplyDate: "2026-08-12" },
      { id: "L7", supplier: "Servizi Vari Srl", desc: "Prestazione varia", net: 400.0, vat: 88.0, account: null, confidence: 0.5, date: "2026-09-01" },
    ],
    expected: [{ docType: "invoice", supplier: "Telecom Nord", period: PERIOD, note: "recurring monthly supply, not yet received" }],
    priorPeriod: PRIOR_PERIOD,
    priorLines: [
      { supplier: "Enel Energia", net: 480.0, vat: 105.6 },
      { supplier: "Hotel Aurora", net: 580.0, vat: 127.6 },
      { supplier: "Studio Verde", net: 900.0, vat: 198.0 },
    ],
  },
];

// Contact address for studio <-> client email (the reserved .example TLD can never be a real mailbox).
for (const c of clients) c.email ??= `amministrazione@${c.id.replace(/_/g, "-")}.example`;

export function getClient(id) { return clients.find((c) => c.id === id); }
export function getClientByEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  const emailOf = (c) => (c.email || `amministrazione@${c.id.replace(/_/g, "-")}.example`).toLowerCase(); // custom clients saved before this field existed
  return e ? clients.find((c) => emailOf(c) === e) : undefined;
}
// Digits only, so "+39 333 1234567", "+393331234567" and "0039..." all
// compare equal regardless of how the phone was originally typed in.
function digitsOf(phone) { return String(phone || "").replace(/[^\d]/g, ""); }
export function getClientByPhone(phone) {
  const p = digitsOf(phone);
  // Unlike email, there is no synthesized default — most fixture clients have
  // no phone on file until one is set via updateClientContact (the "save to
  // client" checkbox on the WhatsApp contact form) or at client creation.
  return p ? clients.find((c) => c.phone && digitsOf(c.phone) === p) : undefined;
}
export function listClients() {
  return clients.map((c) => ({ id: c.id, name: c.name, regime: c.regime, ateco: c.ateco, piva: c.piva, period: c.period, lineCount: c.lines.length, email: c.email, phone: c.phone }));
}
