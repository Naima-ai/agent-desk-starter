// backend/whatsappInbound.mjs
// Matches an inbound WhatsApp reply to the pending ticket it's answering, and
// applies the result — resolving a document request, confirming a correction,
// or deciding an approval gate. This is agent-brain logic, not connector logic
// — same reason documentContact.mjs isn't inside whatsapp.mjs: it needs
// pendingDocumentRequests / pendingGates / pendingCorrections, which
// whatsapp.mjs deliberately knows nothing about.
//
// Matching is by WhatsApp's `context.id` — the id of the message being
// replied to — against every message id sent for that item (`waMessageIds`,
// appended in lAmministrativo.mjs and documentContact.mjs on each send). This is deliberately NOT "any reply from this phone
// number" matching: a client can have more than one thing pending at once (a
// document request AND an invoice approval, say), and matching on phone
// number alone can't tell them apart. Matching on the specific message being
// replied to can.
import {
  pendingDocumentRequests, pendingGates, pendingCorrections,
  prepareDocumentRequestResolution, prepareCorrectionResolution,
} from "./lAmministrativo.mjs";
import { publish } from "./bus.mjs";
import { publishA2A } from "./messaging/a2aBus.mjs";
import * as wa from "./connectors/whatsapp.mjs";

// Same two-step resolution as the "Mark received" / correction-resolve endpoints in
// server.mjs: publish the outgoing A2A message (document_delivered / answer_with_evidence)
// on the bus FIRST, then commit local state. If the bus is unavailable the item stays
// open, rather than being closed locally while the studio side is never told.
async function publishThenCommit(resolution) {
  if (!resolution) return null;
  try {
    await publishA2A(resolution.a2a, { publisher: resolution.a2a.from });
  } catch (e) {
    publish("feed", { agent: "l_amministrativo", tone: "warn", text: `WhatsApp reply received but the A2A bus is unavailable (${e.code || e.message}) — left open; it can be closed from Approvals.` });
    return null;
  }
  const committed = resolution.commit();
  if (committed?.evidence) publish("evidence", { record: committed.evidence });
  return committed;
}

