// backend/server.mjs — TeamSystem Firm mock: the studio's own IT system,
// standing in for the real TeamSystem/gestionale + Fatture in Cloud until a
// real connector exists. Zero-framework HTTP, same style as agent-desk-starter.
// Holds 11 clients' worth of VAT batches and serves them — plus a FatturaPA-
// shaped XML per invoice line — over a small HTTP API, and a browsing UI.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, resolve, sep } from "node:path";
import { createGuard, listenHost, readBodyLimited, serviceAuthHeaders } from "./security.mjs";
import { clients, getClient, getClientByEmail, listClients } from "./data/clients.mjs";
import { toFatturaPaXml } from "./xmlGenerator.mjs";
import { toRawJsonFeed, toRawCsv } from "./rawFeeds.mjs";
import { editClient, editLine, getEditLog, revertEdits } from "./edits.mjs";
import { periodStage, noteEdit, applyWriteBack, markDelivery, getWorkflow, getWriteBacks, completeTask, sign, transmit, fireDueReminders } from "./workflow.mjs";
import { attachmentPath, createClient, addAccount, addDocumentFromXml, addDocumentsFromCsv, addAttachment } from "./adminActions.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, "..", "frontend");
const PORT = process.env.PORT || 5680;
const AGENT_DESK_URL = process.env.AGENT_DESK_URL || "http://127.0.0.1:5173";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

const readBody = readBodyLimited; // hard size cap + one-shot UTF-8 decode, see security.mjs

const { guard } = createGuard({
  port: PORT,
  // React + Babel standalone are served locally (/vendor) and compile the inline script, hence unsafe-eval/unsafe-inline here.
  csp: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
});

const server = createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (e) {
    // A bug in any one route used to take the whole mock down (an uncaught
    // exception in an async request handler crashes the Node process, not
    // just that request) — caught for real when addAttachment() threw on a
    // seeded client with no `attachments` array. Bugs still get fixed, but
    // one broken endpoint no longer kills every other client's demo too.
    console.error(`[server] unhandled error on ${req.method} ${req.url}:`, e);
    if (!res.headersSent) { if (e.status === 413) res.setHeader("Connection", "close"); } if (!res.headersSent) json(res, e.status || 500, { error: e.status === 413 ? "request body too large" : "internal error" });
  }
});

