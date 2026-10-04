// tests/whatsappInbound.test.mjs — inbound WhatsApp, end to end over real HTTP:
// Meta's GET verification handshake, signature checks on POSTs, matching a
// reply to the exact pending item it answers, the rule that a document request
// only closes when a real document was filed in TeamSystem, and the
// approval-gate safety rules (only a clear yes/no, only from a verified webhook).
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OWNER = "+393331234567";
const SECRET = "test-app-secret";
const INVOICE_XML = "<FatturaElettronica><CedentePrestatore><Denominazione>Verdi Srl</Denominazione></CedentePrestatore><PrezzoTotale>600.00</PrezzoTotale><AliquotaIVA>22.00</AliquotaIVA></FatturaElettronica>";

// Stand-in for the TeamSystem Firm mock: phone lookup + document filing.
const filedDocs = [];
const ts = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (code, body) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  if (url.pathname === "/api/clients/by-phone") {
    return url.searchParams.get("phone") === OWNER ? send(200, { id: "rossi_srl", name: "Rossi Srl", phone: OWNER }) : send(404, { error: "no client" });
  }
  if (url.pathname === "/api/clients/rossi_srl/documents" && req.method === "POST") {
    let body = ""; for await (const c of req) body += c;
    filedDocs.push(JSON.parse(body));
    return send(200, { ok: true, line: { id: `L${100 + filedDocs.length}`, supplier: "Verdi Srl" } });
  }
  send(404, { error: "not found" });
});
await new Promise((r) => ts.listen(0, "127.0.0.1", r));

// Stand-in for Meta's Graph API: media lookup, media download, and outgoing messages.
const sentToOwner = [];
let metaBase;
const meta = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (code, body, type = "application/json") => res.writeHead(code, { "Content-Type": type }).end(typeof body === "string" ? body : JSON.stringify(body));
  if (req.headers.authorization !== "Bearer test-token") return send(401, { error: "bad token" });
  if (url.pathname === "/PHONE1/messages" && req.method === "POST") {
    let body = ""; for await (const c of req) body += c;
    sentToOwner.push(JSON.parse(body));
    return send(200, { messages: [{ id: `wamid.FOLLOWUP_${sentToOwner.length}` }] });
  }
  if (url.pathname === "/MEDIA_XML") return send(200, { url: `${metaBase}/download/MEDIA_XML`, mime_type: "text/xml", file_size: INVOICE_XML.length });
  if (url.pathname === "/download/MEDIA_XML") return send(200, INVOICE_XML, "text/xml");
  send(404, { error: "unknown media" });
});
await new Promise((r) => meta.listen(0, "127.0.0.1", r));
metaBase = `http://127.0.0.1:${meta.address().port}`;

// Env must be set before the connectors are imported (they read it at load time).
process.env.TS_FIRM_URL = `http://127.0.0.1:${ts.address().port}`;
process.env.WHATSAPP_LOG_FILE = join(mkdtempSync(join(tmpdir(), "wa-")), "whatsapp.jsonl");
process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "verify-me";
process.env.WHATSAPP_APP_SECRET = SECRET;
process.env.WHATSAPP_TOKEN = "test-token";
process.env.WHATSAPP_PHONE_ID = "PHONE1";
process.env.WHATSAPP_GRAPH_BASE_URL = metaBase;

const { handleWhatsAppRoute, verifySignature } = await import("../backend/whatsappRoutes.mjs");
const { readBodyLimited } = await import("../backend/security.mjs");
const { pendingDocumentRequests, requestOwnerApproval, pendingGates } = await import("../backend/lAmministrativo.mjs");
const wa = await import("../backend/connectors/whatsapp.mjs");

const app = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (!(await handleWhatsAppRoute(req, res, url, readBodyLimited))) res.writeHead(404).end();
});
await new Promise((r) => app.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${app.address().port}`;
test.after(() => { app.close(); ts.close(); meta.close(); });

let seq = 0;
function metaPayload({ from = OWNER.slice(1), text, contextId, document, image }) {
  seq += 1;
  const msg = { from, id: `wamid.IN_${seq}`, ...(contextId ? { context: { id: contextId } } : {}) };
  if (document) Object.assign(msg, { type: "document", document });
  else if (image) Object.assign(msg, { type: "image", image });
  else Object.assign(msg, { type: "text", text: { body: text } });
  return JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { messages: [msg] } }] }] });
}
const XML_DOC = { id: "MEDIA_XML", filename: "fattura_verdi.xml", mime_type: "text/xml" };
const sign = (raw, secret = SECRET) => "sha256=" + createHmac("sha256", secret).update(raw, "utf8").digest("hex");
async function deliver(raw, { signature = sign(raw) } = {}) {
  return fetch(`${base}/api/whatsapp/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(signature ? { "X-Hub-Signature-256": signature } : {}) },
    body: raw,
  });
}
function openDocRequest(id, waMessageIds, extra = {}) {
  pendingDocumentRequests.set(id, {
    id, clientId: "rossi_srl", status: "pending", remindersSent: 0, escalated: false,
    expected: { docType: "invoice", supplier: "Verdi Srl", period: "2026-Q3" }, waMessageIds, ...extra,
  });
}
function openGate(waMessageId) {
  const gate = requestOwnerApproval("rossi_srl", "invoice", { draftId: "d1" }, { reminderDelaysMs: [], escalateAfterMs: 600_000 });
  gate.decision.catch(() => {}); // deny() rejects the promise; nothing else awaits it in these tests
  gate.waMessageIds = [waMessageId];
  return gate;
}

