import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const patched = [];
const fakeTs = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
  const send = (s, o) => res.writeHead(s, { "Content-Type": "application/json" }).end(JSON.stringify(o));
  if (req.method === "PATCH" && req.url === "/api/clients/rossi_srl") { patched.push(body.changes); return send(200, { ok: true }); }
  if (req.url === "/api/clients/rossi_srl") return send(200, { id: "rossi_srl", name: "Rossi Srl", email: "owner@rossi.example", phone: "+390212345678" });
  send(404, {});
});
await new Promise((r) => fakeTs.listen(0, "127.0.0.1", r));
process.env.TS_FIRM_URL = `http://127.0.0.1:${fakeTs.address().port}`;
process.env.EMAIL_LOG_FILE = join(mkdtempSync(join(tmpdir(), "dc-")), "email.jsonl");
delete process.env.SMTP_HOST; delete process.env.WHATSAPP_TOKEN;
test.after(() => fakeTs.close());

const { pendingDocumentRequests } = await import("../backend/lAmministrativo.mjs");
const { contactForRequest, describeRequest } = await import("../backend/documentContact.mjs");

const newRequest = (id) => {
  const r = { id, clientId: "rossi_srl", expected: { docType: "invoice", supplier: "Verdi Srl", period: "2026-Q2" }, status: "pending", remindersSent: 0, escalated: false };
  pendingDocumentRequests.set(id, r);
  return r;
};

test("the request card is pre-filled with the client's email and phone from TeamSystem", async () => {
  const d = await describeRequest(newRequest("docreq_t1"));
  assert.equal(d.contact.email, "owner@rossi.example");
  assert.equal(d.contact.phone, "+390212345678");
});

test("email: the typed recipient, subject and message are sent and recorded on the request", async () => {
  const r = newRequest("docreq_t2");
  const out = await contactForRequest("docreq_t2", { channel: "email", to: "someone@rossi.example", subject: "Need the Verdi invoice", body: "Please send it." });
  assert.equal(out.status, 200);
  assert.equal(out.body.contact.to, "someone@rossi.example");
  assert.equal(out.body.contact.live, false, "no SMTP configured -> honest stub");
  assert.equal(r.contacts.length, 1);
});

test("whatsapp: a real international number and template are required", async () => {
  newRequest("docreq_t3");
  assert.equal((await contactForRequest("docreq_t3", { channel: "whatsapp", to: "0212345678", template: "request_document", vars: {} })).status, 400, "no +country code");
  assert.equal((await contactForRequest("docreq_t3", { channel: "whatsapp", to: "+390212345678", template: "Bad Template!", vars: {} })).status, 400);
  const ok = await contactForRequest("docreq_t3", { channel: "whatsapp", to: "+390212345678", template: "request_document", vars: { doc: "invoice Verdi Srl", period: "2026-Q2" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.contact.channel, "whatsapp");
});

test("a bad email address, an unknown field, or an unknown request are refused", async () => {
  newRequest("docreq_t4");
  assert.equal((await contactForRequest("docreq_t4", { channel: "email", to: "nope", subject: "s", body: "b" })).status, 400);
  assert.equal((await contactForRequest("docreq_t4", { channel: "email", to: "a@b.example", subject: "s", body: "b", cc: "x@y.example" })).status, 400);
  assert.equal((await contactForRequest("docreq_missing", { channel: "email", to: "a@b.example", subject: "s", body: "b" })).status, 404);
});

test("saveToClient writes the new address back to the client's TeamSystem record", async () => {
  newRequest("docreq_t5");
  const out = await contactForRequest("docreq_t5", { channel: "email", to: "new@rossi.example", subject: "s", body: "b", saveToClient: true });
  assert.equal(out.body.savedToClient, true);
  assert.deepEqual(patched.at(-1), { email: "new@rossi.example" });
});
