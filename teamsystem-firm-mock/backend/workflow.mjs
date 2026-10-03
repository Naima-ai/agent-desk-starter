// backend/workflow.mjs — what TeamSystem itself DOES when Agent Desk writes a
// filing status back. A write-back is not just a message in a list: each
// status drives a per-client, per-period state machine that opens tasks for
// the studio, sends requests to the client (Rulebook Section 9 templates),
// schedules reminders, and gates the professional's sign -> transmit steps.
//
//   needs_review ──(all review tasks done)──> ready_for_revalidation
//        │                                          │ (re-run in Agent Desk)
//        ▼                                          ▼
//   awaiting_signature ──sign──> signed ──transmit──> filed (protocol + receipt)
//
// State persists to backend/data/workflow-state.json (gitignored) so a
// restart doesn't forget a client's open tasks or filed receipts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const stateFile = process.env.TS_WORKFLOW_FILE || join(process.env.TS_STATE_DIR || join(here, "data"), "workflow-state.json");

// clientId -> { writeBacks: [], periods: { [period]: PeriodState } }
let state = {};
function load() {
  try { if (existsSync(stateFile)) state = JSON.parse(readFileSync(stateFile, "utf8")); } catch { state = {}; }
}
function persist() {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
}
load();

/** Test hook: wipe in-memory state (and the file) so tests start clean. */
export function resetWorkflow() { state = {}; persist(); }

const DAY = 24 * 60 * 60 * 1000;
const iso = (d) => new Date(d).toISOString();
const dateOnly = (d) => iso(d).slice(0, 10);
const addDays = (dateStr, n) => dateOnly(new Date(dateStr).getTime() + n * DAY);

function clientState(clientId) {
  if (!state[clientId]) state[clientId] = { writeBacks: [], periods: {} };
  return state[clientId];
}
function periodState(clientId, period) {
  const cs = clientState(clientId);
  if (!cs.periods[period]) {
    cs.periods[period] = { period, stage: "received", tasks: [], outbox: [], reminders: [], timeline: [], protocol: null, receipt: null, deadline: null };
  }
  return cs.periods[period];
}

let seq = 0;
const nextId = (p) => `${p}_${Date.now().toString(36)}${(seq++).toString(36)}`;
function log(ps, event, detail) { ps.timeline.push({ at: iso(Date.now()), event, detail: detail || null }); }
function addTask(ps, task) {
  const t = { id: nextId("task"), status: "open", createdAt: iso(Date.now()), ...task };
  ps.tasks.push(t);
  return t;
}
// A newer validation replaces the earlier reminders instead of stacking them.
function cancelPendingReminders(ps) { for (const r of ps.reminders) if (!r.fired) { r.fired = true; r.cancelled = true; } }
function closeOpenTasks(ps, kinds, note) {
  const closed = [];
  for (const t of ps.tasks) {
    if (t.status === "open" && kinds.includes(t.kind)) {
      t.status = "done"; t.completedAt = iso(Date.now()); t.note = note;
      closed.push(t);
    }
  }
  return closed;
}

const clean = (t) => String(t).replace(/[.\s]+$/, "");
// ---- Rulebook Section 9 client templates (9.1 missing docs, 9.2 correction) ----
function missingDocRequest(client, item, period, deadline) {
  return {
    template: "9.1 Request for missing documentation",
    subject: `Action required — supporting document needed for ${item.supplier || "your VAT batch"} (${period})`,
    body: `Dear ${client.name}, during validation of your VAT batch for ${period} we identified that the following document is required to complete processing: ${clean(item.message || item.kind)}. This is needed so the quarterly LIPE can be filed. Please provide it by ${deadline}. If you have questions, reply to this message and we will assist. Kind regards, Studio.`,
  };
}
function correctionRequest(client, item, period, deadline) {
  return {
    template: "9.2 Request for correction",
    subject: `Action required — please confirm a correction (${item.ruleId || "validation"}, ${period})`,
    body: `Dear ${client.name}, during validation of your VAT batch for ${period}: ${clean(item.message || item.kind)}.${item.recurringCount ? ` Note: this same issue (${item.ruleId}) was also flagged in ${item.recurringCount} earlier validation(s).` : ""} Please confirm the correction or provide the justification/documentation supporting the current value by ${deadline}. Once received, we will re-validate and proceed. Kind regards, Studio.`,
  };
}

