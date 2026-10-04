// tests/whatsappInbound.test.mjs — inbound WhatsApp, end to end over real HTTP:
// Meta's GET verification handshake, signature checks on POSTs, matching a
// reply to the exact pending ticket it answers, and the approval-gate safety
// rules (only a clear yes/no, only from a signature-verified webhook).
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OWNER = "+393331234567";
const SECRET = "test-app-secret";

// A stand-in for the TeamSystem Firm mock: only the by-phone lookup is needed.
const ts = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/clients/by-phone" && url.searchParams.get("phone") === OWNER) {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: "rossi_srl", name: "Rossi Srl", phone: OWNER }));
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"no client"}');
});
await new Promise((r) => ts.listen(0, "127.0.0.1", r));

// Env must be set before the connectors are imported (they read it at load time).
process.env.TS_FIRM_URL = `http://127.0.0.1:${ts.address().port}`;
process.env.WHATSAPP_LOG_FILE = join(mkdtempSync(join(tmpdir(), "wa-")), "whatsapp.jsonl");
process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "verify-me";
process.env.WHATSAPP_APP_SECRET = SECRET;

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
test.after(() => { app.close(); ts.close(); });

let seq = 0;
function metaPayload({ from = OWNER.slice(1), text, contextId }) {
  seq += 1;
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: { messages: [{
      from, id: `wamid.IN_${seq}`, type: "text", text: { body: text },
      ...(contextId ? { context: { id: contextId } } : {}),
    }] } }] }],
  });
}
const sign = (raw, secret = SECRET) => "sha256=" + createHmac("sha256", secret).update(raw, "utf8").digest("hex");
async function deliver(raw, { signature = sign(raw) } = {}) {
  return fetch(`${base}/api/whatsapp/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(signature ? { "X-Hub-Signature-256": signature } : {}) },
    body: raw,
  });
}
function openGate(lastWaMessageId) {
  const gate = requestOwnerApproval("rossi_srl", "invoice", { draftId: "d1" }, { reminderDelaysMs: [], escalateAfterMs: 600_000 });
  gate.decision.catch(() => {}); // deny() rejects the promise; nothing else awaits it in these tests
  gate.lastWaMessageId = lastWaMessageId;
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

test("a reply to the request_document message resolves that exact document request", async () => {
  pendingDocumentRequests.set("docreq_t1", {
    id: "docreq_t1", clientId: "rossi_srl", status: "pending", remindersSent: 0, escalated: false,
    expected: { docType: "invoice", supplier: "Verdi Srl", period: "2026-Q3" }, lastWaMessageId: "wamid.OUT_DOC",
  });
  assert.equal((await deliver(metaPayload({ text: "Ecco la fattura", contextId: "wamid.OUT_DOC" }))).status, 200);
  assert.equal(pendingDocumentRequests.has("docreq_t1"), false, "request should be resolved and removed");
});

test("a reply to the ORIGINAL message still resolves after a reminder was sent", async () => {
  pendingDocumentRequests.set("docreq_t4", {
    id: "docreq_t4", clientId: "rossi_srl", status: "pending", remindersSent: 1, escalated: false,
    expected: { docType: "invoice", supplier: "Gialli Srl", period: "2026-Q3" },
    waMessageIds: ["wamid.OUT_FIRST", "wamid.OUT_REMINDER"], // first send, then a reminder
  });
  await deliver(metaPayload({ text: "eccola", contextId: "wamid.OUT_FIRST" }));
  assert.equal(pendingDocumentRequests.has("docreq_t4"), false);
});

test("a reply that doesn't quote any pending message resolves nothing", async () => {
  pendingDocumentRequests.set("docreq_t2", {
    id: "docreq_t2", clientId: "rossi_srl", status: "pending", remindersSent: 0, escalated: false,
    expected: { docType: "invoice", supplier: "Blu Spa", period: "2026-Q3" }, lastWaMessageId: "wamid.OUT_DOC2",
  });
  await deliver(metaPayload({ text: "ciao" })); // no context.id at all
  await deliver(metaPayload({ text: "ciao", contextId: "wamid.SOMETHING_ELSE" }));
  assert.equal(pendingDocumentRequests.get("docreq_t2")?.status, "pending");
  pendingDocumentRequests.delete("docreq_t2");
});

test("a message from a number TeamSystem doesn't know is logged but never applied", async () => {
  pendingDocumentRequests.set("docreq_t3", {
    id: "docreq_t3", clientId: "rossi_srl", status: "pending", remindersSent: 0, escalated: false,
    expected: { docType: "invoice", supplier: "Neri Srl", period: "2026-Q3" }, lastWaMessageId: "wamid.OUT_DOC3",
  });
  await deliver(metaPayload({ from: "390000000099", text: "ecco", contextId: "wamid.OUT_DOC3" }));
  assert.equal(pendingDocumentRequests.get("docreq_t3")?.status, "pending");
  const last = wa.listMessages({ limit: 1 })[0];
  assert.equal(last.status, "unmatched sender");
  pendingDocumentRequests.delete("docreq_t3");
});

test("the same Meta message id delivered twice (a Meta retry) is only processed once", async () => {
  const raw = metaPayload({ text: "duplicato" });
  await deliver(raw);
  await deliver(raw);
  const copies = wa.listMessages({ limit: 500 }).filter((r) => r.text === "duplicato");
  assert.equal(copies.length, 1);
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

test("the pipeline's wait ends when a WhatsApp reply resolves the request", async () => {
  const { waitForDocumentRequest } = await import("../backend/scenario/vatFilingPath.mjs");
  pendingDocumentRequests.set("docreq_w1", {
    id: "docreq_w1", clientId: "rossi_srl", status: "pending", remindersSent: 0, escalated: false,
    expected: { docType: "invoice", supplier: "Verdi Srl", period: "2026-Q3" }, waMessageIds: ["wamid.OUT_W1"],
  });
  const waiting = waitForDocumentRequest("docreq_w1", 5000);
  await deliver(metaPayload({ text: "Ecco la fattura", contextId: "wamid.OUT_W1" }));
  assert.equal(await waiting, "resolved");
});

test("the pipeline's wait times out cleanly and leaves the request open", async () => {
  const { waitForDocumentRequest } = await import("../backend/scenario/vatFilingPath.mjs");
  pendingDocumentRequests.set("docreq_w2", {
    id: "docreq_w2", clientId: "rossi_srl", status: "pending", remindersSent: 0, escalated: false,
    expected: { docType: "invoice", supplier: "Verdi Srl", period: "2026-Q3" }, waMessageIds: ["wamid.OUT_W2"],
  });
  assert.equal(await waitForDocumentRequest("docreq_w2", 50), "timeout");
  assert.equal(pendingDocumentRequests.get("docreq_w2")?.status, "pending", "a late reply can still close it");
  pendingDocumentRequests.delete("docreq_w2");
});

test("the pipeline's wait returns at once if the reply already closed the request", async () => {
  const { waitForDocumentRequest } = await import("../backend/scenario/vatFilingPath.mjs");
  assert.equal(await waitForDocumentRequest("docreq_never_existed", 5000), "resolved");
});
