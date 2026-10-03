// backend/connectors/teamSystem.mjs
// TeamSystem connector — now backed by a real HTTP pipeline to the
// TeamSystem Firm mock (../../../teamsystem-firm-mock), which plays the
// studio's own IT system: 10 real clients, real VAT batches, FatturaPA-
// shaped XML. If that service isn't running, every function falls back to
// the single local fixture client (seed.mjs) with a console warning, so
// `npm start` here still works standalone for anyone who hasn't started the
// mock service — same graceful-degradation pattern as the FiC connector's
// offline stub.
//
// Per the brief, Fatture in Cloud is one of TeamSystem's own systems (not a
// separate integration) — so reading a batch here also cross-checks each
// line through the Fatture in Cloud connector.
// >>> TODO (real): replace the TeamSystem Firm mock with TeamSystem's actual
//     ledger API once it's available — keep these function signatures so
//     nothing downstream (validator.mjs, vatFilingPath.mjs) has to change.
import { vatBatch, priorPeriodBatch, period, client, chartOfAccounts } from "../seed.mjs";
import * as fattureInCloud from "./fattureInCloud.mjs";
import * as ingestion from "../ingestion.mjs";
import { serviceAuthHeaders } from "../security.mjs";

const TS_FIRM_URL = process.env.TS_FIRM_URL || "http://127.0.0.1:5680";
const DEFAULT_CLIENT_ID = client.id;
const writeBackLog = []; // in-memory ledger of what's been written back this session