/** Record that a write-back arrived (always) and run whatever the status
 *  obliges TeamSystem to do next. Returns { stage, nextSteps[] } — the
 *  concrete things TS just did, so the caller can show them. */
export function applyWriteBack(client, rec) {
  const cs = clientState(client.id);
  cs.writeBacks.push(rec);
  const ps = periodState(client.id, rec.period);
  if (rec.deadline) ps.deadline = rec.deadline;
  const nextSteps = [];
  const newMessages = []; // client emails this write-back obliges TeamSystem to send
  const now = Date.now();
  const today = dateOnly(now);
  const responseDue = rec.deadline && addDays(today, 7) > rec.deadline ? rec.deadline : addDays(today, 7);

  log(ps, `write-back received: ${rec.status}`, rec.summary);

  if (ps.stage === "filed") {
    // Already filed: a late write-back must never reopen a submitted period.
    log(ps, "ignored — period already filed", rec.status);
    nextSteps.push("Period already filed — write-back recorded, no action taken.");
    persist();
    return { stage: ps.stage, nextSteps, period: rec.period, newMessages };
  }

  if (rec.status === "needs_review" || rec.status === "awaiting_signature") cancelPendingReminders(ps);

  if (rec.status === "needs_review") {
    // A fresh review round replaces any earlier open review work.
    closeOpenTasks(ps, ["review_anomalies", "classify_tail", "revalidate", "sign", "transmit"], "superseded by a newer validation");
    const items = rec.openItems || [];
    const anomalies = items.filter((i) => i.type !== "tail");
    const tail = items.filter((i) => i.type === "tail");
    const anomalyCount = anomalies.length || rec.anomalyCount || 0;
    const tailCount = tail.length || rec.tailCount || 0;

    if (anomalyCount) {
      const t = addTask(ps, { kind: "review_anomalies", assignee: "studio", title: `Resolve ${anomalyCount} validation problem${anomalyCount === 1 ? "" : "s"} (${rec.period})`, due: responseDue, detail: anomalies.map((a) => a.message).filter(Boolean) });
      nextSteps.push(`Opened task: ${t.title}`);
    }
    if (tailCount) {
      const t = addTask(ps, { kind: "classify_tail", assignee: "studio", title: `Confirm the category for ${tailCount} unclassified line${tailCount === 1 ? "" : "s"} (${rec.period})`, due: responseDue, detail: tail.map((a) => a.message).filter(Boolean) });
      nextSteps.push(`Opened task: ${t.title}`);
    }
    for (const item of anomalies) {
      const mail = item.kind === "item_missing" ? missingDocRequest(client, item, rec.period, responseDue) : correctionRequest(client, item, rec.period, responseDue);
      const m = { id: nextId("msg"), to: client.name, status: "sent", sentAt: iso(now), dueBy: responseDue, ruleId: item.ruleId || null, ...mail };
      ps.outbox.push(m);
      newMessages.push({ id: m.id, subject: m.subject, body: m.body });
      nextSteps.push(`Sent client request (${mail.template}) to ${client.name}, response due ${responseDue}`);
    }
    if (anomalies.length) {
      const remindOn = addDays(today, 3);
      ps.reminders.push({ id: nextId("rem"), on: remindOn, text: `Reminder: ${client.name} has not answered the open request(s) for ${rec.period}`, fired: false });
      nextSteps.push(`Scheduled client reminder for ${remindOn} (escalate if unanswered)`);
    }
    ps.stage = "needs_review";
    log(ps, "stage -> needs_review");
  } else if (rec.status === "awaiting_signature") {
    // Clean batch: any earlier review work is obsolete.
    const closed = closeOpenTasks(ps, ["review_anomalies", "classify_tail", "revalidate"], "resolved — batch re-validated clean");
    if (closed.length) nextSteps.push(`Auto-closed ${closed.length} earlier review task(s) — batch is now clean`);
    const t = addTask(ps, { kind: "sign", assignee: "professional", title: `Review and sign the LIPE for ${rec.period}`, due: rec.deadline || null });
    nextSteps.push(`Opened task for the professional: ${t.title}${rec.deadline ? ` (due ${rec.deadline})` : ""}`);
    if (rec.deadline) {
      const remindOn = addDays(rec.deadline, -7);
      ps.reminders.push({ id: nextId("rem"), on: remindOn, text: `LIPE ${rec.period} still unsigned — filing deadline ${rec.deadline}`, fired: false });
      nextSteps.push(`Scheduled signature reminder for ${remindOn} (7 days before the deadline)`);
    }
    ps.stage = "awaiting_signature";
    log(ps, "stage -> awaiting_signature");
  } else {
    nextSteps.push(`Status "${rec.status}" has no TeamSystem action defined — recorded only.`);
  }

  persist();
  return { stage: ps.stage, nextSteps, period: rec.period, newMessages };
}

