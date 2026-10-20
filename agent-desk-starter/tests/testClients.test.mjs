import test from "node:test";
import { mkdtempSync as __mk } from "node:fs";
import { tmpdir as __tmp } from "node:os";
import { join as __join } from "node:path";
process.env.AGENT_DESK_DATA_DIR = __mk(__join(__tmp(), "agentdesk-test-"));
import assert from "node:assert/strict";

// Keep the model gateway deterministic: no local server, no cloud key -> the
// offline fallback, whatever machine this runs on.
process.env.LOCAL_SLM_URL = "http://127.0.0.1:9/v1/chat/completions";
delete process.env.FALLBACK_LLM_KEY;
delete process.env.GEMINI_API_KEY;

const { validateBatch } = await import("../backend/validator.mjs");
const { classifyLine } = await import("../backend/classifier.mjs");
const archivista = await import("../backend/archivista.mjs");
const { clients } = await import(new URL("../../teamsystem-firm-mock/backend/data/clients.mjs", import.meta.url));

const byId = (id) => clients.find((c) => c.id === id);
const run = (c) => validateBatch(
  { lines: c.lines, expected: c.expected || [] },
  { taxonomy: c.chartOfAccounts, vatGroup: c.vatGroup, priorPeriod: c.priorLines ? { lines: c.priorLines } : null },
);
const rules = (c) => [...new Set(run(c).anomalies.map((a) => a.ruleId))].sort();
const kinds = (c) => run(c).anomalies.map((a) => a.kind).sort();

test("CST-02: only the arithmetic rule fires when VAT != net x rate but the implied rate is still admissible", () => {
  assert.deepEqual(rules(byId("bruni_aritmetica")), ["CST-02"]);
});

test("SEM-02: a 21% rate is flagged as impossible (and, realistically, trips CST-02 and CST-04 too)", () => {
  assert.deepEqual(rules(byId("fontana_aliquota")), ["CST-02", "CST-04", "SEM-02"]);
});

test("CST-03: 0% with no Natura, and a taxed line carrying a Natura, are both caught", () => {
  const c = byId("moretti_natura");
  assert.deepEqual(rules(c), ["CST-03"]);
  assert.deepEqual(kinds(c), ["natura_missing", "natura_with_rate"]);
});

test("SEM-01: an invalid Natura code and a bare N6 are both caught; the wording is present so CON-03 stays quiet", () => {
  const c = byId("ricci_codici_natura");
  assert.deepEqual(rules(c), ["SEM-01"]);
  assert.deepEqual(kinds(c), ["natura_invalid", "natura_missing_subcode"]);
});

test("STR-01: TD99 is not a FatturaPA document type, TD01 is fine", () => {
  const c = byId("greco_tipo_documento");
  assert.deepEqual(rules(c), ["STR-01"]);
  assert.equal(run(c).anomalies.length, 1);
});

test("PRIOR-PERIOD: only the supplier whose amount jumped 400% is flagged", () => {
  const c = byId("conte_variazione");
  const a = run(c).anomalies;
  assert.deepEqual(rules(c), ["PRIOR-PERIOD"]);
  assert.equal(a.length, 1);
  assert.equal(a[0].supplier, "Fornitore Costante Srl");
  assert.equal(a[0].deltaPct, 400);
});

test("FMT-01: the broken-feed client is flagged for the server to serve a truncated file, and its own data is clean", () => {
  const c = byId("barbieri_feed_corrotto");
  assert.equal(c.corruptFeed, true);
  const r = run(c);
  assert.equal(r.anomalies.length, 0, "the problem is the FILE, not the data — it surfaces at ingestion");
});

test("MESSY: six different problems and one unclassified line in a single quarter, spread over all severities", () => {
  const c = byId("esposito_misto");
  const r = run(c);
  assert.deepEqual(rules(c), ["CON-01", "CST-04", "CST-07", "DOC-MISSING", "FMT-03", "PRIOR-PERIOD"]);
  assert.equal(r.tail.length, 1);
  const sev = new Set(r.anomalies.map((a) => a.severity));
  assert.ok(sev.has("Blocking") && sev.has("Major") && sev.has("Minor"), "Blocking, Major and Minor all present");
  const fmt = r.anomalies.find((a) => a.ruleId === "FMT-03");
  assert.match(fmt.message, /not 11 digits/, "this is the wrong-number-of-digits P.IVA case");
});

test("LEARNING: first run every line needs a human; once confirmed, the next run resolves them from memory", async () => {
  const c = byId("lombardi_apprendimento");
  assert.equal(run(c).tail.length, 5, "five low-confidence lines");
  assert.equal(run(c).anomalies.length, 0, "and nothing else wrong with the data");

  const clientId = "test_learning_client"; // not the real client id: keeps real memory untouched
  for (const line of c.lines) {
    const r = await classifyLine(line, clientId, c.chartOfAccounts);
    assert.equal(r.needsHuman, true, `${line.supplier} must go to a human the first time`);
    assert.notEqual(r.source, "memory");
  }
  c.lines.forEach((line, i) => archivista.learnConfirmed({
    key: `client:${clientId}:coa:${line.supplier}`, kind: "coa_mapping", scope: `client:${clientId}`,
    value: "61.00", confirmedBy: "studio_professional", evidenceId: `ev_test_${i}`,
  }));
  for (const line of c.lines) {
    const r = await classifyLine(line, clientId, c.chartOfAccounts);
    assert.equal(r.source, "memory", `${line.supplier} is now remembered`);
    assert.equal(r.needsHuman, false);
    assert.equal(r.account, "61.00");
  }
});
