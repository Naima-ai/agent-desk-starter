// backend/rawFeeds.mjs — converts a client's canonical line data into the
// RAW wire formats a real feed would actually arrive in: Italian-labelled
// JSON (decimal commas, DD/MM/YYYY dates — a realistic pre-filled-register
// export), and CSV with the same conventions. This is deliberately NOT the
// same shape as the canonical internal model — Agent Desk's ingestion +
// normalisation pipeline has to do real conversion work, not a passthrough.
function itNumber(n) {
  return n == null ? "" : n.toFixed(2).replace(".", ",");
}
function itDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

export function toRawJsonFeed(client) {
  return {
    cliente: client.name, partita_iva_cliente: client.piva, periodo: client.period,
    righe: client.lines.map((l) => ({
      id_riga: l.id, fornitore: l.supplier, descrizione: l.desc,
      imponibile: itNumber(l.net), iva: itNumber(l.vat), conto: l.account,
      affidabilita: l.confidence, data_fattura: itDate(l.date || l.invoiceDate),
      data_consegna: itDate(l.supplyDate), natura: l.natura || null,
      partita_iva_fornitore: l.piva || null, numero_documento: l.docNumber || null,
      numero_riga: l.lineNumber ?? null, scissione_pagamenti: Boolean(l.splitPayment),
      dicitura_legale: l.legalWording || null, evidenza_richiesta: Boolean(l.requiresEvidence),
      evidenza_allegata: Boolean(l.evidenceAttached), cf_controparte_usato: l.counterpartyCfUsed || null,
    })),
  };
}

export function toRawCsv(client) {
  const cols = ["id_riga", "fornitore", "descrizione", "imponibile", "iva", "conto", "affidabilita", "data_fattura"];
  const rows = client.lines.map((l) => [
    l.id, l.supplier, l.desc, itNumber(l.net), itNumber(l.vat), l.account || "", l.confidence ?? "", itDate(l.date),
  ]);
  const esc = (v) => (String(v).includes(",") ? `"${v}"` : v);
  return [cols.join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
}
