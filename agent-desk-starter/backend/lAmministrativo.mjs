// backend/lAmministrativo.mjs — L'Amministrativo's brain.
//
// Runs at the client
// Keeps the client's administration current and delivers it to the studio without
// being asked. Talks to the studio only through Lo Smistatore, in typed, signed
// A2A messages — never a free-text message, never a studio person directly.
//
// >>> TODO (real): sdi.inbox and fattureincloud.draft are stub connectors today
//     (see backend/connectors/sdiInbox.stub.mjs and fattureInCloudDraft.stub.mjs).
//     Their function signatures are the real contract; swapping the bodies for
//     live API calls requires no change in this file.

import { makeMessage } from "../contracts/a2aSchema.mjs";
import * as evidence from "./memory/evidenceStore.mjs";
import * as knowledge from "./memory/knowledgeStore.mjs";
import * as bankFeed from "./connectors/bankFeed.mock.mjs";
import * as wa from "./connectors/whatsapp.mjs";
import { getOwnerPhone } from "./clientDirectory.mjs";
import { readSdiInbox } from "./connectors/sdiInbox.stub.mjs";
import { draftInvoice } from "./connectors/fattureInCloudDraft.stub.mjs";
import { startLadder } from "./escalationLadder.mjs";
import { getActiveManifest } from "./compiler.mjs";
import { assertStaticActionAllowed } from "./runtime/systemPolicy.mjs";
import { EventEmitter } from "node:events";

const SEAT = "l_amministrativo";

// Reminder/escalation ladder — timing + visibility.
// >>> TODO (real): read these from the client's configuration profile instead of a constant.
const DEFAULT_LADDER = {
  reminderDelaysMs: [15_000, 45_000], // nudge the owner at +15s, +45s
  escalateAfterMs: 90_000,            // escalate to the studio at +90s if still unresolved
};

const ladderEvents = new EventEmitter();
ladderEvents.setMaxListeners(50);
export function onLadderEvent(fn) { ladderEvents.on("event", fn); return () => ladderEvents.off("event", fn); }
function emitLadderEvent(evt) { ladderEvents.emit("event", { seat: SEAT, at: new Date().toISOString(), ...evt }); }

export const pendingGates = new Map();
export const pendingDocumentRequests = new Map();
export const pendingQuestions = new Map();
export const pendingCorrections = new Map();

// ---------------------------------------------------------------------------
// Hard blocks. Enforced at the tool layer, in code, on every call —
// not a prompt hint the model could talk itself around.
//
// The compiled manifest's `refuses` list is checked TOO, but only ever
// ADDS restrictions on top of the immutable system policy, never removes any — a job
// description compiled through a model (even a real one, let alone the
// offline fallback) is not a trusted source for RELAXING a hard block. If
// this ever read `manifest.refuses` as a replacement instead of a union,
// typing a job description that simply omits "payments" would silently
// re-enable it — that would turn "enforced in code" into exactly the
// prompt-shaped suggestion this design explicitly says it isn't.
// ---------------------------------------------------------------------------
function assertAllowed(action) {
  assertStaticActionAllowed({ seat: SEAT, action, manifest: getActiveManifest(SEAT) });
}

export function executePayment() { assertAllowed("payments"); }
export function sendToAuthority() { assertAllowed("send_to_authority"); }
export function giveTaxAdvice() { assertAllowed("tax_advice"); }
export function contactStudioStaffDirectly() { assertAllowed("contact_studio_staff"); }

// ---------------------------------------------------------------------------
// Client memory partition. 
// >>> TODO (real): back this with a real per-client partition not a shared in-process Map.
// ---------------------------------------------------------------------------
function partitionKey(clientId, key) {
  return `client:${clientId}:${key}`;
}

function writeClientFact(clientId, key, value, meta = {}) {
  return knowledge.upsert({
    key: partitionKey(clientId, key),
    kind: meta.kind || "client_fact",
    scope: `client:${clientId}`,
    value,
    confidence: meta.confidence ?? 1.0,
    source: meta.source || SEAT,
    confirmedBy: meta.confirmedBy || null,
    evidenceId: meta.evidenceId,
  });
}

