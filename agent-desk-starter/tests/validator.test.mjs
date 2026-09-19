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
  runVatRules,
} from "../backend/vatRules.mjs";
import { validateBatch } from "../backend/validator.mjs";
import * as archivista from "../backend/archivista.mjs";
import * as knowledge from "../backend/memory/knowledgeStore.mjs";

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
  archivista.proposeRule({ key, kind: "coa_mapping", scope: "client:test", value: "60.10", source: "correction" });
  assert.equal(knowledge.get(key).status, "shadow");

  archivista.confirmRule(key, "Bianchi", "ev_test");
  const confirmed = knowledge.get(key);
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.confidence, 0.98);
  assert.equal(confirmed.confirmedBy, "Bianchi");
});
