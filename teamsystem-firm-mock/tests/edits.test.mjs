import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "ts-edits-"));
process.env.TS_EDITS_FILE = join(dir, "edits.json");
process.env.TS_WORKFLOW_FILE = join(dir, "wf.json");
const { getClient } = await import("../backend/data/clients.mjs");
const edits = await import("../backend/edits.mjs");
const wf = await import("../backend/workflow.mjs");

const client = getClient("rossi_srl");
const line = client.lines[0];
const original = { vat: line.vat, piva: client.piva, email: client.email, name: client.name };
test.after(() => edits.revertEdits(client));

test("a client's email address can be changed, validated, and is logged with who/why", () => {
  assert.equal(edits.editClient(client, { email: "not-an-email" }).ok, false);
  const r = edits.editClient(client, { email: "  Owner@Rossi.IT " }, { by: "naima", reason: "client confirmed by phone" });
  assert.equal(r.ok, true);
  assert.equal(client.email, "owner@rossi.it");
  const entry = edits.getEditLog(client.id)[0];
  assert.deepEqual([entry.by, entry.field, entry.from, entry.to, entry.reason], ["naima", "email", original.email, "owner@rossi.it", "client confirmed by phone"]);
});

test("a Partita IVA must pass the real check-digit rule", () => {
  assert.equal(edits.editClient(client, { piva: "12345678901" }).ok, false, "bad check digit");
  assert.equal(edits.editClient(client, { piva: "IT07890123453" }).ok, true);
  assert.equal(client.piva, "07890123453", "IT prefix is stripped");
});

test("only whitelisted fields can be edited", () => {
  const r = edits.editClient(client, { id: "hacked", chartOfAccounts: [] });
  assert.equal(r.ok, false);
  assert.match(r.error, /cannot be edited/);
});

test("a line's VAT can be fixed, and an account outside the chart is refused", () => {
  assert.equal(edits.editLine(client, line.id, { account: "99.99" }).ok, false);
  assert.equal(edits.editLine(client, "NOPE", { vat: "1" }).status, 404);
  assert.equal(edits.editLine(client, line.id, { vat: "-5" }).ok, false, "negative amounts refused");
  assert.equal(edits.editLine(client, line.id, { vat: "123.456" }).ok, true);
  assert.equal(line.vat, 123.46, "rounded to cents");
});

test("an edit that changes nothing is not logged", () => {
  const before = edits.getEditLog(client.id).length;
  edits.editLine(client, line.id, { vat: String(line.vat) });
  assert.equal(edits.getEditLog(client.id).length, before);
});

test("revert restores the original data", () => {
  const r = edits.revertEdits(client);
  assert.ok(r.reverted >= 3);
  assert.equal(line.vat, original.vat);
  assert.equal(client.email, original.email);
  assert.equal(client.piva, original.piva);
  assert.equal(edits.getEditLog(client.id).length, 0);
});

test("editing data after a clean validation cancels the pending signature", () => {
  wf.resetWorkflow();
  const rec = { period: "2026-Q3", status: "awaiting_signature", summary: "s", deadline: "2026-11-30", openItems: [], at: new Date().toISOString() };
  wf.applyWriteBack({ id: "c9", name: "C9 Srl", piva: "07890123453" }, rec);
  const r = wf.noteEdit("c9", "2026-Q3", "line L1 vat changed");
  assert.equal(r.invalidated, true);
  assert.equal(r.stage, "ready_for_revalidation");
  const ps = wf.getWorkflow("c9").periods[0];
  assert.equal(ps.tasks.filter((t) => t.status === "open").map((t) => t.kind).join(), "revalidate");
  assert.equal(wf.sign("c9", "2026-Q3", "x").status, 409, "cannot sign until re-validated");
});