export function periodStage(clientId, period) { return state[clientId]?.periods[period]?.stage || null; }

/** The client's data was edited. If a signature was pending (or given), what was
 *  validated is no longer what would be signed — so it goes back to re-validation. */
export function noteEdit(clientId, period, summary) {
  const ps = state[clientId]?.periods[period];
  if (!ps) return { stage: null, invalidated: false };
  log(ps, "data edited", summary);
  let invalidated = false;
  if (ps.stage === "awaiting_signature" || ps.stage === "signed") {
    closeOpenTasks(ps, ["sign", "transmit"], "data changed after validation");
    addTask(ps, { kind: "revalidate", assignee: "studio", title: `Re-run validation for ${period} — data was edited after it was validated`, due: ps.deadline || null });
    ps.stage = "ready_for_revalidation"; invalidated = true;
    log(ps, "stage -> ready_for_revalidation", "edit invalidated the pending signature");
  }
  persist();
  return { stage: ps.stage, invalidated };
}

/** Record how a client message was actually delivered (email sent / failed). */
export function markDelivery(clientId, period, messageId, delivery) {
  const m = state[clientId]?.periods[period]?.outbox.find((x) => x.id === messageId);
  if (!m) return false;
  m.delivery = { ...delivery, at: iso(Date.now()) };
  persist();
  return true;
}

/** Everything TeamSystem holds for one client's workflow. */
export function getWorkflow(clientId) {
  const cs = state[clientId];
  return { writeBacks: cs?.writeBacks || [], periods: cs ? Object.values(cs.periods) : [] };
}
export function getWriteBacks(clientId) { return state[clientId]?.writeBacks || []; }

function refreshReviewStage(ps) {
  if (ps.stage !== "needs_review") return;
  const stillOpen = ps.tasks.some((t) => t.status === "open" && ["review_anomalies", "classify_tail"].includes(t.kind));
  if (!stillOpen) {
    ps.stage = "ready_for_revalidation";
    const t = addTask(ps, { kind: "revalidate", assignee: "studio", title: `Re-run validation for ${ps.period} in Agent Desk`, due: ps.deadline || null });
    log(ps, "stage -> ready_for_revalidation", "all review tasks done");
    return t;
  }
  return null;
}

/** Mark a task done. If that was the last review task, TeamSystem moves the
 *  period on to re-validation by itself. */
