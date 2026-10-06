// backend/ingestion.mjs
// The two pipeline stages the Rulebook's Section 3 names first, and that
// were previously entirely missing: every client's data used to arrive
// already pre-shaped as a JS object, so there was nothing to actually
// ingest or normalise. Now there is — real FatturaPA-shaped XML, a real
// CSV feed (Italian dates/decimals), and a real Italian-labelled JSON feed,
// served raw by the TeamSystem Firm mock.
//
// 1. Ingestion  — capture provenance metadata (source, channel, clientId,
//    timestamp), compute a content hash, and REGISTER the item — all before
//    anything is parsed out of it.
// 2. Normalisation — convert the raw, format-specific payload into the one
//    canonical line shape the validator expects, harmonising encodings,
//    date/number formats and currency along the way.
import { createHash } from "node:crypto";

const registry = []; // in-memory; every raw item ingested this session

/** Stage 1 — Ingestion. */
export function ingest({ source, channel, clientId, raw, format }) {
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  const rec = {
    id: `ing_${registry.length + 1}`, source, channel, clientId, format, hash,
    byteLength: Buffer.byteLength(raw, "utf8"), capturedAt: new Date().toISOString(),
  };
  registry.push(rec);
  return rec;
}

export function history(clientId) {
  return clientId ? registry.filter((r) => r.clientId === clientId) : registry.slice();
}

// ---- Stage 2 — Normalisation --------------------------------------------

function parseItNumber(s) {
  if (s === "" || s == null) return null;
  return Number(String(s).replace(/\./g, "").replace(",", "."));
}
function parseItDate(s) {
  if (!s) return null;
  const [d, m, y] = String(s).split("/");
  if (!d || !m || !y) return null;
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

/** Normalise one row of the Italian-labelled JSON feed (decimal commas,
 *  DD/MM/YYYY dates, Italian field names) into the canonical line shape. */
export function normaliseJsonRow(row) {
  return {
    id: row.id_riga, supplier: row.fornitore, desc: row.descrizione,
    net: parseItNumber(row.imponibile), vat: parseItNumber(row.iva), account: row.conto || undefined,
    confidence: row.affidabilita, date: parseItDate(row.data_fattura),
    invoiceDate: row.data_consegna ? parseItDate(row.data_fattura) : undefined,
    supplyDate: row.data_consegna ? parseItDate(row.data_consegna) : undefined,
    natura: row.natura || undefined, piva: row.partita_iva_fornitore || undefined,
    docNumber: row.numero_documento || undefined, lineNumber: row.numero_riga ?? undefined,
    splitPayment: row.scissione_pagamenti || undefined, legalWording: row.dicitura_legale || undefined,
    requiresEvidence: row.evidenza_richiesta || undefined, evidenceAttached: row.evidenza_allegata || undefined,
    counterpartyCfUsed: row.cf_controparte_usato || undefined,
  };
}

/** Normalise one CSV row (already split into a header-keyed object). An
 *  empty date cell normalises to `null` (genuinely missing), not undefined
 *  (not tracked) — that distinction is what lets CON-01 fire on real data
 *  instead of a hand-set flag. */
export function normaliseCsvRow(row) {
  return {
    id: row.id_riga, supplier: row.fornitore, desc: row.descrizione,
    net: parseItNumber(row.imponibile), vat: parseItNumber(row.iva), account: row.conto || undefined,
    confidence: row.affidabilita ? Number(row.affidabilita) : undefined,
    date: row.data_fattura ? parseItDate(row.data_fattura) : null,
  };
}

/** Parses one CSV document's text into header-keyed row objects. Minimal on
 *  purpose — this is our own generated feed's shape, not a general CSV
 *  parser — but it IS genuinely quote-aware: Italian-format numbers like
 *  "4.500,00" get quoted by the mock precisely because they contain a comma,
 *  and a comma inside quotes must not split the row. (An earlier version of
 *  this function computed a quote-aware split and then didn't use it —
 *  caught by actually running the demo against Marino Incompleto's CSV feed
 *  live, not by a unit test with no quoted fields in it.) */
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === "," && !inQuotes) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}
export function parseCsv(text) {
  const [headerLine, ...lines] = text.trim().split("\n");
  const headers = parseCsvLine(headerLine);
  return lines.filter(Boolean).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = values[i] ?? ""; });
    return row;
  });
}

/** Very small, honest XML field-extractor for OUR OWN generated FatturaPA-
 *  shaped XML — not a general XML parser, and not XSD validation. Confirms
 *  ingestion can genuinely parse a real e-invoice document; real XSD
 *  validation is Il Verificatore's job once it exists. */
export function normaliseXmlDocument(xml) {
  const tag = (name) => { const m = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`)); return m ? m[1] : null; };
  const supplierMatch = xml.match(/<CedentePrestatore>[\s\S]*?<Denominazione>([^<]*)<\/Denominazione>/);
  const net = tag("PrezzoTotale");
  const rate = tag("AliquotaIVA");
  const netNum = net != null ? Number(net) : null;
  const rateNum = rate != null ? Number(rate) : null;
  const docType = tag("TipoDocumento");
  return {
    supplier: supplierMatch ? supplierMatch[1] : null,
    desc: tag("Descrizione"),
    net: netNum, vat: netNum != null && rateNum != null ? Math.round(netNum * (rateNum / 100) * 100) / 100 : null,
    date: tag("Data"), natura: tag("Natura") || undefined,
    docNumber: tag("Numero") || undefined,
    lineNumber: tag("NumeroLinea") ? Number(tag("NumeroLinea")) : undefined,
    docType: docType || undefined,
    piva: (xml.match(/<CedentePrestatore>[\s\S]*?<IdCodice>([^<]*)<\/IdCodice>/) || [])[1] || undefined,
  };
}

/** Splits the mock's multi-document XML feed (one FatturaPA doc per invoice
 *  line, concatenated) back into individual documents. */
export function splitXmlFeed(text) {
  return text.split("<!-- ===NEXT-DOCUMENT=== -->").map((s) => s.trim()).filter(Boolean);
}
