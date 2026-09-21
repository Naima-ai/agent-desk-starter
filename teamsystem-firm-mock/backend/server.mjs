// backend/server.mjs — TeamSystem Firm mock: the studio's own IT system,
// standing in for the real TeamSystem/gestionale + Fatture in Cloud until a
// real connector exists. Zero-framework HTTP, same style as agent-desk-starter.
// Holds 10 clients' worth of VAT batches and serves them — plus a FatturaPA-
// shaped XML per invoice line — over a small HTTP API, and a browsing UI.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { clients, getClient, listClients } from "./data/clients.mjs";
import { toFatturaPaXml } from "./xmlGenerator.mjs";
import { toRawJsonFeed, toRawCsv } from "./rawFeeds.mjs";
import { createClient, addAccount, addDocumentFromXml, addDocumentsFromCsv, addAttachment } from "./adminActions.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, "..", "frontend");
const PORT = process.env.PORT || 5680;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

// Filing status write-backs actually received from Agent Desk, per client —
// in-memory, resets on restart. This is what proves the "written back into
// TeamSystem" message in the demo is a real HTTP call reaching this service,
// not just a line of text on the other side.
const writeBacks = new Map(); // clientId -> [{ period, status, at }]

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }).end(JSON.stringify(body));
}

function readBody(req) {
  // Collect raw Buffer chunks and decode ONCE at the end, explicitly as
  // UTF-8. Concatenating chunks into a string with `data += chunk` coerces
  // each Buffer independently and can also split a multi-byte UTF-8
  // character across two chunks — either way it corrupts non-ASCII text
  // (caught for real: the em dash in a write-back summary came out as
  // mojibake, "â€”", until this was fixed).
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

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
    if (!res.headersSent) json(res, 500, { error: "internal error", detail: e.message });
  }
});

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean);

  // GET /api/clients — the roster
  if (url.pathname === "/api/clients" && req.method === "GET") { json(res, 200, listClients()); return; }

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
      res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Access-Control-Allow-Origin": "*" }).end(toRawCsv(client));
      return;
    }
    if (client.sourceFormat === "xml") {
      // one XML document per line, concatenated with a separator — a real
      // feed would deliver these as separate files; this keeps it to one
      // request for the mock without pretending it's a single valid XML doc.
      const xmls = client.lines.map((l) => toFatturaPaXml(client, l));
      res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8", "Access-Control-Allow-Origin": "*" })
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
      const body = await readFile(join(here, "attachments", att.filename));
      res.writeHead(200, { "Content-Type": "application/pdf", "Access-Control-Allow-Origin": "*" }).end(body);
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
    const { period: periodId, status, summary, deadline, tailCount, anomalyCount } = body ? JSON.parse(body) : {};
    const rec = {
      period: periodId, status: status || "unknown", summary: summary || null, deadline: deadline || null,
      tailCount: tailCount ?? null, anomalyCount: anomalyCount ?? null, at: new Date().toISOString(),
    };
    if (!writeBacks.has(clientId)) writeBacks.set(clientId, []);
    writeBacks.get(clientId).push(rec);
    console.log(`[writeback] received for ${clientId}: ${status} (${periodId})${deadline ? `, deadline ${deadline}` : ""}`);
    json(res, 200, { ok: true, clientId, ...rec });
    return;
  }

  // GET /api/clients/:id/writeback — everything received for this client, for verification/UI
  if (parts[0] === "api" && parts[1] === "clients" && parts[3] === "writeback" && req.method === "GET") {
    const clientId = decodeURIComponent(parts[2]);
    json(res, 200, writeBacks.get(clientId) || []);
    return;
  }

  // GET /api/clients/:id/invoices/:lineId/xml — FatturaPA-shaped XML for one line
  if (parts[0] === "api" && parts[1] === "clients" && parts[3] === "invoices" && parts[5] === "xml") {
    const client = getClient(decodeURIComponent(parts[2]));
    if (!client) { json(res, 404, { error: "no such client" }); return; }
    const line = client.lines.find((l) => l.id === decodeURIComponent(parts[4]));
    if (!line) { json(res, 404, { error: "no such invoice line" }); return; }
    res.writeHead(200, { "Content-Type": "application/xml", "Access-Control-Allow-Origin": "*" }).end(toFatturaPaXml(client, line));
    return;
  }

  // static frontend
  let p = url.pathname === "/" ? "/index.html" : url.pathname;
  try {
    const body = await readFile(join(pub, p));
    res.writeHead(200, { "Content-Type": MIME[extname(p)] || "application/octet-stream", "Cache-Control": "no-store" }).end(body);
  } catch { res.writeHead(404).end("Not found"); }
}

server.listen(PORT, () => console.log(`TeamSystem Firm mock on http://localhost:${PORT} — ${clients.length} clients`));
