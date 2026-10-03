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

  // ---- 11. Azienda Generale Srl — a broad, realistic client for general
  // system testing, not one specific Rulebook edge case. Its chart of
  // accounts is the REAL Italian piano dei conti (189 accounts), imported
  // from Odoo's own l10n_it localization module
  // (github.com/odoo/odoo/blob/master/addons/l10n_it/data/template/account.account-it.csv) —
  // real account codes and real Italian names, not invented. Per-account VAT
  // treatment isn't in that source data (it's a transaction-computation model,
  // not a per-account table), so it is assigned here by account type and name,
  // following normal Italian practice: standard 22% for ordinary purchases,
  // sales and fixed assets; 0% with Natura N4 (exempt, art. 10) for insurance,
  // bank charges, interest, rents and buildings; 0% with Natura N2.2 (outside
  // the scope of VAT) for payroll, depreciation, provisions, taxes and
  // write-offs; and null ("n/a") for balance-sheet and closing accounts, where
  // VAT does not apply. Reviewable defaults, not tax advice. Lines are posted
  // against real expense accounts from that chart, clean (no injected
  // anomaly) — this client exists to prove the system handles a large,
  // realistic chart smoothly, not to demonstrate one specific defect. ----
  {
    id: 'azienda_generale', name: 'Azienda Generale Srl', regime: 'ordinaria', sourceFormat: 'json',
    piva: '07890123453', codiceFiscale: '07890123453', ateco: '46.90.00',
    edgeCase: 'Broad realistic test client — real 189-account Italian piano dei conti (Odoo l10n_it), not a scripted edge case.',
    chartOfAccounts: [
      { code: '1101', name: 'Costi di impianto', rate: 22, natura: null },
      { code: '1106', name: 'Software', rate: 22, natura: null },
      { code: '1108', name: 'Avviamento', rate: 22, natura: null },
      { code: '1111', name: 'Fondo ammortamento costi di impianto', rate: null, natura: null },
      { code: '1116', name: 'Fondo ammortamento software', rate: null, natura: null },
      { code: '1118', name: 'Fondo ammortamento avviamento', rate: null, natura: null },
      { code: '1201', name: 'Fabbricati', rate: 0, natura: 'N4' },
      { code: '1202', name: 'Impianti e macchinari', rate: 22, natura: null },
      { code: '1204', name: 'Attrezzature commerciali', rate: 22, natura: null },
      { code: '1205', name: 'Macchine d\'ufficio', rate: 22, natura: null },
      { code: '1206', name: 'Arredamento', rate: 22, natura: null },
      { code: '1207', name: 'Automezzi', rate: 22, natura: null },
      { code: '1208', name: 'Imballaggi durevoli', rate: 22, natura: null },
      { code: '1211', name: 'Fondo ammortamento fabbricati', rate: null, natura: null },
      { code: '1212', name: 'Fondo ammortamento impianti e macchinari', rate: null, natura: null },
      { code: '1214', name: 'Fondo ammortamento attrezzature commerciali', rate: null, natura: null },
      { code: '1215', name: 'Fondo ammortamento macchine d\'ufficio', rate: null, natura: null },
      { code: '1216', name: 'Fondo ammortamento arredamento', rate: null, natura: null },
      { code: '1217', name: 'Fondo ammortamento automezzi', rate: null, natura: null },
      { code: '1218', name: 'Fondo ammortamento imballaggi durevoli', rate: null, natura: null },
      { code: '1220', name: 'Fornitori immobilizzazioni c/acconti', rate: 22, natura: null },
      { code: '1301', name: 'Mutui attivi', rate: null, natura: null },
      { code: '1401', name: 'Materie di consumo', rate: null, natura: null },
      { code: '1404', name: 'Merci', rate: null, natura: null },
      { code: '1410', name: 'Acconti dei fornitori', rate: null, natura: null },
      { code: '1501', name: 'Crediti verso i clienti', rate: null, natura: null },
      { code: '1502', name: 'Crediti commerciali diversi', rate: null, natura: null },
      { code: '1503', name: 'Spese dei clienti in anticipo', rate: null, natura: null },
      { code: '1505', name: 'Cambiali attive', rate: null, natura: null },
      { code: '1506', name: 'Cambiali allo sconto', rate: null, natura: null },
      { code: '1507', name: 'Cambiali all\'incasso', rate: null, natura: null },
      { code: '1508', name: 'Crediti v/clienti (PoS)', rate: null, natura: null },
      { code: '1509', name: 'Fatture da emettere', rate: null, natura: null },
      { code: '1510', name: 'Crediti insoluti', rate: null, natura: null },
      { code: '1511', name: 'Cambiali insolute', rate: null, natura: null },
      { code: '1531', name: 'Crediti da liquidare', rate: null, natura: null },
      { code: '1540', name: 'Fondo svalutazione crediti', rate: null, natura: null },
      { code: '1541', name: 'Fondo rischi su crediti', rate: null, natura: null },
      { code: '1601', name: 'Credito IVA', rate: null, natura: null },
      { code: '1602', name: 'Acconto IVA', rate: null, natura: null },
      { code: '1605', name: 'Crediti per IVA', rate: null, natura: null },
      { code: '1607', name: 'Imposte sull\'acconto', rate: null, natura: null },
      { code: '1608', name: 'Crediti per imposte', rate: null, natura: null },
      { code: '1609', name: 'Crediti per ritenute subite', rate: null, natura: null },
      { code: '1610', name: 'Crediti per cauzioni', rate: null, natura: null },
      { code: '1611', name: 'Crediti per ritenute subite (appoggio)', rate: null, natura: null },
      { code: '1620', name: 'Pagamenti anticipati del personale', rate: null, natura: null },
      { code: '1630', name: 'Crediti dell\'ente previdenziale', rate: null, natura: null },
      { code: '1640', name: 'Debitori diversi', rate: null, natura: null },
      { code: '1901', name: 'Ratei attivi', rate: null, natura: null },
      { code: '1902', name: 'Risconti attivi', rate: null, natura: null },
      { code: '2101', name: 'Patrimonio netto', rate: null, natura: null },
      { code: '2102', name: 'Utile d\'esercizio', rate: null, natura: null },
      { code: '2103', name: 'Perdita d\'esercizio', rate: null, natura: null },
      { code: '2104', name: 'Prelevamenti extra gestione', rate: null, natura: null },
      { code: '2105', name: 'Ritenute del titolare subite', rate: null, natura: null },
      { code: '2201', name: 'Fondo per imposte', rate: null, natura: null },
      { code: '2204', name: 'Fondo responsabilità civile', rate: null, natura: null },
      { code: '2205', name: 'Fondo spese future', rate: null, natura: null },
      { code: '2211', name: 'Fondo manutenzioni programmate', rate: null, natura: null },
      { code: '2301', name: 'Debiti per TFRL', rate: null, natura: null },
      { code: '2410', name: 'Mutui passivi', rate: null, natura: null },
      { code: '2411', name: 'Sovvenzioni delle banche', rate: null, natura: null },
      { code: '2420', name: 'Banche in raccolta', rate: null, natura: null },
      { code: '2421', name: 'Conto RIBA delle banche in raccolta', rate: null, natura: null },
      { code: '2422', name: 'Conti correnti bancari in incasso', rate: null, natura: null },
      { code: '2423', name: 'Anticipi bancari su fatture', rate: null, natura: null },
      { code: '2440', name: 'Debiti verso altri finanziatori', rate: null, natura: null },
      { code: '2501', name: 'Debiti v/fornitori', rate: null, natura: null },
      { code: '2503', name: 'Cambiali passive', rate: null, natura: null },
      { code: '2520', name: 'Fatture da ricevere', rate: null, natura: null },
      { code: '2521', name: 'Debiti da liquidare', rate: null, natura: null },
      { code: '2530', name: 'Acconti dei clienti', rate: null, natura: null },
      { code: '2601', name: 'Debito IVA', rate: null, natura: null },
      { code: '2602', name: 'Debiti per ritenute da versare', rate: null, natura: null },
      { code: '2603', name: 'Debiti per ritenute da versare (appoggio)', rate: null, natura: null },
      { code: '2605', name: 'IVA dovuta al Tesoro', rate: null, natura: null },
      { code: '26051', name: 'Crediti IVA del Tesoro', rate: null, natura: null },
      { code: '2606', name: 'Debiti per imposte', rate: null, natura: null },
      { code: '2607', name: 'Fondi con pagamento diviso IVA dovuta', rate: null, natura: null },
      { code: '26071', name: 'Fondi con pagamento diviso dell\'IVA da ricevere', rate: null, natura: null },
      { code: '2608', name: 'IVA c/Split Payment', rate: null, natura: null },
      { code: '2609', name: 'Debiti per ritenute da versare (Fondo pensione)', rate: null, natura: null },
      { code: '26091', name: 'Crediti per ritenute da versare (Fondo pensione)', rate: null, natura: null },
      { code: '2610', name: 'Debiti per ritenute da versare (Fondo pensione)', rate: null, natura: null },
      { code: '26101', name: 'Crediti per ritenute da versare (Fondo pensione)', rate: null, natura: null },
      { code: '2611', name: 'Debiti per ritenute da versare', rate: null, natura: null },
      { code: '26111', name: 'Crediti per ritenute da versare', rate: null, natura: null },
      { code: '2619', name: 'Debiti per cauzioni', rate: null, natura: null },
      { code: '2620', name: 'Stipendi del personale', rate: null, natura: null },
      { code: '2621', name: 'Liquidazioni del personale', rate: null, natura: null },
      { code: '2622', name: 'Smaltimento dei clienti', rate: null, natura: null },
      { code: '2630', name: 'Debiti previdenziali', rate: null, natura: null },
      { code: '2640', name: 'Creditori diversi', rate: null, natura: null },
      { code: '2701', name: 'Ratei passivi', rate: null, natura: null },
      { code: '2702', name: 'Risconti passivi', rate: null, natura: null },
      { code: '2801', name: 'Bilancio di apertura', rate: null, natura: null },
      { code: '2802', name: 'Bilancio di chiusura', rate: null, natura: null },
      { code: '2810', name: 'Liquidazioni IVA', rate: null, natura: null },
      { code: '2811', name: 'Istituti previdenziali', rate: null, natura: null },
      { code: '2901', name: 'Beni di terzi', rate: null, natura: null },
      { code: '2902', name: 'Depositanti beni', rate: null, natura: null },
      { code: '2911', name: 'Merci da ricevere', rate: null, natura: null },
      { code: '2912', name: 'Impegni dei fornitori', rate: null, natura: null },
      { code: '2913', name: 'Impegni per beni in leasing', rate: null, natura: null },
      { code: '2914', name: 'Creditori di leasing', rate: null, natura: null },
      { code: '2916', name: 'Impegni dei clienti', rate: null, natura: null },
      { code: '2917', name: 'Merci da consegnare', rate: null, natura: null },
      { code: '2921', name: 'Rischi per effetti scontati', rate: null, natura: null },
      { code: '2922', name: 'Banche effetti scontati', rate: null, natura: null },
      { code: '2926', name: 'Rischi per fideiussioni', rate: null, natura: null },
      { code: '2927', name: 'Creditori per fideiussioni', rate: null, natura: null },
      { code: '2931', name: 'Rischi per avalli', rate: null, natura: null },
      { code: '2932', name: 'Creditori per avalli', rate: null, natura: null },
      { code: '3101', name: 'Merci c/vendite', rate: 22, natura: null },
      { code: '3103', name: 'Rimborsi spese di vendita', rate: 22, natura: null },
      { code: '3110', name: 'Resi su vendite', rate: 22, natura: null },
      { code: '3111', name: 'Ribassi e abbuoni passivi', rate: 22, natura: null },
      { code: '3112', name: 'Premi su vendite', rate: 22, natura: null },
      { code: '3201', name: 'Fitti attivi', rate: 0, natura: 'N4' },
      { code: '3202', name: 'Proventi vari', rate: 22, natura: null },
      { code: '3210', name: 'Arrotondamenti attivi', rate: 0, natura: 'N2.2' },
      { code: '3220', name: 'Plusvalenze ordinarie diverse', rate: 0, natura: 'N2.2' },
      { code: '3230', name: 'Sopravvenienze attive ordinarie diverse', rate: 0, natura: 'N2.2' },
      { code: '3240', name: 'Insussistenze attive ordinarie diverse', rate: 0, natura: 'N2.2' },
      { code: '4101', name: 'Merce acquistata', rate: 22, natura: null },
      { code: '4102', name: 'Materiali di consumo acquistati', rate: 22, natura: null },
      { code: '4105', name: 'Contributi per le merci', rate: 0, natura: 'N2.2' },
      { code: '4110', name: 'Resi su acquisti', rate: 22, natura: null },
      { code: '4111', name: 'Ribassi e abbuoni attivi', rate: 22, natura: null },
      { code: '4112', name: 'Premi su acquisti', rate: 22, natura: null },
      { code: '4121', name: 'Esistenze iniziali dei beni', rate: null, natura: null },
      { code: '4122', name: 'Materiali di consumo esistenti', rate: null, natura: null },
      { code: '4131', name: 'Inventario di chiusura merci', rate: null, natura: null },
      { code: '4132', name: 'Rimanenze finali di materiali di consumo', rate: null, natura: null },
      { code: '4201', name: 'Costi di trasporto', rate: 22, natura: null },
      { code: '4202', name: 'Costi per energia', rate: 22, natura: null },
      { code: '4203', name: 'Costi di pubblicità', rate: 22, natura: null },
      { code: '4204', name: 'Costi di consulenze', rate: 22, natura: null },
      { code: '4205', name: 'Costi postali', rate: 22, natura: null },
      { code: '4206', name: 'Costi telefonici', rate: 22, natura: null },
      { code: '4207', name: 'Costi di assicurazione', rate: 0, natura: 'N4' },
      { code: '4208', name: 'Costi di vigilanza', rate: 22, natura: null },
      { code: '4209', name: 'Costi per i locali', rate: 22, natura: null },
      { code: '4210', name: 'Costi di esercizio automezzi', rate: 22, natura: null },
      { code: '4211', name: 'Costi di manutenzione e riparazione', rate: 22, natura: null },
      { code: '4212', name: 'Provvigioni passive', rate: 22, natura: null },
      { code: '4213', name: 'Spese di incasso', rate: 0, natura: 'N4' },
      { code: '4301', name: 'Fitti passivi', rate: 0, natura: 'N4' },
      { code: '4302', name: 'Canoni di leasing', rate: 22, natura: null },
      { code: '4401', name: 'Salari e stipendi', rate: 0, natura: 'N2.2' },
      { code: '4402', name: 'Oneri sociali', rate: 0, natura: 'N2.2' },
      { code: '4403', name: 'TFRL', rate: 0, natura: 'N2.2' },
      { code: '4404', name: 'Altri costi per il personale', rate: 0, natura: 'N2.2' },
      { code: '4501', name: 'Ammortamento costi di impianto', rate: 0, natura: 'N2.2' },
      { code: '4506', name: 'Ammortamento software', rate: 0, natura: 'N2.2' },
      { code: '4508', name: 'Ammortamento avviamento', rate: 0, natura: 'N2.2' },
      { code: '4601', name: 'Ammortamento fabbricati', rate: 0, natura: 'N2.2' },
      { code: '4602', name: 'Ammortamento impianti e macchinari', rate: 0, natura: 'N2.2' },
      { code: '4604', name: 'Ammortamento attrezzature commerciali', rate: 0, natura: 'N2.2' },
      { code: '4605', name: 'Ammortamento macchine d\'ufficio', rate: 0, natura: 'N2.2' },
      { code: '4606', name: 'Ammortamento arredamento', rate: 0, natura: 'N2.2' },
      { code: '4607', name: 'Ammortamento automezzi', rate: 0, natura: 'N2.2' },
      { code: '4608', name: 'Ammortamento imballaggi durevoli', rate: 0, natura: 'N2.2' },
      { code: '4701', name: 'Ammortamento imballaggi durevoli', rate: 0, natura: 'N2.2' },
      { code: '4702', name: 'Svalutazioni immobilizzazioni materiali', rate: 0, natura: 'N2.2' },
      { code: '4706', name: 'Svalutazione crediti', rate: 0, natura: 'N2.2' },
      { code: '4814', name: 'Accantonamento per responsabilità civile', rate: 0, natura: 'N2.2' },
      { code: '4821', name: 'Fondo spese future', rate: 0, natura: 'N2.2' },
      { code: '4823', name: 'Accantonamento per manutenzioni programmate', rate: 0, natura: 'N2.2' },
      { code: '4901', name: 'Oneri fiscali diversi', rate: 0, natura: 'N2.2' },
      { code: '4903', name: 'Oneri vari', rate: 22, natura: null },
      { code: '4905', name: 'Perdite su crediti', rate: 0, natura: 'N2.2' },
      { code: '4910', name: 'Arrotondamenti passivi', rate: 0, natura: 'N2.2' },
      { code: '4920', name: 'Minusvalenze ordinarie diverse', rate: 0, natura: 'N2.2' },
      { code: '4930', name: 'Sopravvenienze passive ordinarie diverse', rate: 0, natura: 'N2.2' },
      { code: '4940', name: 'Insussistenze passive ordinarie diverse', rate: 0, natura: 'N2.2' },
      { code: '5110', name: 'Interessi attivi v/clienti', rate: 0, natura: 'N4' },
      { code: '5115', name: 'Interessi attivi bancari', rate: 0, natura: 'N4' },
      { code: '5116', name: 'Interessi attivi postali', rate: 0, natura: 'N4' },
      { code: '5140', name: 'Proventi finanziari diversi', rate: 0, natura: 'N4' },
      { code: '5201', name: 'Interessi passivi v/fornitori', rate: 0, natura: 'N4' },
      { code: '5202', name: 'Interessi passivi bancari', rate: 0, natura: 'N4' },
      { code: '5203', name: 'Sconti passivi bancari', rate: 0, natura: 'N4' },
      { code: '5210', name: 'Interessi passivi su mutui', rate: 0, natura: 'N4' },
      { code: '5240', name: 'Oneri finanziari diversi', rate: 0, natura: 'N4' },
      { code: '8101', name: 'Imposte dell\'esercizio', rate: 0, natura: 'N2.2' },
      { code: '9101', name: 'Conto di risultato economico', rate: null, natura: null },
      { code: '9102', name: 'Stato patrimoniale', rate: null, natura: null },
    ],
    period: PERIOD, priorPeriod: PRIOR_PERIOD,
    lines: [
      { id: 'L1', supplier: 'Distribuzione Ingrosso Srl', desc: 'Merce acquistata — rifornimento magazzino agosto', net: 4250.00, vat: 935.00, account: '4101', confidence: 0.95, date: '2026-08-04' },
      { id: 'L2', supplier: 'Bartolini Spedizioni Srl', desc: 'Costi di trasporto — consegne clienti luglio-agosto', net: 680.50, vat: 149.71, account: '4201', confidence: 0.9, date: '2026-08-09' },
      { id: 'L3', supplier: 'Enel Energia', desc: 'Costi per energia — sede operativa, bimestre', net: 1120.00, vat: 246.40, account: '4202', confidence: 0.96, date: '2026-08-12' },
      { id: 'L4', supplier: 'Agenzia Marketing Creativo Srl', desc: 'Costi di pubblicità — campagna social Q3', net: 950.00, vat: 209.00, account: '4203', confidence: 0.68, date: '2026-08-15' },
      { id: 'L5', supplier: 'Studio Legale e Tributario Associato', desc: 'Costi di consulenze — parere fiscale trimestrale', net: 1800.00, vat: 396.00, account: '4204', confidence: 0.72, date: '2026-08-18' },
      { id: 'L6', supplier: 'TIM Business', desc: 'Costi telefonici — linee aziendali agosto', net: 210.00, vat: 46.20, account: '4206', confidence: 0.97, date: '2026-08-20' },
      { id: 'L7', supplier: 'Immobiliare Gestioni Srl', desc: 'Costi per i locali — spese condominiali sede', net: 540.00, vat: 118.80, account: '4209', confidence: 0.6, date: '2026-08-25' },
      { id: 'L8', supplier: 'Service Tecnico Manutenzioni Srl', desc: 'Costi di manutenzione e riparazione — impianto climatizzazione', net: 430.00, vat: 94.60, account: '4211', confidence: 0.93, date: '2026-08-28' },
    ],
    priorLines: [
      { supplier: 'Distribuzione Ingrosso Srl', net: 3980.00 },
      { supplier: 'Enel Energia', net: 1050.00 },
    ],
    expected: [],
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
export function listClients() {
  return clients.map((c) => ({ id: c.id, name: c.name, regime: c.regime, ateco: c.ateco, piva: c.piva, period: c.period, lineCount: c.lines.length, email: c.email, phone: c.phone }));
}