test("Meta's verification handshake echoes the challenge only with the right token", async () => {
  const ok = await fetch(`${base}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "12345");
  const bad = await fetch(`${base}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345`);
  assert.equal(bad.status, 403);
});

test("a POST with a missing or wrong signature is rejected when the app secret is set", async () => {
  const raw = metaPayload({ text: "ciao" });
  assert.equal((await deliver(raw, { signature: null })).status, 403);
  assert.equal((await deliver(raw, { signature: sign(raw, "not-the-secret") })).status, 403);
  assert.equal((await deliver(raw)).status, 200);
});

test("verifySignature: unchecked (and allowed) when no secret is configured", () => {
  assert.deepEqual(verifySignature("{}", undefined, ""), { checked: false, ok: true });
  assert.deepEqual(verifySignature("{}", sign("{}"), SECRET), { checked: true, ok: true });
});

test("a reply WITH the invoice file: downloaded, filed in TeamSystem, request resolved", async () => {
  openDocRequest("docreq_t1", ["wamid.OUT_DOC"]);
  const before = filedDocs.length;
  assert.equal((await deliver(metaPayload({ contextId: "wamid.OUT_DOC", document: XML_DOC }))).status, 200);
  assert.equal(filedDocs.length, before + 1, "the file went to TeamSystem");
  assert.equal(filedDocs.at(-1).format, "xml");
  assert.equal(filedDocs.at(-1).content, INVOICE_XML, "the exact bytes the owner sent");
  assert.equal(pendingDocumentRequests.has("docreq_t1"), false);
});

test("a text-only reply ('ecco la fattura') does NOT close the request — the owner is asked for the file", async () => {
  openDocRequest("docreq_t2", ["wamid.OUT_DOC2"]);
  const asked = sentToOwner.length;
  await deliver(metaPayload({ text: "Ecco la fattura", contextId: "wamid.OUT_DOC2" }));
  assert.equal(pendingDocumentRequests.get("docreq_t2")?.status, "pending");
  assert.equal(sentToOwner.length, asked + 1, "a follow-up asking for the file was sent");
  assert.equal(sentToOwner.at(-1).type, "text");
  assert.equal(sentToOwner.at(-1).to, OWNER);

  // The owner then replies to the follow-up with the actual file: that closes it.
  const followUpId = `wamid.FOLLOWUP_${sentToOwner.length}`;
  assert.ok(pendingDocumentRequests.get("docreq_t2").waMessageIds.includes(followUpId));
  await deliver(metaPayload({ contextId: followUpId, document: XML_DOC }));
  assert.equal(pendingDocumentRequests.has("docreq_t2"), false);
});

test("a photo is recorded but not accepted as the invoice — request stays open", async () => {
  openDocRequest("docreq_t3", ["wamid.OUT_DOC3"]);
  const before = filedDocs.length;
  await deliver(metaPayload({ contextId: "wamid.OUT_DOC3", image: { id: "MEDIA_PHOTO", mime_type: "image/jpeg" } }));
  assert.equal(filedDocs.length, before, "nothing filed");
  assert.equal(pendingDocumentRequests.get("docreq_t3")?.status, "pending");
  pendingDocumentRequests.delete("docreq_t3");
});

test("a file sent WITHOUT quoting is linked only when the client has exactly one open request", async () => {
  openDocRequest("docreq_t4", ["wamid.OUT_DOC4"]);
  await deliver(metaPayload({ document: XML_DOC })); // no context: only one open -> linked
  assert.equal(pendingDocumentRequests.has("docreq_t4"), false);

  openDocRequest("docreq_t5", ["wamid.OUT_DOC5"]);
  openDocRequest("docreq_t6", ["wamid.OUT_DOC6"], { expected: { docType: "invoice", supplier: "Blu Spa", period: "2026-Q3" } });
  await deliver(metaPayload({ document: XML_DOC })); // two open -> ambiguous, linked to neither
  assert.equal(pendingDocumentRequests.get("docreq_t5")?.status, "pending");
  assert.equal(pendingDocumentRequests.get("docreq_t6")?.status, "pending");
  pendingDocumentRequests.delete("docreq_t5"); pendingDocumentRequests.delete("docreq_t6");
});

test("a reply to the ORIGINAL message still matches after a reminder was sent", async () => {
  openDocRequest("docreq_t7", ["wamid.OUT_FIRST", "wamid.OUT_REMINDER"]);
  await deliver(metaPayload({ contextId: "wamid.OUT_FIRST", document: XML_DOC }));
  assert.equal(pendingDocumentRequests.has("docreq_t7"), false);
});

test("a message from a number TeamSystem doesn't know is logged, its file never downloaded", async () => {
  openDocRequest("docreq_t8", ["wamid.OUT_DOC8"]);
  const before = filedDocs.length;
  await deliver(metaPayload({ from: "390000000099", contextId: "wamid.OUT_DOC8", document: XML_DOC }));
  assert.equal(filedDocs.length, before);
  assert.equal(pendingDocumentRequests.get("docreq_t8")?.status, "pending");
  assert.equal(wa.listMessages({ limit: 1 })[0].status, "unmatched sender");
  pendingDocumentRequests.delete("docreq_t8");
});

test("the same Meta message id delivered twice (a Meta retry) is only processed once", async () => {
  const raw = metaPayload({ text: "duplicato" });
  await deliver(raw);
  await deliver(raw);
  assert.equal(wa.listMessages({ limit: 500 }).filter((r) => r.text === "duplicato").length, 1);
});

test("gate: a clear 'sì' approves, 'no' denies", async () => {
  const g1 = openGate("wamid.OUT_GATE1");
  await deliver(metaPayload({ text: "Sì", contextId: "wamid.OUT_GATE1" }));
  assert.equal(g1.status, "approved");
  const g2 = openGate("wamid.OUT_GATE2");
  await deliver(metaPayload({ text: "no", contextId: "wamid.OUT_GATE2" }));
  assert.equal(g2.status, "denied");
});

test("gate: an ambiguous reply never approves — the gate stays pending", async () => {
  const g = openGate("wamid.OUT_GATE3");
  await deliver(metaPayload({ text: "aspetta, controllo", contextId: "wamid.OUT_GATE3" }));
  await deliver(metaPayload({ text: "👍", contextId: "wamid.OUT_GATE3" }));
  assert.equal(g.status, "pending");
  g.deny("test cleanup");
});

test("gate: an unsigned webhook can't decide a gate even with a clear yes", async () => {
  const saved = process.env.WHATSAPP_APP_SECRET;
  delete process.env.WHATSAPP_APP_SECRET; // dev mode: unsigned POSTs accepted, but marked unverified
  try {
    const g = openGate("wamid.OUT_GATE4");
    assert.equal((await deliver(metaPayload({ text: "sì", contextId: "wamid.OUT_GATE4" }), { signature: null })).status, 200);
    assert.equal(g.status, "pending", "an unverified reply must not release a gated action");
    g.deny("test cleanup");
  } finally {
    process.env.WHATSAPP_APP_SECRET = saved;
  }
  assert.equal(pendingGates.size, 0);
});

test("the pipeline's wait ends when the owner's document resolves the request", async () => {
  const { waitForDocumentRequest } = await import("../backend/scenario/vatFilingPath.mjs");
  openDocRequest("docreq_w1", ["wamid.OUT_W1"]);
  const waiting = waitForDocumentRequest("docreq_w1", 5000);
  await deliver(metaPayload({ contextId: "wamid.OUT_W1", document: XML_DOC }));
  assert.equal(await waiting, "resolved");
});

test("the pipeline's wait times out cleanly and leaves the request open", async () => {
  const { waitForDocumentRequest } = await import("../backend/scenario/vatFilingPath.mjs");
  openDocRequest("docreq_w2", ["wamid.OUT_W2"]);
  assert.equal(await waitForDocumentRequest("docreq_w2", 50), "timeout");
  assert.equal(pendingDocumentRequests.get("docreq_w2")?.status, "pending", "a late document can still close it");
  pendingDocumentRequests.delete("docreq_w2");
});

test("the pipeline's wait returns at once if the request was already closed", async () => {
  const { waitForDocumentRequest } = await import("../backend/scenario/vatFilingPath.mjs");
  assert.equal(await waitForDocumentRequest("docreq_never_existed", 5000), "resolved");
});