// Every message sent for an item is remembered (the first send AND each
// reminder), so a reply to any of them matches — not only the most recent.
// Also requires the item to belong to the sender's own client: a quoted message id
// is hard to guess, but there's no reason to let one client's reply touch another's item.
function findByMessageId(map, contextId, clientId) {
  if (!contextId) return null;
  for (const item of map.values()) {
    if (clientId && item.clientId !== clientId) continue;
    if (item.waMessageIds?.includes(contextId) || item.lastWaMessageId === contextId) return item;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Approval gates are the one safety-critical case here: a gate is the thing
// standing between an AI-prepared action (an invoice, in particular) and it
// actually happening. A reply is only ever treated as a decision if it's an
// unambiguous yes/no in Italian or English — anything else leaves the gate
// pending and lets the next scheduled reminder ask again, rather than
// guessing. "A message arrived" must never silently become "approved."
// ---------------------------------------------------------------------------
const YES = new Set(["si", "sì", "ok", "va bene", "confermo", "approvo", "yes", "approve", "confirm"]);
const NO = new Set(["no", "nego", "rifiuto", "annulla", "deny", "reject", "cancel"]);

function parseDecision(text) {
  const t = String(text || "").trim().toLowerCase();
  if (YES.has(t)) return "approve";
  if (NO.has(t)) return "deny";
  return null;
}

/**
 * Call this with one inbound WhatsApp message (from whatsappRoutes.mjs, after
 * whatsapp.mjs's ingestInbound has already logged it and matched the sender
 * to a client). Returns what happened. Never throws on an unmatched or
 * ambiguous reply — a webhook endpoint failing loudly just makes Meta retry
 * the same message again, it doesn't help anyone.
 */
export async function applyInboundReply({ from, clientId = null, text, context, verified = false, documents = [] }) {
  const contextId = context?.id || null;

  // A document request is only "received" when a document actually arrived and
  // TeamSystem filed it. A text-only reply ("ecco la fattura", "la mando domani")
  // keeps the request open, and the owner is asked again for the file.
  const filed = documents.filter((d) => d.filed);
  let docReq = findByMessageId(pendingDocumentRequests, contextId, clientId);
  if (!docReq && !contextId && filed.length) {
    // A file sent without quoting the request: link it only when there's exactly one
    // open document request for this client, so it can't land on the wrong one.
    const open = [...pendingDocumentRequests.values()].filter((r) => r.clientId === clientId && r.status === "pending");
    if (open.length === 1) docReq = open[0];
  }
  if (docReq) {
    if (!filed.length) {
      const why = documents.length ? documents.map((d) => d.outcome).join("; ") : "no document attached";
      publish("feed", { agent: "l_amministrativo", tone: "warn", text: `Owner replied to request ${docReq.id}${text ? ` ("${text}")` : ""}, but ${why} — still waiting for the invoice.` });
      const ask = await wa.sendText(from, documents.length
        ? "Grazie! Non riusciamo a leggere questo file come fattura. Può inviarla in PDF o XML rispondendo a questo messaggio?"
        : "Grazie! Non vediamo nessun documento allegato. Può inviare la fattura (PDF o XML) rispondendo a questo messaggio?");
      if (ask?.id) (docReq.waMessageIds ||= []).push(ask.id); // a reply to this follow-up matches the same request
      return { matched: "document_request", id: docReq.id, resolved: false, reason: "no_document" };
    }
    const result = await publishThenCommit(prepareDocumentRequestResolution(docReq.id, { foundVia: "whatsapp_document" }));
    if (result) publish("feed", { agent: "l_amministrativo", tone: "good", text: `Document request ${docReq.id} resolved: ${filed.map((d) => `${d.filename} (${d.outcome})`).join("; ")}.` });
    return { matched: "document_request", id: docReq.id, resolved: Boolean(result) };
  }

  const correction = findByMessageId(pendingCorrections, contextId, clientId);
  if (correction) {
    const result = await publishThenCommit(prepareCorrectionResolution(correction.id, { answer: text, confirmedBy: `whatsapp:${from}` }));
    if (result) publish("feed", { agent: "l_amministrativo", tone: "good", text: `Correction ${correction.id} confirmed by WhatsApp reply from ${from}.` });
    return { matched: "correction", id: correction.id, resolved: Boolean(result) };
  }

  const gate = findByMessageId(pendingGates, contextId, clientId);
  if (gate) {
    // An unsigned webhook (WHATSAPP_APP_SECRET not set) can't prove it came
    // from Meta, so it is never allowed to approve or deny a gate. Document
    // requests and corrections above are low-risk (a human still reviews the
    // document); a gate releases an action, so it needs the stronger proof.
    if (!verified) {
      publish("feed", { agent: "l_amministrativo", tone: "warn", text: `Gate ${gate.id}: WhatsApp reply from ${from} not applied — webhook signature not verified (set WHATSAPP_APP_SECRET). Approve it in the Approvals tab.` });
      return { matched: "gate", id: gate.id, resolved: false, decision: "unverified" };
    }
    const decision = parseDecision(text);
    if (decision === "approve") {
      gate.approve(`whatsapp:${from}`);
      return { matched: "gate", id: gate.id, resolved: true, decision: "approved" };
    }
    if (decision === "deny") {
      gate.deny(`WhatsApp reply from ${from}: "${text}"`);
      return { matched: "gate", id: gate.id, resolved: true, decision: "denied" };
    }
    publish("feed", { agent: "l_amministrativo", tone: "warn", text: `Gate ${gate.id}: reply "${text}" from ${from} wasn't a clear yes/no — still waiting.` });
    return { matched: "gate", id: gate.id, resolved: false, decision: "unclear" };
  }

  // Received and matched to the client, but not a reply to anything still open:
  // a fresh message (not a quoted Reply), or a reply to an item that's already
  // closed or was lost on a server restart. Say so, instead of staying silent.
  if (filed.length) {
    publish("feed", { agent: "l_amministrativo", tone: "info", text: `${filed.map((d) => d.filename).join(", ")} from ${from} filed in TeamSystem, but not linked to a specific request — use "Mark received" in Approvals if it answers one.` });
    return { matched: null, resolved: false, filed: filed.length };
  }
  publish("feed", { agent: "l_amministrativo", tone: "info", text: contextId
    ? `WhatsApp reply from ${from} quotes a message with no open request behind it (already resolved, or the server restarted since it was sent).`
    : `WhatsApp message from ${from} isn't a reply to a specific request — nothing resolved. Long-press the request message and use Reply.` });
  return { matched: null, resolved: false };
}
