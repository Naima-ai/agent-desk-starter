import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A tiny fake TeamSystem Firm: knows one client, records what gets filed.
const filed = [];
const fakeTs = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
  const send = (s, o) => res.writeHead(s, { "Content-Type": "application/json" }).end(JSON.stringify(o));
  if (url.pathname === "/api/clients/by-email") {
    return url.searchParams.get("email") === "owner@rossi.example" ? send(200, { id: "rossi_srl", name: "Rossi Srl", email: "owner@rossi.example" }) : send(404, { error: "no" });
  }
  if (url.pathname === "/api/clients/rossi_srl") return send(200, { id: "rossi_srl", name: "Rossi Srl", email: "owner@rossi.example" });
  if (url.pathname === "/api/clients/rossi_srl/attachments") { filed.push(["attachment", body.filename]); return send(200, { ok: true, docId: "DOC1" }); }
  if (url.pathname === "/api/clients/rossi_srl/documents") { filed.push([body.format, body.content.slice(0, 10)]); return send(200, { ok: true, line: { id: "L9", supplier: "Fornitore" }, added: [{}, {}] }); }
  send(404, {});
});
await new Promise((r) => fakeTs.listen(0, "127.0.0.1", r));
process.env.TS_FIRM_URL = `http://127.0.0.1:${fakeTs.address().port}`;
process.env.EMAIL_LOG_FILE = join(mkdtempSync(join(tmpdir(), "email-")), "email.jsonl");
delete process.env.SMTP_HOST; delete process.env.IMAP_HOST; delete process.env.EMAIL_WEBHOOK_TOKEN;
test.after(() => fakeTs.close());

const email = await import("../backend/connectors/email.mjs");
const { handleEmailRoute } = await import("../backend/emailRoutes.mjs");

test("with no SMTP settings, sending is an honest offline stub that is still recorded", async () => {
  const rec = await email.sendEmail({ clientId: "rossi_srl", to: "owner@rossi.example", subject: "Missing invoice\r\nBcc: spy@evil.example", text: "Please send it." });
  assert.equal(rec.live, false);
  assert.match(rec.status, /stub/);
  assert.ok(!/[\r\n]/.test(rec.subject), "newlines are stripped from the subject (no header injection)");
  assert.equal(email.listMessages({ clientId: "rossi_srl" })[0].direction, "out");
});

test("invalid recipients and empty messages are rejected", async () => {
  await assert.rejects(email.sendEmail({ to: "not-an-address", subject: "s", text: "t" }), /valid recipient/);
  await assert.rejects(email.sendEmail({ to: "a@b.example", subject: "", text: "t" }), /subject/);
  await assert.rejects(email.sendEmail({ to: "a@b.example", subject: "s", text: "  " }), /body/);
});

test("mail from an unknown sender is logged and its attachments are dropped", async () => {
  const before = filed.length;
  const r = await email.ingestInbound({ from: "Stranger <x@nowhere.example>", subject: "hi", text: "t", messageId: "<u1>", attachments: [{ filename: "a.pdf", content: Buffer.from("%PDF") }] });
  assert.equal(r.matched, false);
  assert.equal(filed.length, before);
});

test("mail from a client is matched and its attachments are filed in TeamSystem; unsafe types are skipped", async () => {
  const r = await email.ingestInbound({
    from: "Mario Rossi <owner@rossi.example>", subject: "Documents", text: "Here you go", messageId: "<c1>",
    attachments: [
      { filename: "fattura.pdf", content: Buffer.from("%PDF-1.4") },
      { filename: "fattura.xml", content: Buffer.from("<xml>doc</xml>") },
      { filename: "run.exe", content: Buffer.from("MZ") },
    ],
  });
  assert.equal(r.matched, true);
  assert.equal(r.client.id, "rossi_srl");
  const out = r.record.attachments.map((a) => a.outcome);
  assert.match(out[0], /stored as DOC1/);
  assert.match(out[1], /added invoice line L9/);
  assert.match(out[2], /skipped/);
  assert.deepEqual(filed.map((f) => f[0]), ["attachment", "xml"]);
});

test("the same Message-ID is processed once", async () => {
  const again = await email.ingestInbound({ from: "owner@rossi.example", subject: "Documents", messageId: "<c1>", attachments: [] });
  assert.equal(again.duplicate, true);
});

test("oversized attachments are skipped", async () => {
  process.env.EMAIL_MAX_ATTACHMENT_BYTES = "10";
  const r = await email.ingestInbound({ from: "owner@rossi.example", subject: "big", messageId: "<c2>", attachments: [{ filename: "big.pdf", content: Buffer.alloc(100) }] });
  delete process.env.EMAIL_MAX_ATTACHMENT_BYTES;
  assert.match(r.record.attachments[0].outcome, /larger than/);
});

const call = async (method, path, { body, headers = {} } = {}) => {
  const req = { method, headers };
  let status, out;
  const res = { writeHead(s) { status = s; return { end(o) { out = o; } }; } };
  const handled = await handleEmailRoute(req, res, new URL(path, "http://x"), async () => (body ? JSON.stringify(body) : ""));
  return { handled, status, json: out ? JSON.parse(out) : null };
};

test("the inbound webhook is disabled unless a token is configured, and checks it", async () => {
  const payload = { from: "owner@rossi.example", subject: "wh", messageId: "<w1>", attachments: [] };
  assert.equal((await call("POST", "/api/email/inbound", { body: payload })).status, 503);
  process.env.EMAIL_WEBHOOK_TOKEN = "hook-secret";
  assert.equal((await call("POST", "/api/email/inbound", { body: payload, headers: { "x-webhook-token": "wrong" } })).status, 403);
  const ok = await call("POST", "/api/email/inbound", { body: payload, headers: { "x-webhook-token": "hook-secret" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.matched, true);
  assert.equal((await call("POST", "/api/email/inbound", { body: { from: "x" }, headers: { "x-webhook-token": "hook-secret" } })).status, 400, "schema-invalid body");
  delete process.env.EMAIL_WEBHOOK_TOKEN;
});

test("POST /api/email/send goes only to the address TeamSystem has on file", async () => {
  const r = await call("POST", "/api/email/send", { body: { clientId: "rossi_srl", subject: "Reminder", body: "Please reply." } });
  assert.equal(r.status, 200);
  assert.equal(r.json.record.to, "owner@rossi.example");
  const extra = await call("POST", "/api/email/send", { body: { clientId: "rossi_srl", subject: "s", body: "b", to: "attacker@evil.example" } });
  assert.equal(extra.status, 400, "a caller cannot choose the recipient");
});