export function completeTask(clientId, period, taskId) {
  const ps = state[clientId]?.periods[period];
  const t = ps?.tasks.find((x) => x.id === taskId);
  if (!t) return { ok: false, status: 404, error: "no such task" };
  if (t.status === "done") return { ok: false, status: 409, error: "task already done" };
  if (t.kind === "sign") return { ok: false, status: 409, error: "the signature task is completed by signing, not by ticking it off" };
  t.status = "done"; t.completedAt = iso(Date.now());
  log(ps, `task done: ${t.title}`);
  const followUp = refreshReviewStage(ps);
  persist();
  return { ok: true, stage: ps.stage, followUp: followUp ? followUp.title : null };
}

/** The professional signs. Only valid while the period is awaiting signature —
 *  a batch with open problems cannot be signed. */
export function sign(clientId, period, signedBy) {
  const ps = state[clientId]?.periods[period];
  if (!ps) return { ok: false, status: 404, error: "no workflow for that period" };
  if (ps.stage !== "awaiting_signature") return { ok: false, status: 409, error: `cannot sign while the period is "${ps.stage}" — it must be awaiting_signature` };
  closeOpenTasks(ps, ["sign"], `signed by ${signedBy || "professional"}`);
  ps.signedBy = signedBy || "professional";
  ps.stage = "signed";
  addTask(ps, { kind: "transmit", assignee: "professional", title: `Transmit the signed LIPE for ${period} to the Agenzia delle Entrate`, due: ps.deadline || null });
  log(ps, "signed", ps.signedBy);
  persist();
  return { ok: true, stage: ps.stage };
}

/** Transmit to the Agenzia (mock): issues a protocol + receipt, files the period. */
export function transmit(client, period) {
  const ps = state[client.id]?.periods[period];
  if (!ps) return { ok: false, status: 404, error: "no workflow for that period" };
  if (ps.stage !== "signed") return { ok: false, status: 409, error: `cannot transmit while the period is "${ps.stage}" — it must be signed first` };
  const n = Object.values(state).reduce((a, c) => a + Object.values(c.periods).filter((p) => p.protocol).length, 0) + 1;
  ps.protocol = `LIPE-${period}-${String(client.piva).slice(-4)}-${String(n).padStart(4, "0")}`;
  ps.receipt = { protocol: ps.protocol, receivedByAdE: iso(Date.now()), outcome: "accepted (mock)" };
  closeOpenTasks(ps, ["transmit"], `filed as ${ps.protocol}`);
  ps.stage = "filed";
  ps.reminders.forEach((r) => { r.fired = true; r.cancelled = true; });
  log(ps, "filed", ps.protocol);
  persist();
  return { ok: true, stage: ps.stage, protocol: ps.protocol, receipt: ps.receipt };
}

/** Fire every reminder that is due on or before `asOf` (default: now). Returns
 *  the ones fired — each becomes a client-outbox / task escalation entry. */
export function fireDueReminders(asOf = dateOnly(Date.now())) {
  const fired = [];
  for (const [clientId, cs] of Object.entries(state)) {
    for (const ps of Object.values(cs.periods)) {
      for (const r of ps.reminders) {
        if (r.fired || r.cancelled || r.on > asOf) continue;
        r.fired = true;
        log(ps, "reminder fired", r.text);
        if (ps.stage === "needs_review") {
          const m = { id: nextId("msg"), to: clientId, status: "sent", template: "9.3 Reminder / escalation notice", subject: `Reminder — request for ${ps.period} still open`, body: r.text, sentAt: iso(Date.now()) };
          ps.outbox.push(m);
          fired.push({ clientId, period: ps.period, text: r.text, message: { id: m.id, subject: m.subject, body: m.body } });
          continue;
        } else {
          addTask(ps, { kind: "escalation", assignee: "professional", title: r.text, due: ps.deadline || null });
        }
        fired.push({ clientId, period: ps.period, text: r.text });
      }
    }
  }
  if (fired.length) persist();
  return fired;
}