// Client requests TeamSystem decides to send actually go out as email, through
// Agent Desk's email connector (SMTP, or its offline stub). The outcome is
// stored on the message so the workflow view shows what really happened.
async function dispatchEmails(client, period, messages) {
  for (const m of messages) {
    let delivery;
    try {
      const r = await fetch(`${AGENT_DESK_URL}/api/email/send`, {
        method: "POST", headers: { "Content-Type": "application/json", ...serviceAuthHeaders() },
        body: JSON.stringify({ clientId: client.id, subject: m.subject, body: m.body }), signal: AbortSignal.timeout(10000),
      });
      const data = await r.json().catch(() => ({}));
      delivery = r.ok ? { channel: "email", to: data.record?.to, status: data.record?.status || "sent", live: Boolean(data.record?.live) } : { channel: "email", status: `failed: ${data.error || r.status}` };
    } catch (e) { delivery = { channel: "email", status: `failed: Agent Desk not reachable (${e.message})` }; }
    markDelivery(client.id, period, m.id, delivery);
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (!(await guard(req, res, url))) return;
  const parts = url.pathname.split("/").filter(Boolean);

  // GET /api/clients — the roster
  if (url.pathname === "/api/clients" && req.method === "GET") { json(res, 200, listClients()); return; }

  // GET /api/clients/by-email?email= — which client owns this address (used to match inbound email)
  if (url.pathname === "/api/clients/by-email" && req.method === "GET") {
    const c = getClientByEmail(url.searchParams.get("email"));
    if (!c) { json(res, 404, { error: "no client with that email" }); return; }
    json(res, 200, { id: c.id, name: c.name, email: c.email });
    return;
  }

  // POST /api/clients — create a new client. The roster isn't fixed to the
  // 10 built-in demo cases; this is how a real one gets added.
  if (url.pathname === "/api/clients" && req.method === "POST") {
    const body = await readBody(req);
    const input = body ? JSON.parse(body) : {};
    const result = createClient(input);
    if (!result.ok) { json(res, 400, result); return; }
    json(res, 200, { ok: true, client: result.client });
    return;
  }

  // POST /api/clients/:id/accounts — add a chart-of-accounts entry
  if (parts[0] === "api" && parts[1] === "clients" && parts[3] === "accounts" && req.method === "POST") {
    const client = getClient(decodeURIComponent(parts[2]));
    if (!client) { json(res, 404, { error: "no such client" }); return; }
    const body = await readBody(req);
    const result = addAccount(client, body ? JSON.parse(body) : {});
    json(res, result.ok ? 200 : 400, result);
    return;
  }

  // POST /api/clients/:id/documents — add a real document (XML or CSV text)
  // and derive a new line from it. { format: "xml"|"csv", content: "..." }
  if (parts[0] === "api" && parts[1] === "clients" && parts[3] === "documents" && req.method === "POST") {
    const client = getClient(decodeURIComponent(parts[2]));
    if (!client) { json(res, 404, { error: "no such client" }); return; }
    const body = await readBody(req);
    const { format, content } = body ? JSON.parse(body) : {};
    if (!content) { json(res, 400, { error: "content is required" }); return; }
    const result = format === "csv" ? addDocumentsFromCsv(client, content) : addDocumentFromXml(client, content);
    json(res, result.ok ? 200 : 400, result);
    return;
  }

  // POST /api/clients/:id/attachments — add a real PDF (or other) supporting
  // document. { filename, contentBase64, kind, lineId }
  if (parts[0] === "api" && parts[1] === "clients" && parts[3] === "attachments" && parts.length === 4 && req.method === "POST") {
    const client = getClient(decodeURIComponent(parts[2]));
    if (!client) { json(res, 404, { error: "no such client" }); return; }
    const body = await readBody(req);
    const result = await addAttachment(client, body ? JSON.parse(body) : {});
    json(res, result.ok ? 200 : 400, result);
    return;
  }

  // ---- Fixing what validation found --------------------------------------
  // PATCH /api/clients/:id            { changes: { email, piva, name, ... }, reason }
  // PATCH /api/clients/:id/lines/:lid { changes: { vat, account, piva, ... }, reason }
  // Validated, audit-logged, persisted. Editing a validated batch sends it back to re-validation.
  if (parts[0] === "api" && parts[1] === "clients" && req.method === "PATCH" && (parts.length === 3 || (parts.length === 5 && parts[3] === "lines"))) {
    const client = getClient(decodeURIComponent(parts[2]));
    if (!client) { json(res, 404, { error: "no such client" }); return; }
    const body = await readBody(req);
    const { changes, reason, by } = body ? JSON.parse(body) : {};
    const isLine = parts.length === 5;
    if (isLine && periodStage(client.id, client.period) === "filed") {
      json(res, 409, { error: `${client.period} is already filed — a correction now needs a new submission, not an edit` });
      return;
    }
    const result = isLine ? editLine(client, decodeURIComponent(parts[4]), changes, { reason, by }) : editClient(client, changes, { reason, by });
    if (!result.ok) { json(res, result.status || 400, result); return; }
    let workflow = null;
    if (result.changed.length) {
      const summary = result.changed.map((c) => `${c.target}.${c.field}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`).join("; ");
      workflow = isLine ? noteEdit(client.id, client.period, summary) : null;
    }
    json(res, 200, { ...result, workflow });
    return;
  }

  // GET /api/clients/:id/edits — the audit trail; POST .../edits/revert — undo all edits
  if (parts[0] === "api" && parts[1] === "clients" && parts[3] === "edits") {
    const client = getClient(decodeURIComponent(parts[2]));
    if (!client) { json(res, 404, { error: "no such client" }); return; }
    if (req.method === "GET") { json(res, 200, getEditLog(client.id)); return; }
    if (req.method === "POST" && parts[4] === "revert") {
      if (periodStage(client.id, client.period) === "filed") { json(res, 409, { error: `${client.period} is already filed — edits can no longer be reverted` }); return; }
      const r = revertEdits(client);
      noteEdit(client.id, client.period, `all ${r.reverted} edit(s) reverted`);
      json(res, 200, r);
      return;
    }
  }

  // GET/POST /api/clients/:id/email — email the client from here. Delivery and the
  // sent/received thread live in Agent Desk's email channel; this is the studio's way in.
  if (parts[0] === "api" && parts[1] === "clients" && parts[3] === "email" && parts.length === 4) {
    const client = getClient(decodeURIComponent(parts[2]));
    if (!client) { json(res, 404, { error: "no such client" }); return; }
    try {
      if (req.method === "GET") {
        const r = await fetch(`${AGENT_DESK_URL}/api/email/messages?client=${encodeURIComponent(client.id)}`, { headers: serviceAuthHeaders(), signal: AbortSignal.timeout(5000) });
        json(res, 200, { email: client.email, messages: r.ok ? await r.json() : [], unavailable: !r.ok });
        return;
      }
      if (req.method === "POST") {
        const { subject, body: text } = JSON.parse((await readBody(req)) || "{}");
        if (!subject || !text) { json(res, 400, { error: "subject and body are required" }); return; }
        const r = await fetch(`${AGENT_DESK_URL}/api/email/send`, {
          method: "POST", headers: { "Content-Type": "application/json", ...serviceAuthHeaders() },
          body: JSON.stringify({ clientId: client.id, subject, body: text }), signal: AbortSignal.timeout(15000),
        });
        const data = await r.json().catch(() => ({}));
        json(res, r.ok ? 200 : 502, r.ok ? { ok: true, record: data.record } : { error: data.error || `Agent Desk answered ${r.status}` });
        return;
      }
    } catch (e) {
      if (req.method === "GET") { json(res, 200, { email: client.email, messages: [], unavailable: true }); return; }
      json(res, 502, { error: `Agent Desk not reachable at ${AGENT_DESK_URL} (${e.message})` });
      return;
    }
  }

  // GET /api/clients/:id — one client's master data + chart of accounts
  if (parts[0] === "api" && parts[1] === "clients" && parts.length === 3) {
    const client = getClient(decodeURIComponent(parts[2]));
    if (!client) { json(res, 404, { error: "no such client" }); return; }
    const { lines, priorLines, ...rest } = client;
    json(res, 200, rest);
    return;
  }

  // GET /api/clients/:id/batch?period=2026-Q3 — the VAT batch (current or prior)
  if (parts[0] === "api" && parts[1] === "clients" && parts[3] === "batch") {
    const client = getClient(decodeURIComponent(parts[2]));
    if (!client) { json(res, 404, { error: "no such client" }); return; }
    const wantPeriod = url.searchParams.get("period") || client.period;
    if (wantPeriod === client.priorPeriod) {
      json(res, 200, { period: client.priorPeriod, client: client.id, kind: "LIPE", lines: client.priorLines || [], expected: [] });
      return;
    }
    json(res, 200, { period: client.period, client: client.id, kind: "LIPE", lines: client.lines, expected: client.expected || [] });
    return;
  }

  // GET /api/clients/:id/source — the RAW feed, in whatever format this
  // client's data actually arrives in (client.sourceFormat: xml/csv/json).
  // This is what Agent Desk's ingestion pipeline is meant to fetch and
  // parse — not the already-canonical /batch endpoint above, which exists
  // for the mock's own UI and for convenience, not as the real intake path.
  if (parts[0] === "api" && parts[1] === "clients" && parts[3] === "source") {
    const client = getClient(decodeURIComponent(parts[2]));
    if (!client) { json(res, 404, { error: "no such client" }); return; }
    if (client.sourceFormat === "csv") {
      res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" }).end(toRawCsv(client));
      return;
    }
    if (client.sourceFormat === "xml") {
      // one XML document per line, concatenated with a separator — a real
      // feed would deliver these as separate files; this keeps it to one
      // request for the mock without pretending it's a single valid XML doc.
      const xmls = client.lines.map((l) => toFatturaPaXml(client, l));
      res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8" })
        .end(xmls.join("\n<!-- ===NEXT-DOCUMENT=== -->\n"));
      return;
    }
    json(res, 200, toRawJsonFeed(client));
    return;
  }

  // GET /api/clients/:id/attachments — list of supporting-document metadata
  if (parts[0] === "api" && parts[1] === "clients" && parts[3] === "attachments" && parts.length === 4) {
    const client = getClient(decodeURIComponent(parts[2]));
    if (!client) { json(res, 404, { error: "no such client" }); return; }
    json(res, 200, client.attachments || []);
    return;
  }

  // GET /api/clients/:id/attachments/:docId — the actual PDF bytes
  if (parts[0] === "api" && parts[1] === "clients" && parts[3] === "attachments" && parts.length === 5) {
    const client = getClient(decodeURIComponent(parts[2]));
    const att = client?.attachments?.find((a) => a.docId === decodeURIComponent(parts[4]));
    if (!att) { json(res, 404, { error: "no such attachment" }); return; }
    try {
      const body = await readFile(attachmentPath(att.filename));
      res.writeHead(200, { "Content-Type": "application/pdf" }).end(body);
    } catch { json(res, 404, { error: "attachment file missing on disk" }); }
    return;
  }

  // POST /api/clients/:id/writeback — Agent Desk reports a filing status
  // back into the ledger. This is the real receiving end of the "written
  // back into TeamSystem" message in the demo feed.
  if (parts[0] === "api" && parts[1] === "clients" && parts[3] === "writeback" && req.method === "POST") {
    const clientId = decodeURIComponent(parts[2]);
    const client = getClient(clientId);
    if (!client) { json(res, 404, { error: "no such client" }); return; }
    const body = await readBody(req);
    const { period: periodId, status, summary, deadline, tailCount, anomalyCount, openItems } = body ? JSON.parse(body) : {};
    if (!periodId) { json(res, 400, { error: "period is required" }); return; }
    const rec = {
      period: periodId, status: status || "unknown", summary: summary || null, deadline: deadline || null,
      tailCount: tailCount ?? null, anomalyCount: anomalyCount ?? null,
      openItems: Array.isArray(openItems) ? openItems : [], at: new Date().toISOString(),
    };
    // The write-back is not just stored: the status drives what TeamSystem
    // does next (tasks for the studio, client requests, reminders).
    const outcome = applyWriteBack(client, rec);
    dispatchEmails(client, outcome.period, outcome.newMessages || []).catch(() => {});
    console.log(`[writeback] received for ${clientId}: ${status} (${periodId}) -> stage ${outcome.stage}, ${outcome.nextSteps.length} next step(s)`);
    json(res, 200, { ok: true, clientId, ...rec, workflow: outcome });
    return;
  }

  // GET /api/clients/:id/writeback — everything received for this client, for verification/UI
  if (parts[0] === "api" && parts[1] === "clients" && parts[3] === "writeback" && req.method === "GET") {
    json(res, 200, getWriteBacks(decodeURIComponent(parts[2])));
    return;
  }

  // GET /api/clients/:id/workflow — tasks, client outbox, reminders, stage and
  // timeline per period: what TeamSystem did (and is waiting on) after the write-backs.
  if (parts[0] === "api" && parts[1] === "clients" && parts[3] === "workflow" && parts.length === 4 && req.method === "GET") {
    const clientId = decodeURIComponent(parts[2]);
    if (!getClient(clientId)) { json(res, 404, { error: "no such client" }); return; }
    json(res, 200, getWorkflow(clientId));
    return;
  }

  // POST /api/clients/:id/workflow/:period/(tasks/:taskId/complete | sign | transmit | revalidate)
  if (parts[0] === "api" && parts[1] === "clients" && parts[3] === "workflow" && parts.length >= 6 && req.method === "POST") {
    const client = getClient(decodeURIComponent(parts[2]));
    if (!client) { json(res, 404, { error: "no such client" }); return; }
    const period = decodeURIComponent(parts[4]);
    const action = parts[5];
    let result;
    if (action === "tasks" && parts[7] === "complete") result = completeTask(client.id, period, decodeURIComponent(parts[6]));
    else if (action === "sign") { const b = await readBody(req); result = sign(client.id, period, (b ? JSON.parse(b) : {}).signedBy); }
    else if (action === "transmit") result = transmit(client, period);
    else if (action === "revalidate") {
      // Hand the client back to Agent Desk to run validation again.
      try {
        const r = await fetch(`${AGENT_DESK_URL}/api/run-demo?client=${encodeURIComponent(client.id)}`, { headers: serviceAuthHeaders(), signal: AbortSignal.timeout(3000) });
        result = r.ok ? { ok: true, started: true } : { ok: false, status: 502, error: `Agent Desk answered ${r.status}` };
      } catch (e) { result = { ok: false, status: 502, error: `Agent Desk not reachable at ${AGENT_DESK_URL} (${e.message})` }; }
    } else { json(res, 404, { error: "unknown workflow action" }); return; }
    json(res, result.ok ? 200 : (result.status || 400), result);
    return;
  }

  // POST /api/workflow/run-due-reminders?asOf=YYYY-MM-DD — fire reminders that are due
  if (url.pathname === "/api/workflow/run-due-reminders" && req.method === "POST") {
    const fired = fireDueReminders(url.searchParams.get("asOf") || undefined);
    for (const f of fired) if (f.message && getClient(f.clientId)) dispatchEmails(getClient(f.clientId), f.period, [f.message]).catch(() => {});
    json(res, 200, { fired: fired.map(({ message, ...rest }) => rest) });
    return;
  }

  // GET /api/clients/:id/invoices/:lineId/xml — FatturaPA-shaped XML for one line
  if (parts[0] === "api" && parts[1] === "clients" && parts[3] === "invoices" && parts[5] === "xml") {
    const client = getClient(decodeURIComponent(parts[2]));
    if (!client) { json(res, 404, { error: "no such client" }); return; }
    const line = client.lines.find((l) => l.id === decodeURIComponent(parts[4]));
    if (!line) { json(res, 404, { error: "no such invoice line" }); return; }
    res.writeHead(200, { "Content-Type": "application/xml" }).end(toFatturaPaXml(client, line));
    return;
  }

  // Front-end libraries are served from node_modules, not a public CDN: works offline and in locked-down networks.
  const VENDOR = { "/vendor/react.production.min.js": "react/umd/react.production.min.js", "/vendor/react-dom.production.min.js": "react-dom/umd/react-dom.production.min.js", "/vendor/babel.min.js": "@babel/standalone/babel.min.js" };
  if (VENDOR[url.pathname] && req.method === "GET") {
    try {
      const body = await readFile(join(here, "..", "node_modules", VENDOR[url.pathname]));
      res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "public, max-age=86400" }).end(body);
    } catch { res.writeHead(404).end("Not found"); }
    return;
  }

  // static frontend
  let p = url.pathname === "/" ? "/index.html" : url.pathname;
  try {
    const filePath = resolve(pub, "." + decodeURIComponent(p));
    if (!filePath.startsWith(resolve(pub) + sep)) { res.writeHead(404).end("Not found"); return; } // no path traversal out of frontend/
    const body = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[extname(p)] || "application/octet-stream", "Cache-Control": "no-store" }).end(body);
  } catch { res.writeHead(404).end("Not found"); }
}

server.listen(PORT, listenHost(), () => console.log(`TeamSystem Firm mock on http://${listenHost()}:${PORT} — ${clients.length} clients`));