async function tsFirm(path, { method = "GET", body, timeoutMs = 2000 } = {}) {
  const res = await fetch(`${TS_FIRM_URL}${path}`, {
    method,
    headers: { ...serviceAuthHeaders(), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`TS Firm mock ${path} -> ${res.status}`);
  return res.json();
}

function fixtureFallback(reason, clientId) {
  console.warn(`[TeamSystem] firm mock unreachable (${reason}) — using the single local fixture client instead of ${clientId}`);
}

/** Every client the TeamSystem Firm mock knows about — the roster for a
 *  client picker. Falls back to the one local fixture client. */
export async function listClients() {
  try {
    return await tsFirm("/api/clients");
  } catch (e) {
    fixtureFallback(e.message, "(listing)");
    return [{ id: client.id, name: client.name, regime: client.regime, ateco: client.ateco, piva: client.piva, period, lineCount: vatBatch.lines.length }];
  }
}

/** The client's master data (tax IDs, regime, ATECO, VAT-Group membership) —
 *  Rulebook Table "Parameter". */
export async function readMasterData(clientId = DEFAULT_CLIENT_ID) {
  try {
    return await tsFirm(`/api/clients/${encodeURIComponent(clientId)}`);
  } catch (e) {
    fixtureFallback(e.message, clientId);
    return { ...client, id: clientId };
  }
}

/** The client's chart of accounts + VAT codes — the rate<->category table
 *  vatRules.mjs checks every line against (Rulebook Section 6.2). */
export async function readChartOfAccounts(clientId = DEFAULT_CLIENT_ID) {
  const master = await readMasterData(clientId);
  if (master.chartOfAccounts) return master.chartOfAccounts.map((c) => ({ ...c }));
  return chartOfAccounts.map((c) => ({ ...c }));
}

function stripUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

/** Stage 1+2 for real: fetch this client's RAW feed in whatever format it
 *  actually arrives in (XML / CSV / Italian-labelled JSON), register it
 *  (Ingestion), and parse it into the canonical shape (Normalisation).
 *  Returns { byLineId: Map, format, anomalies } — anomalies is FMT-01 if
 *  the raw payload didn't parse. Never throws: a raw-ingestion failure is a
 *  real finding (FMT-01), not a crash. */
async function ingestAndNormalise(clientId, format) {
  const path = `/api/clients/${encodeURIComponent(clientId)}/source`;
  let raw;
  try {
    const res = await fetch(`${TS_FIRM_URL}${path}`, { headers: serviceAuthHeaders(), signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    raw = await res.text();
  } catch (e) {
    // service unreachable — not a data-quality problem, just no real
    // ingestion for this run (same graceful-degradation as everything else)
    fixtureFallback(e.message, clientId);
    return { byLineId: new Map(), anomalies: [] };
  }

  const rec = ingestion.ingest({ source: "TeamSystem Firm mock", channel: format === "xml" ? "e-invoice-feed" : format === "csv" ? "file-feed" : "api-feed", clientId, raw, format });
  const byLineId = new Map();
  try {
    if (format === "csv") {
      for (const row of ingestion.parseCsv(raw)) byLineId.set(row.id_riga, stripUndefined(ingestion.normaliseCsvRow(row)));
    } else if (format === "xml") {
      for (const doc of ingestion.splitXmlFeed(raw)) {
        const n = ingestion.normaliseXmlDocument(doc);
        const lineId = n.docNumber ? n.docNumber.split("-").pop() : null;
        if (lineId) byLineId.set(lineId, stripUndefined(n));
      }
    } else {
      const feed = JSON.parse(raw);
      for (const row of feed.righe || []) byLineId.set(row.id_riga, stripUndefined(ingestion.normaliseJsonRow(row)));
    }
    return { byLineId, anomalies: [], ingestionId: rec.id };
  } catch (e) {
    // FMT-01: the file/record arrived but does not parse — a real defect,
    // not a fallback case.
    return { byLineId: new Map(), anomalies: [{ ruleId: "FMT-01", severity: "Blocking", kind: "parse_failure", message: `${clientId}: raw ${format} feed failed to parse — ${e.message}` }], ingestionId: rec.id };
  }
}

/** Ingest each of the client's unstructured supporting documents (PDFs) —
 *  the third format the Rulebook's dataset spec names, alongside XML and
 *  CSV/JSON. Real bytes, real content hash, really registered. Doesn't
 *  attempt to read the PDF's content (that's a much bigger job); this
 *  proves the ingestion stage handles unstructured documents at all. */
async function ingestAttachments(clientId) {
  try {
    const list = await tsFirm(`/api/clients/${encodeURIComponent(clientId)}/attachments`);
    for (const att of list) {
      const res = await fetch(`${TS_FIRM_URL}/api/clients/${encodeURIComponent(clientId)}/attachments/${encodeURIComponent(att.docId)}`, { headers: serviceAuthHeaders(), signal: AbortSignal.timeout(2000) });
      if (!res.ok) continue;
      const bytes = Buffer.from(await res.arrayBuffer());
      ingestion.ingest({ source: "TeamSystem Firm mock", channel: "attachment-upload", clientId, raw: bytes, format: "pdf" });
    }
  } catch (e) {
    fixtureFallback(e.message, `${clientId} (attachments)`);
  }
}

/** TeamSystem hands over the batch it compiled from the ledger for this
 *  client/period. Each line is then: (a) re-derived from the REAL raw feed
 *  via Ingestion + Normalisation, where that changes something the raw
 *  format actually carries, and (b) cross-checked through Fatture in Cloud
 *  — TeamSystem's own ledger snapshot and the raw feed and Fatture in Cloud
 *  are three different sources, used together, not one pretending to be all three. */
export async function readVatBatch(clientId = DEFAULT_CLIENT_ID, periodId) {
  let batch;
  try {
    const q = periodId ? `?period=${encodeURIComponent(periodId)}` : "";
    batch = await tsFirm(`/api/clients/${encodeURIComponent(clientId)}/batch${q}`);
  } catch (e) {
    fixtureFallback(e.message, clientId);
    batch = {
      ...vatBatch, period: periodId || period, client: clientId,
      lines: vatBatch.lines.map((l) => ({ ...l })), expected: (vatBatch.expected || []).map((x) => ({ ...x })),
    };
  }

  const master = await readMasterData(clientId);
  const { byLineId, anomalies: formatAnomalies } = await ingestAndNormalise(clientId, master.sourceFormat || "json");
  await ingestAttachments(clientId);

  const lines = await Promise.all(batch.lines.map(async (l) => {
    const normalised = byLineId.get(l.id);
    const merged = normalised ? { ...l, ...normalised, id: l.id } : l;
    return { ...merged, fic: await fattureInCloud.readInvoice(l.supplier) };
  }));
  return { ...batch, lines, formatAnomalies };
}

/** The same client's prior period, for the validator's prior-period comparison. */
export async function readPriorPeriod(clientId = DEFAULT_CLIENT_ID) {
  const master = await readMasterData(clientId);
  const priorPeriodId = master.priorPeriod;
  if (!priorPeriodId) return { period: null, client: clientId, kind: "LIPE", lines: [] };
  try {
    return await tsFirm(`/api/clients/${encodeURIComponent(clientId)}/batch?period=${encodeURIComponent(priorPeriodId)}`);
  } catch (e) {
    fixtureFallback(e.message, clientId);
    return { ...priorPeriodBatch, client: clientId, lines: priorPeriodBatch.lines.map((l) => ({ ...l })) };
  }
}

/** Write the filing status back into the ledger — a real POST to the
 *  TeamSystem Firm mock, not just a local log entry, carrying a real
 *  computed deadline and a plain-language summary (not a bare status code).
 *  `details` is { status, summary, deadline, tailCount, anomalyCount }.
 *  Falls back to the local-only log if the mock isn't reachable, so a
 *  demo run still completes — but the fallback is visibly logged, precisely
 *  so "written back into TeamSystem" is never claimed when it didn't happen. */
export async function writeBack(clientId, periodId, details) {
  const body = { period: periodId, ...details };
  try {
    const rec = await tsFirm(`/api/clients/${encodeURIComponent(clientId)}/writeback`, { method: "POST", body });
    return { ok: true, ...rec, deliveredToFirm: true };
  } catch (e) {
    fixtureFallback(e.message, clientId);
    const rec = { client: clientId, ...body, at: new Date().toISOString() };
    writeBackLog.push(rec);
    return { ok: true, ...rec, deliveredToFirm: false };
  }
}

/** Save a corrected contact detail (email / phone) back into the client's TeamSystem record. */
export async function updateClientContact(clientId, changes) {
  return tsFirm(`/api/clients/${encodeURIComponent(clientId)}`, { method: "PATCH", body: { changes, reason: "updated while contacting the client from Agent Desk", by: "agent_desk" } });
}

/** Which client owns this email address? null if none (or TeamSystem is unreachable). */
export async function findClientByEmail(email) {
  try { return await tsFirm(`/api/clients/by-email?email=${encodeURIComponent(email)}`); }
  catch { return null; }
}

/** File a document received by email into the client's TeamSystem record,
 *  through the same endpoints the studio's own uploads use: PDF -> attachment,
 *  XML/CSV -> parsed into invoice line(s). Returns { summary }. */
export async function deliverInboundDocument(clientId, { filename, ext, content }) {
  const base = `/api/clients/${encodeURIComponent(clientId)}`;
  if (ext === "pdf") {
    const r = await tsFirm(`${base}/attachments`, { method: "POST", timeoutMs: 15000, body: { filename, contentBase64: Buffer.from(content).toString("base64"), kind: "supporting_document" } });
    return { summary: r.line ? `stored as ${r.docId}, read as invoice line ${r.line.id} (${r.line.supplier})` : `stored as ${r.docId} (supporting evidence)` };
  }
  const r = await tsFirm(`${base}/documents`, { method: "POST", timeoutMs: 15000, body: { format: ext, content: Buffer.from(content).toString("utf8") } });
  return { summary: ext === "csv" ? `added ${r.added.length} invoice line(s)` : `added invoice line ${r.line.id} (${r.line.supplier})` };
}

/** What TeamSystem did after the write-backs (tasks, client requests, stage). */
export async function readWorkflow(clientId) {
  try { return await tsFirm(`/api/clients/${encodeURIComponent(clientId)}/workflow`); }
  catch { return { writeBacks: [], periods: [], unavailable: true }; }
}

/** For tests/inspection: everything written back this session. */
export function history() { return writeBackLog.slice(); }

/** For tests/inspection: every raw item ingested this session (Stage 1). */
export function ingestionHistory(clientId) { return ingestion.history(clientId); }
