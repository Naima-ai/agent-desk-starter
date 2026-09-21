// tests/validator.test.mjs — proves the pieces Naima built actually work:
// the VAT checker rules, the prior-period comparison, and the Archivist.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkRateCategoryMatch,
  checkRateNaturaExclusivity,
  checkNaturaSubcode,
  checkArithmetic,
  checkSupplierIdentifier,
  checkMandatoryFields,
  checkRequiredEvidence,
  checkLegalWording,
  checkTemporalCoherence,
  checkUniqueLineNumbers,
  checkVatGroupIdentity,
  runVatRules,
} from "../backend/vatRules.mjs";
import { validateBatch } from "../backend/validator.mjs";
import * as archivista from "../backend/archivista.mjs";
import * as knowledge from "../backend/memory/knowledgeStore.mjs";
import * as teamSystem from "../backend/connectors/teamSystem.mjs";

// The Rulebook's own worked example (Section 8.4): a hotel/accommodation line
// posted at 22% when the client's taxonomy expects 10% for that category.
test("CST-04 catches the rulebook's own wrong-rate worked example", () => {
  const taxonomy = [{ code: "60.30", name: "Hotel / accommodation", rate: 10 }];
  const line = { id: "H1", supplier: "Hotel Milano", net: 100, vat: 22, account: "60.30" };
  const hit = checkRateCategoryMatch(line, taxonomy);
  assert.ok(hit, "expected a CST-04 anomaly");
  assert.equal(hit.ruleId, "CST-04");
  assert.equal(hit.observed, 22);
  assert.equal(hit.expected, 10);
});

test("CST-04 does not fire when the applied rate matches the category", () => {
  const taxonomy = [{ code: "60.10", name: "Consulenze", rate: 22 }];
  const line = { id: "C1", supplier: "Studio Bianchi", net: 100, vat: 22, account: "60.10" };
  assert.equal(checkRateCategoryMatch(line, taxonomy), null);
});

test("CST-03 flags a 0% line with no Natura code", () => {
  const line = { id: "N1", supplier: "Export Srl", net: 100, vat: 0 };
  const hit = checkRateNaturaExclusivity(line);
  assert.ok(hit);
  assert.equal(hit.kind, "natura_missing");
});

test("CST-03 flags a taxed line that also carries a Natura code", () => {
  const line = { id: "N2", supplier: "Studio Bianchi", net: 100, vat: 22, natura: "N6.7" };
  const hit = checkRateNaturaExclusivity(line);
  assert.ok(hit);
  assert.equal(hit.kind, "natura_with_rate");
});

test("SEM-01 rejects a bare Natura code missing its mandatory sub-code", () => {
  const line = { id: "N3", supplier: "Export Srl", net: 100, vat: 0, natura: "N3" };
  const hit = checkNaturaSubcode(line);
  assert.ok(hit);
  assert.equal(hit.kind, "natura_missing_subcode");
});

test("SEM-01 accepts a valid sub-coded Natura", () => {
  const line = { id: "N4", supplier: "Export Srl", net: 100, vat: 0, natura: "N3.1" };
  assert.equal(checkNaturaSubcode(line), null);
});

test("CST-02 flags a line whose VAT doesn't reconcile with net x rate", () => {
  const line = { id: "A1", supplier: "Cartoleria Sole", net: 100, vat: 50 }; // nowhere near a valid rate
  const hit = checkArithmetic(line);
  assert.ok(hit);
  assert.equal(hit.ruleId, "CST-02");
  assert.equal(hit.kind, "arithmetic_mismatch");
});

test("runVatRules is clean on a well-formed batch", () => {
  const taxonomy = [{ code: "60.10", name: "Consulenze", rate: 22 }];
  const lines = [{ id: "L1", supplier: "Studio Bianchi", net: 100, vat: 22, account: "60.10" }];
  assert.deepEqual(runVatRules(lines, taxonomy), []);
});

test("validateBatch flags a prior-period value that does not reconcile", () => {
  const batch = {
    lines: [{ id: "L1", supplier: "Enel Energia", net: 800, vat: 176, account: "60.20", confidence: 0.97 }],
    expected: [],
  };
  const priorPeriod = { lines: [{ supplier: "Enel Energia", net: 400 }] }; // 100% swing
  const taxonomy = [{ code: "60.20", name: "Utenze", rate: 22 }];
  const { anomalies } = validateBatch(batch, { priorPeriod, taxonomy });
  const hit = anomalies.find((a) => a.ruleId === "PRIOR-PERIOD");
  assert.ok(hit, "expected a PRIOR-PERIOD value-deviation anomaly");
});

