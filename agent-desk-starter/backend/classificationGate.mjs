// backend/classificationGate.mjs — Il Classificatore asking a human at the
// STUDIO to confirm a proposed chart-of-accounts classification before
// L'Archivista turns it into a durable rule. Previously this was faked: the
// demo script called archivista.learnConfirmed() immediately with a
// hardcoded confirmedBy of "Bianchi" — no pause, no real approval, the same
// name every time regardless of who or what was actually being classified.
//
// This reuses L'Amministrativo's own gate registry (same `pendingGates` Map,
// same GET /api/gates + POST /api/gate/:id/approve|deny server.mjs already
// exposes, same Approvals UI already renders) — a gate is a gate regardless
// of which seat opened it, so there's no need for a second parallel system.
// Unlike the owner-approval gate, this sends no WhatsApp reminders: it's a
// studio-internal confirmation, not a client-facing one.
import { pendingGates } from "./lAmministrativo.mjs";
import { startLadder } from "./escalationLadder.mjs";
import { EventEmitter } from "node:events";

const SEAT = "il_classificatore";
const ladderEvents = new EventEmitter();
ladderEvents.setMaxListeners(50);
export function onLadderEvent(fn) { ladderEvents.on("event", fn); return () => ladderEvents.off("event", fn); }
function emitLadderEvent(evt) { ladderEvents.emit("event", { seat: SEAT, at: new Date().toISOString(), ...evt }); }

/** Opens a real gate: the caller genuinely blocks on `ticket.decision` until
 *  a human calls `ticket.approve(approvedBy)` or `ticket.deny(reason)` —
 *  same shape as L'Amministrativo's requestOwnerApproval. Approving without
 *  overriding the account confirms the classifier's own proposal as-is. */
export function requestClassificationConfirmation(clientId, line, proposal, ladderCfg = {}) {
  let resolveDecision, rejectDecision;
  const decision = new Promise((res, rej) => { resolveDecision = res; rejectDecision = rej; });
  const ticket = {
    id: `cgate_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    seat: SEAT, clientId, action: "confirm_classification",
    payload: { lineId: line.id, supplier: line.supplier, proposedAccount: proposal.account, confidence: proposal.confidence },
    status: "pending", remindersSent: 0, escalated: false,
    createdAt: new Date().toISOString(), decision,
  };

  const ladder = startLadder({
    reminderDelaysMs: ladderCfg.reminderDelaysMs ?? [15_000, 45_000],
    escalateAfterMs: ladderCfg.escalateAfterMs ?? 90_000,
    onRemind: (n) => {
      if (ticket.status !== "pending") return;
      ticket.remindersSent = n;
      emitLadderEvent({ kind: "gate", event: "reminder", gateId: ticket.id, clientId, action: ticket.action, n });
    },
    onEscalate: () => {
      if (ticket.status !== "pending") return;
      ticket.escalated = true;
      emitLadderEvent({ kind: "gate", event: "escalate", gateId: ticket.id, clientId, action: ticket.action });
      // Escalating notifies (via the feed) that this has gone unanswered a
      // while; it does not auto-resolve it — a real decision still has to
      // come through approve()/deny().
    },
  });

  ticket.approve = (approvedBy, account) => {
    if (ticket.status !== "pending") return;
    ladder.cancel();
    ticket.status = "approved";
    pendingGates.delete(ticket.id);
    emitLadderEvent({ kind: "gate", event: "resolved", gateId: ticket.id, clientId, status: "approved" });
    resolveDecision({ approvedBy, account: account || proposal.account, at: new Date().toISOString() });
  };
  ticket.deny = (reason) => {
    if (ticket.status !== "pending") return;
    ladder.cancel();
    ticket.status = "denied";
    pendingGates.delete(ticket.id);
    emitLadderEvent({ kind: "gate", event: "resolved", gateId: ticket.id, clientId, status: "denied" });
    rejectDecision(new Error(`Classification declined: ${reason || "no reason given"}`));
  };

  pendingGates.set(ticket.id, ticket);
  return ticket;
}
