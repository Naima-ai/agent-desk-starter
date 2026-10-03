import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TS_WORKFLOW_FILE = join(mkdtempSync(join(tmpdir(), "ts-wf-")), "state.json");
const wf = await import("../backend/workflow.mjs");

const client = { id: "c1", name: "Test Srl", piva: "07890123453" };
const rec = (over) => ({ period: "2026-Q3", status: "needs_review", summary: "s", deadline: "2026-11-30", tailCount: 0, anomalyCount: 0, openItems: [], at: new Date().toISOString(), ...over });

test.beforeEach(() => wf.resetWorkflow());

test("needs_review opens tasks, sends a client request, schedules a reminder", () => {
  const out = wf.applyWriteBack(client, rec({
    anomalyCount: 1, tailCount: 1,
    openItems: [
      { type: "anomaly", kind: "rate_mismatch", ruleId: "CST-04", message: "Rate 10% but 22% expected", recurringCount: 2 },
      { type: "tail", kind: "low_confidence", message: "Line L3 needs a category" },
    ],
  }));
  assert.equal(out.stage, "needs_review");
  const ps = wf.getWorkflow("c1").periods[0];
  assert.equal(ps.tasks.filter((t) => t.status === "open").length, 2);
  assert.equal(ps.outbox.length, 1);
  assert.match(ps.outbox[0].template, /9\.2/);
  assert.match(ps.outbox[0].body, /earlier validation/);
  assert.equal(ps.reminders.length, 1);
});

test("missing document uses the 9.1 template", () => {
  wf.applyWriteBack(client, rec({ anomalyCount: 1, openItems: [{ type: "anomaly", kind: "item_missing", ruleId: "CMP-01", supplier: "Verdi Srl", message: "invoice Verdi Srl missing" }] }));
  assert.match(wf.getWorkflow("c1").periods[0].outbox[0].template, /9\.1/);
});

test("a clean write-back opens the signature task and closes old review work", () => {
  wf.applyWriteBack(client, rec({ anomalyCount: 1, openItems: [{ type: "anomaly", kind: "x", ruleId: "R", message: "m" }] }));
  const out = wf.applyWriteBack(client, rec({ status: "awaiting_signature" }));
  assert.equal(out.stage, "awaiting_signature");
  const ps = wf.getWorkflow("c1").periods[0];
  assert.equal(ps.tasks.filter((t) => t.status === "open").map((t) => t.kind).join(), "sign");
  assert.ok(out.nextSteps.some((s) => /Auto-closed/.test(s)));
});

test("completing every review task moves the period to re-validation", () => {
  wf.applyWriteBack(client, rec({ anomalyCount: 1, openItems: [{ type: "anomaly", kind: "x", ruleId: "R", message: "m" }] }));
  const ps = wf.getWorkflow("c1").periods[0];
  const r = wf.completeTask("c1", "2026-Q3", ps.tasks[0].id);
  assert.equal(r.ok, true);
  assert.equal(r.stage, "ready_for_revalidation");
  assert.ok(r.followUp);
});

test("sign and transmit are gated by stage and produce a protocol", () => {
  wf.applyWriteBack(client, rec({ anomalyCount: 1, openItems: [{ type: "anomaly", kind: "x", ruleId: "R", message: "m" }] }));
  assert.equal(wf.sign("c1", "2026-Q3", "Dr. Rossi").status, 409, "cannot sign with open problems");
  wf.applyWriteBack(client, rec({ status: "awaiting_signature" }));
  assert.equal(wf.transmit(client, "2026-Q3").status, 409, "cannot transmit before signing");
  assert.equal(wf.sign("c1", "2026-Q3", "Dr. Rossi").ok, true);
  const t = wf.transmit(client, "2026-Q3");
  assert.equal(t.ok, true);
  assert.match(t.protocol, /^LIPE-2026-Q3-3453-\d{4}$/);
});

test("a filed period is never reopened by a late write-back", () => {
  wf.applyWriteBack(client, rec({ status: "awaiting_signature" }));
  wf.sign("c1", "2026-Q3", "x"); wf.transmit(client, "2026-Q3");
  const out = wf.applyWriteBack(client, rec({ anomalyCount: 1, openItems: [{ type: "anomaly", kind: "x", ruleId: "R", message: "m" }] }));
  assert.equal(out.stage, "filed");
});

test("due reminders fire once and become a client message while review is open", () => {
  wf.applyWriteBack(client, rec({ anomalyCount: 1, openItems: [{ type: "anomaly", kind: "x", ruleId: "R", message: "m" }] }));
  const fired = wf.fireDueReminders("2999-01-01");
  assert.equal(fired.length, 1);
  assert.equal(wf.fireDueReminders("2999-01-01").length, 0);
  assert.match(wf.getWorkflow("c1").periods[0].outbox.at(-1).template, /9\.3/);
});

test("a newer validation replaces earlier reminders instead of stacking them", () => {
  const item = { type: "anomaly", kind: "x", ruleId: "R", message: "m" };
  wf.applyWriteBack(client, rec({ anomalyCount: 1, openItems: [item] }));
  wf.applyWriteBack(client, rec({ anomalyCount: 1, openItems: [item] }));
  assert.equal(wf.fireDueReminders("2999-01-01").length, 1);
});