test("validateBatch stays clean when nothing is actually wrong", () => {
  const batch = {
    lines: [{ id: "L1", supplier: "Enel Energia", net: 420, vat: 92.4, account: "60.20", confidence: 0.97 }],
    expected: [],
  };
  const priorPeriod = { lines: [{ supplier: "Enel Energia", net: 400 }] }; // 5% swing, within tolerance
  const taxonomy = [{ code: "60.20", name: "Utenze", rate: 22 }];
  const { ok, anomalies, tail } = validateBatch(batch, { priorPeriod, taxonomy });
  assert.equal(anomalies.length, 0);
  assert.equal(tail.length, 0);
  assert.ok(ok);
});

test("Archivist: a rule starts in shadow mode, then a human confirms it at the gate", () => {
  const key = `coa:TestSupplier_${Date.now()}`;
  archivista.proposeRule({ key, kind: "coa_mapping", scope: "client:test", value: "60.10", source: "correction", evidenceId: "ev_propose_test" });
  assert.equal(knowledge.get(key).status, "shadow");

  archivista.confirmRule(key, "Bianchi", "ev_test");
  const confirmed = knowledge.get(key);
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.confidence, 0.98);
  assert.equal(confirmed.confirmedBy, "Bianchi");
});

test("Archivist: REFUSED — never stores a rule without evidence", () => {
  const key = `coa:NoEvidenceSupplier_${Date.now()}`;
  assert.throws(() => archivista.proposeRule({ key, kind: "coa_mapping", scope: "client:test", value: "60.10", source: "correction" }), /REFUSED/);
  assert.throws(() => archivista.confirmRule(key, "Bianchi"), /REFUSED/);
});

// --- FMT-03: supplier Partita IVA check digit -------------------------------

test("FMT-03 accepts a Partita IVA with a correct check digit", () => {
  const line = { id: "X1", supplier: "Test Srl", piva: "12345678903" }; // computed, not guessed
  assert.equal(checkSupplierIdentifier(line), null);
});

test("FMT-03 rejects a Partita IVA with a wrong check digit", () => {
  const line = { id: "X2", supplier: "Gamma Forniture Srl", piva: "55667788991" }; // last digit deliberately wrong
  const hit = checkSupplierIdentifier(line);
  assert.ok(hit);
  assert.equal(hit.ruleId, "FMT-03");
  assert.equal(hit.kind, "identifier_invalid");
});

test("FMT-03 is a no-op on a line that doesn't track an identifier at all", () => {
  const line = { id: "X3", supplier: "Enel Energia" }; // no piva field — not this rule's problem yet
  assert.equal(checkSupplierIdentifier(line), null);
});

// --- The TeamSystem mock's own dataset: the brief's three seeded test cases -

test("the TeamSystem-sourced batch reproduces all three of the brief's seeded test cases", async () => {
  const batch = await teamSystem.readVatBatch();
  const priorPeriod = await teamSystem.readPriorPeriod();
  const taxonomy = await teamSystem.readChartOfAccounts();
  const { anomalies } = validateBatch(batch, { receivedDocs: [], priorPeriod, taxonomy });

  const rateMismatch = anomalies.find((a) => a.ruleId === "CST-04" && a.line === "L6");
  assert.ok(rateMismatch, "expected Hotel Milano (L6) flagged 22% vs 10%");
  assert.equal(rateMismatch.observed, 22);
  assert.equal(rateMismatch.expected, 10);

  const missingInvoice = anomalies.find((a) => a.ruleId === "DOC-MISSING");
  assert.ok(missingInvoice, "expected the missing Verdi Srl purchase invoice flagged");

  const badPiva = anomalies.find((a) => a.ruleId === "FMT-03" && a.line === "L7");
  assert.ok(badPiva, "expected Gamma Forniture Srl's invalid Partita IVA flagged");

  // and every line came back cross-checked through the Fatture in Cloud connector
  assert.ok(batch.lines.every((l) => l.fic && "live" in l.fic), "expected every line to carry a FiC lookup result");
});

test("readMasterData / readChartOfAccounts actually come from the TeamSystem mock, not a direct import", async () => {
  const master = await teamSystem.readMasterData();
  assert.equal(master.id, "rossi_srl");
  assert.ok(master.piva);

  const coa = await teamSystem.readChartOfAccounts();
  assert.ok(coa.find((c) => c.code === "60.30" && c.rate === 10), "expected the Hotel/accommodation category at 10%");
});