function findClientFactMatching(clientId, text) {
  const needle = (text || "").toLowerCase();
  if (!needle) return null;
  const prefix = `client:${clientId}:`;
  return knowledge.all().find((rec) => {
    if (!rec.key || !rec.key.startsWith(prefix)) return false;
    const parts = rec.key.slice(prefix.length).split(":").filter((p) => p.length >= 3);
    return parts.some((p) => needle.includes(p.toLowerCase()));
  }) || null;
}

// ---------------------------------------------------------------------------
// The one allowed outbound channel.
// ---------------------------------------------------------------------------
function toStudio(clientId, msg) {
  return makeMessage({ from: SEAT, to: "lo_smistatore", client: clientId, ...msg });
}

// Runtime adapters inject a guarded message capability here. Legacy callers use
// the original direct constructor until their paths are migrated.
function outbound(runtime, clientId, msg) {
  return runtime?.toStudio ? runtime.toStudio(msg) : toStudio(clientId, msg);
}

// ---------------------------------------------------------------------------
// The owner-approval gate.
// ---------------------------------------------------------------------------
export function requestOwnerApproval(clientId, action, payload, ladderCfg = {}) {
  let resolveDecision, rejectDecision;
  const decision = new Promise((res, rej) => { resolveDecision = res; rejectDecision = rej; });
  const ticket = {
    id: `gate_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    seat: SEAT,
    clientId,
    action,
    payload,
    status: "pending",
    remindersSent: 0,
    escalated: false,
    createdAt: new Date().toISOString(),
    decision,
  };

  const ladder = startLadder({
    reminderDelaysMs: ladderCfg.reminderDelaysMs ?? DEFAULT_LADDER.reminderDelaysMs,
    escalateAfterMs: ladderCfg.escalateAfterMs ?? DEFAULT_LADDER.escalateAfterMs,
    onRemind: async (n) => {
      if (ticket.status !== "pending") return;
      ticket.remindersSent = n;
      const waResult = await wa.sendTemplate(getOwnerPhone(clientId), "approval_reminder", { action, ref: payload?.draftId ?? "n/a",});
      if (waResult?.id) (ticket.waMessageIds ||= []).push(waResult.id); // lets whatsappInbound.mjs match a reply back to this gate
      emitLadderEvent({ kind: "gate", event: "reminder", gateId: ticket.id, clientId, action, n });
    },
    onEscalate: () => {
      if (ticket.status !== "pending") return;
      ticket.escalated = true;
      ticket.escalation = toStudio(clientId, {
        type: "escalation_requested",
        reason: `Gate "${action}" unresolved after ${ticket.remindersSent} reminder(s).`,
      });
      emitLadderEvent({ kind: "gate", event: "escalate", gateId: ticket.id, clientId, action, escalation: ticket.escalation });
      // Escalating notifies the studio; it does NOT resolve the gate. The owner still decides
    },
  });

  ticket.approve = (approvedBy) => {
    if (ticket.status !== "pending") return;
    ladder.cancel();
    ticket.status = "approved";
    pendingGates.delete(ticket.id);
    emitLadderEvent({ kind: "gate", event: "resolved", gateId: ticket.id, clientId, status: "approved" });
    resolveDecision({ approvedBy, at: new Date().toISOString() });
  };
  ticket.deny = (reason) => {
    if (ticket.status !== "pending") return;
    ladder.cancel();
    ticket.status = "denied";
    pendingGates.delete(ticket.id);
    emitLadderEvent({ kind: "gate", event: "resolved", gateId: ticket.id, clientId, status: "denied" });
    rejectDecision(new Error(`Owner denied: ${reason || "no reason given"}`));
  };

  pendingGates.set(ticket.id, ticket);
  return ticket;
}

// ---------------------------------------------------------------------------
// The 7 skills, switched on per client.
// ---------------------------------------------------------------------------
function skillEnabled(manifest, name) {
  return Array.isArray(manifest.skills) && manifest.skills.includes(name);
}

// 1. raccolta_documenti — document collection
export async function collectDocument(manifest, clientId, expected, runtime = null) {
  if (!skillEnabled(manifest, "raccolta_documenti")) return { skipped: true, skill: "raccolta_documenti" };

  const [movements, inbox] = await Promise.all([
    runtime?.movements ? runtime.movements() : bankFeed.movements(),
    runtime?.readInbox ? runtime.readInbox() : readSdiInbox(clientId),
  ]);
  const found =
    inbox.find((d) => d.supplier === expected.supplier && d.period === expected.period) ||
    movements.find((m) => m.desc?.includes(expected.supplier));

  if (found) {
    const ev = evidence.put({
      kind: "document", clientId, supplier: expected.supplier, period: expected.period,
      foundVia: found.sdiId ? "sdi_inbox" : "bank_feed",
    });
    return {
      found: true,
      evidence: ev,
      a2a: outbound(runtime, clientId, { type: "document_delivered", doc: `${expected.docType} ${expected.supplier}`, sdiId: found.sdiId }),
    };
  }

  // Not found automatically — open a tracked request. 
  const requestId = `docreq_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const request = {
    id: requestId, seat: SEAT, clientId, expected,
    status: "pending", remindersSent: 0, escalated: false,
    createdAt: new Date().toISOString(),
  };
  const ping = async () => {
    const result = runtime?.sendOwner
      ? await runtime.sendOwner("request_document", { doc: `${expected.docType} ${expected.supplier}`, period: expected.period })
      : await wa.sendTemplate(getOwnerPhone(clientId), "request_document", { doc: `${expected.docType} ${expected.supplier}`, period: expected.period });
    // Both paths return sendTemplate's result: the runtime path goes through the
    // whatsapp.owner_employees tool, whose outputSchema is .passthrough(), so the
    // Meta message id survives. Offline stub sends have no id — nothing to match.
    if (result?.id) (request.waMessageIds ||= []).push(result.id); // lets whatsappInbound.mjs match a reply back to this request
    return result;
  };
  await ping();
  pendingDocumentRequests.set(requestId, request);

  // A runtime run is bounded and closes after returning, so it must not retain
  // its guarded tool context inside 15/45/90-second timer callbacks. Durable
  // reminder scheduling will be a separate correlated bus trigger. Legacy
  // callers retain the existing in-process ladder in the meantime.
  if (runtime?.scheduleLadder !== false) {
    const ladderCfg = expected.ladder || {};
    const ladder = startLadder({
      reminderDelaysMs: ladderCfg.reminderDelaysMs ?? DEFAULT_LADDER.reminderDelaysMs,
      escalateAfterMs: ladderCfg.escalateAfterMs ?? DEFAULT_LADDER.escalateAfterMs,
      onRemind: async (n) => {
        if (request.status !== "pending") return; // resolved between the timer firing and now — no-op
        request.remindersSent = n;
        await ping();
        emitLadderEvent({ kind: "document_request", event: "reminder", requestId, clientId, n });
      },
      onEscalate: () => {
        if (request.status !== "pending") return;
        request.escalated = true;
        request.escalation = outbound(runtime, clientId, {
          type: "escalation_requested",
          reason: `Missing ${expected.docType} from ${expected.supplier} (${expected.period}) unresolved after ${request.remindersSent} reminder(s).`,
        });
        emitLadderEvent({ kind: "document_request", event: "escalate", requestId, clientId, escalation: request.escalation });
        // Escalating tells the studio; it does not fabricate the document or resolve the request itself —
        // resolveDocumentRequest() still needs a real answer to close it.
      },
    });
    request._ladder = ladder;
  }

  return {
    found: false,
    askedOwner: true,
    requestId,
    a2a: outbound(runtime, clientId, { type: "item_missing", expected: `${expected.docType} ${expected.supplier}`, period: expected.period, urgency: "normal" }),
  };
}

/* Prepare first so durable callers can persist the outbound message before
   committing local state. Legacy in-process callers keep the one-step wrapper
   below. Both paths return null for an unknown/already-resolved request. */
export function prepareDocumentRequestResolution(requestId, foundInfo = {}) {
  const request = pendingDocumentRequests.get(requestId);
  if (!request || request.status !== "pending") return null;
  const a2aMsg = toStudio(request.clientId, {
    type: "document_delivered", doc: `${request.expected.docType} ${request.expected.supplier}`, sdiId: foundInfo.sdiId,
  });
  let committed = null;
  return {
    a2a: a2aMsg,
    commit() {
      if (committed) return committed;
      const current = pendingDocumentRequests.get(requestId);
      if (!current || current !== request || current.status !== "pending") return null;
      request._ladder?.cancel();
      request.status = "resolved";
      const ev = evidence.put({
        kind: "document", clientId: request.clientId, supplier: request.expected.supplier,
        period: request.expected.period, foundVia: foundInfo.foundVia || "owner_reply", sdiId: foundInfo.sdiId,
      });
      pendingDocumentRequests.delete(requestId);
      emitLadderEvent({ kind: "document_request", event: "resolved", requestId, clientId: request.clientId });
      committed = { evidence: ev, a2a: a2aMsg };
      return committed;
    },
  };
}

export function resolveDocumentRequest(requestId, foundInfo = {}) {
  return prepareDocumentRequestResolution(requestId, foundInfo)?.commit() || null;
}

// 2. fatturazione — invoicing (draft only; sending always waits on the gate)
export async function draftAndSendInvoice(manifest, clientId, invoiceData, opts = {}) {
  if (!skillEnabled(manifest, "fatturazione")) return { skipped: true, skill: "fatturazione" };

  const draft = await draftInvoice(clientId, invoiceData);
  const gate = requestOwnerApproval(clientId, "invoice", draft, opts.ladder || {});
  opts.onTicket?.(gate); // lets a caller (scenario/server) see the ticket id the moment it opens, without waiting on the decision
  const approval = await gate.decision; // blocks here until approve()/deny() is called externally, or the ladder escalates (which does not resolve it)
  const ev = evidence.put({ kind: "invoice_draft", clientId, draft, approvedBy: approval.approvedBy });
  writeClientFact(clientId, `invoice:${draft.draftId}`, draft, { kind: "invoice", evidenceId: ev.id, confirmedBy: approval.approvedBy });
  return { sent: true, evidence: ev, approval, draft };
}

// 3. incassi_e_solleciti — collections & reminders
export async function sendReminder(manifest, clientId, debtor) {
  if (!skillEnabled(manifest, "incassi_e_solleciti")) return { skipped: true, skill: "incassi_e_solleciti" };
  await wa.sendTemplate(debtor.contact || getOwnerPhone(clientId), "payment_reminder", { debtor: debtor.name, amount: debtor.amount, due: debtor.due });
  return { reminded: true, debtor: debtor.name };
}

// 4. presenze_note_spese — attendance & expenses
export async function logAttendanceOrExpense(manifest, clientId, entry) {
  if (!skillEnabled(manifest, "presenze_note_spese")) return { skipped: true, skill: "presenze_note_spese" };
  const ev = evidence.put({ kind: entry.kind || "expense", clientId, ...entry });
  writeClientFact(clientId, `${entry.kind || "expense"}:${entry.id || ev.id}`, entry, { evidenceId: ev.id });
  return { logged: true, evidence: ev };
}

// 5. sportello_dipendenti — employee desk
export async function answerEmployeeQuestion(manifest, clientId, employee, question) {
  if (!skillEnabled(manifest, "sportello_dipendenti")) return { skipped: true, skill: "sportello_dipendenti" };
  // Never answers itself — always escalates to the studio via the approved A2A channel instead.
  return { escalated: true, a2a: toStudio(clientId, { type: "question_for_studio", topic: `employee:${employee}`, body: question }) };
}

// 6. scadenze_pagamenti — deadlines & payments (tracks and reminds; never executes)
export async function trackDeadline(manifest, clientId, deadline) {
  if (!skillEnabled(manifest, "scadenze_pagamenti")) return { skipped: true, skill: "scadenze_pagamenti" };
  const daysLeft = Math.ceil((new Date(deadline.due) - Date.now()) / 86400000);
  if (daysLeft <= (deadline.reminderWindowDays ?? 3)) {
    await wa.sendTemplate(getOwnerPhone(clientId), "deadline_reminder", { what: deadline.what, due: deadline.due });
  }
  return { tracked: true, daysLeft };
}

// 7. domande_allo_studio — questions to the studio (the one approved contact path)
export async function askStudio(manifest, clientId, topic, body, runtime = null) {
  if (!skillEnabled(manifest, "domande_allo_studio")) return { skipped: true, skill: "domande_allo_studio" };
  const questionId = `q_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  pendingQuestions.set(questionId, { id: questionId, clientId, topic, body, status: "pending", askedAt: new Date().toISOString() });
  return { questionId, a2a: outbound(runtime, clientId, { type: "question_for_studio", topic, body }) };
}

/* Call this when the studio answers (answer_with_evidence). 
   Closes the oldest pending question for this client 
   Returns null if there's nothing pending for this client. */
export function resolveQuestion(clientId, { answer, evidenceId } = {}) {
  const oldest = [...pendingQuestions.values()]
    .filter((q) => q.clientId === clientId && q.status === "pending")
    .sort((a, b) => new Date(a.askedAt) - new Date(b.askedAt))[0];
  if (!oldest) return null;
  oldest.status = "resolved";
  oldest.answer = answer;
  oldest.evidenceId = evidenceId;
  pendingQuestions.delete(oldest.id);
  return oldest;
}

export function resolveQuestionById(questionId, { answer, evidenceId } = {}) {
  const q = pendingQuestions.get(questionId);
  if (!q || q.status !== "pending") return null;
  q.status = "resolved";
  q.answer = answer;
  q.evidenceId = evidenceId;
  pendingQuestions.delete(questionId);
  return q;
}

// ------------------------------------------------------------------------------------------------
// Inbound: a typed `instruction_from_studio` A2A message arrives via Lo Smistatore. 
// This is the entry point the bus/scenario should call when that message type lands for this seat.
// ------------------------------------------------------------------------------------------------
export async function handleInstructionFromStudio(manifest, clientId, message, runtime = null) {
  const ack = outbound(runtime, clientId, { type: "acknowledgment", ref: (message.instruction || "instruction").slice(0, 60) });

  const m = /fetch (.+) for (.+)/i.exec(message.instruction || "");
  if (m) {
    const [, supplierGuess, period] = m;
    const result = await collectDocument(manifest, clientId, { docType: "invoice", supplier: supplierGuess.trim(), period: period.trim() }, runtime);
    return { ack, ...result };
  }

  const known = findClientFactMatching(clientId, message.instruction);
  if (known) {
    return {
      ack,
      answeredFromMemory: true,
      a2a: outbound(runtime, clientId, {
        type: "answer_with_evidence",
        answer: `${known.key.split(":").slice(2).join(":")}: ${JSON.stringify(known.value)}`,
        evidenceId: known.evidenceId || "unknown",
      }),
    };
  }

  const result = await askStudio(manifest, clientId, "unrecognised_instruction", message.instruction, runtime);
  return { ack, ...result };
}

export async function handleCorrectionRequest(manifest, clientId, message, runtime = null) {
  const ack = outbound(runtime, clientId, { type: "acknowledgment", ref: `correction:${message.ruleId}`.slice(0, 60) });

  const correctionId = `corr_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const correction = {
    id: correctionId, seat: SEAT, clientId,
    ruleId: message.ruleId, message: message.message, period: message.period,
    status: "pending", remindersSent: 0, escalated: false,
    createdAt: new Date().toISOString(),
  };
  const vars = { rule: message.ruleId, period: message.period, detail: message.message };
  const ping = async () => {
    const result = runtime?.sendOwner
      ? await runtime.sendOwner("confirm_correction", vars)
      : await wa.sendTemplate(getOwnerPhone(clientId), "confirm_correction", vars);
    if (result?.id) (correction.waMessageIds ||= []).push(result.id); // lets whatsappInbound.mjs match a reply back to this correction
    return result;
  };
  await ping();
  pendingCorrections.set(correctionId, correction);
  emitLadderEvent({ kind: "correction", event: "opened", correctionId, clientId, ruleId: message.ruleId });

    if (runtime?.scheduleLadder !== false) {
    const ladderCfg = message.ladder || {};
    correction._ladder = startLadder({
      reminderDelaysMs: ladderCfg.reminderDelaysMs ?? DEFAULT_LADDER.reminderDelaysMs,
      escalateAfterMs: ladderCfg.escalateAfterMs ?? DEFAULT_LADDER.escalateAfterMs,
      onRemind: async (n) => {
        if (correction.status !== "pending") return;
        correction.remindersSent = n;
        await ping();
        emitLadderEvent({ kind: "correction", event: "reminder", correctionId, clientId, n });
      },
      onEscalate: () => {
        if (correction.status !== "pending") return;
        correction.escalated = true;
        correction.escalation = outbound(runtime, clientId, {
          type: "escalation_requested",
          reason: `Correction ${message.ruleId} (${message.period}) unanswered by the client after ${correction.remindersSent} reminder(s).`,
        });
        emitLadderEvent({ kind: "correction", event: "escalate", correctionId, clientId, escalation: correction.escalation });
              },
    });
  }

  return { ack, askedOwner: true, correctionId };
}

/* The owner has answered. Prepare first so durable callers can persist the outbound message before
   committing local state (same two-step shape as prepareDocumentRequestResolution). Null if unknown/closed. */
export function prepareCorrectionResolution(correctionId, { answer, confirmedBy } = {}) {
  const correction = pendingCorrections.get(correctionId);
  if (!correction || correction.status !== "pending") return null;
  const finalAnswer = (answer || "").trim() || "Owner confirmed the correction.";
  let committed = null;
    const evidenceId = `corr_ev_${correctionId}`;
  const a2aMsg = toStudio(correction.clientId, {
    type: "answer_with_evidence", answer: finalAnswer, evidenceId, ref: correctionId,
  });
  return {
    a2a: a2aMsg,
    commit() {
      if (committed) return committed;
      const current = pendingCorrections.get(correctionId);
      if (!current || current !== correction || current.status !== "pending") return null;
      correction._ladder?.cancel();
      correction.status = "resolved";
      const ev = evidence.put({
        id: evidenceId, kind: "correction_answer", clientId: correction.clientId,
        ruleId: correction.ruleId, period: correction.period, answer: finalAnswer,
        confirmedBy: confirmedBy || "owner",
      });
      writeClientFact(correction.clientId, `correction:${correction.period}:${correction.ruleId}`,
        { answer: finalAnswer, message: correction.message }, { kind: "correction", evidenceId: ev.id, confirmedBy: confirmedBy || "owner" });
      pendingCorrections.delete(correctionId);
      emitLadderEvent({ kind: "correction", event: "resolved", correctionId, clientId: correction.clientId });
      committed = { evidence: ev, a2a: a2aMsg };
      return committed;
    },
  };
}

export function resolveCorrection(correctionId, info = {}) {
  return prepareCorrectionResolution(correctionId, info)?.commit() || null;
}

// ---------------------------------------------------------------------------
// Proactive delivery of the monthly pack — 
// Summarises what THIS seat has itself recorded for the client+period — 
// documents found or delivered, anything still missing (open document requests), 
// anything still awaiting a studio answer (open questions) — 
// and sends a single pack_delivered message

// Not gated behind any one of the 7 skills: it reports on whatever those
// skills happened to produce, and stays honestly empty where they're off.
// >>> TODO (real): trigger this on a real schedule (see the manifest's new
// `schedule` field) rather than only being called explicitly.
// ---------------------------------------------------------------------------
export async function deliverMonthlyPack(clientId, period) {
  const docs = evidence.all()
    .filter((ev) => ev.kind === "document" && ev.clientId === clientId && ev.period === period)
    .map((ev) => ({ supplier: ev.supplier, foundVia: ev.foundVia, sdiId: ev.sdiId }));

  const missing = [...pendingDocumentRequests.values()]
    .filter((r) => r.clientId === clientId && r.expected.period === period)
    .map((r) => ({ docType: r.expected.docType, supplier: r.expected.supplier, remindersSent: r.remindersSent, escalated: r.escalated }));

  const questions = [...pendingQuestions.values()]
    .filter((q) => q.clientId === clientId && q.status === "pending")
    .map((q) => ({ topic: q.topic, askedAt: q.askedAt }));

  const corrections = [...pendingCorrections.values()]
    .filter((c) => c.clientId === clientId && c.period === period)
    .map((c) => ({ ruleId: c.ruleId, remindersSent: c.remindersSent, escalated: c.escalated }));

  const pack = { period, clientId, docs, missing, questions, corrections, assembledAt: new Date().toISOString() };
  const ev = evidence.put({ kind: "monthly_pack", clientId, period, itemCount: docs.length, pack });
  writeClientFact(clientId, `pack:${period}`, pack, { kind: "monthly_pack", evidenceId: ev.id });

  return {
    evidence: ev,
    pack,
    a2a: toStudio(clientId, { type: "pack_delivered", period, items: docs.length }),
  };
}