// --- The six new checks added for the TeamSystem Firm mock's 10-client edge cases ---

test("CON-01 flags a line with date explicitly null, not one that just doesn't track it", () => {
  assert.equal(checkMandatoryFields({ id: "X1", supplier: "S", date: null }).ruleId, "CON-01");
  assert.equal(checkMandatoryFields({ id: "X2", supplier: "S" }), null); // undefined = not tracked here, not this rule's problem
  assert.equal(checkMandatoryFields({ id: "X3", supplier: "S", date: "2026-08-01" }), null);
});

test("CON-02 flags required evidence that isn't attached, ignores lines that don't need any", () => {
  assert.equal(checkRequiredEvidence({ id: "X1", supplier: "S", requiresEvidence: true, evidenceAttached: false }).ruleId, "CON-02");
  assert.equal(checkRequiredEvidence({ id: "X2", supplier: "S", requiresEvidence: true, evidenceAttached: true }), null);
  assert.equal(checkRequiredEvidence({ id: "X3", supplier: "S" }), null);
});

test("CON-03 flags a split-payment or reverse-charge line missing its mandatory wording", () => {
  assert.equal(checkLegalWording({ id: "X1", supplier: "S", splitPayment: true, legalWording: null }).ruleId, "CON-03");
  assert.equal(checkLegalWording({ id: "X2", supplier: "S", natura: "N6.7", legalWording: null }).ruleId, "CON-03");
  assert.equal(checkLegalWording({ id: "X3", supplier: "S", natura: "N6.7", legalWording: "Inversione contabile" }), null);
  assert.equal(checkLegalWording({ id: "X4", supplier: "S" }), null);
});

test("CST-07 flags a supply date after the invoice date, ignores lines without both dates", () => {
  const hit = checkTemporalCoherence({ id: "X1", supplier: "S", invoiceDate: "2026-08-10", supplyDate: "2026-08-18" });
  assert.equal(hit.ruleId, "CST-07");
  assert.equal(checkTemporalCoherence({ id: "X2", supplier: "S", invoiceDate: "2026-08-18", supplyDate: "2026-08-10" }), null);
  assert.equal(checkTemporalCoherence({ id: "X3", supplier: "S", date: "2026-08-10" }), null);
});

test("STR-02 flags two lines in the same document sharing a line number", () => {
  const lines = [
    { id: "L1", docNumber: "FT-1", lineNumber: 1 },
    { id: "L2", docNumber: "FT-1", lineNumber: 1 },
    { id: "L3", docNumber: "FT-1", lineNumber: 2 },
  ];
  const hits = checkUniqueLineNumbers(lines);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].ruleId, "STR-02");
});

test("SDI-00327 flags a VAT Group member's invoice using the Group CF instead of its own", () => {
  const vatGroup = { isMember: true, groupCf: "GROUPCF", memberCf: "MEMBERCF" };
  const bad = checkVatGroupIdentity({ id: "X1", counterpartyCfUsed: "GROUPCF" }, vatGroup);
  assert.equal(bad.ruleId, "SDI-00327");
  assert.equal(checkVatGroupIdentity({ id: "X2", counterpartyCfUsed: "MEMBERCF" }, vatGroup), null);
  assert.equal(checkVatGroupIdentity({ id: "X3", counterpartyCfUsed: "GROUPCF" }, null), null); // not a Group member — not this rule's business
});

test("all 10 TeamSystem Firm mock clients validate exactly as designed", async () => {
  // tests/ -> agent-desk-starter (inner)/ -> agent-desk-starter (outer)/ -> teamsystem-firm-mock/
  const mockDataUrl = new URL("../../teamsystem-firm-mock/backend/data/clients.mjs", import.meta.url);
  const { clients } = await import(mockDataUrl);
  const cleanExpected = new Set(["verdi_costruzioni", "ferrari_forfettario", "gallo_esente"]);

  for (const c of clients) {
    const { anomalies, tail } = validateBatch(
      { lines: c.lines, expected: c.expected || [] },
      { taxonomy: c.chartOfAccounts, vatGroup: c.vatGroup, priorPeriod: c.priorLines ? { lines: c.priorLines } : null }
    );
    const isClean = anomalies.length === 0 && tail.length === 0;
    if (cleanExpected.has(c.id)) {
      assert.ok(isClean, `${c.name} was meant to be a clean positive case, but got: ${JSON.stringify(anomalies)}`);
    } else {
      assert.ok(!isClean, `${c.name} was meant to demonstrate "${c.edgeCase}", but validated clean`);
    }
  }
});
