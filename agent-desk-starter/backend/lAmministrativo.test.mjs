// backend/lAmministrativo.test.mjs
// Run with: node --test backend/lAmministrativo.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import * as La from "./lAmministrativo.mjs";
import { pendingGates, pendingDocumentRequests, pendingQuestions, pendingCorrections, handleCorrectionRequest, resolveCorrection, deliverMonthlyPack } from "./lAmministrativo.mjs";

const FULL_MANIFEST = {
  seat: "l_amministrativo",
  skills: [
    "raccolta_documenti", "fatturazione", "incassi_e_solleciti",
    "presenze_note_spese", "sportello_dipendenti", "scadenze_pagamenti",
    "domande_allo_studio",
  ],
};
const CLIENT = "rossi_srl";

test("collectDocument: not found -> asks owner, tells studio via item_missing", async () => {
  const r = await La.collectDocument(FULL_MANIFEST, CLIENT, { docType: "invoice", supplier: "Verdi Srl", period: "2026-Q3" });
  assert.equal(r.found, false);
  assert.equal(r.askedOwner, true);
  assert.equal(r.a2a.type, "item_missing");
  assert.equal(r.a2a.to, "lo_smistatore"); // never anyone else
  assert.ok(r.requestId, "should open a tracked document request");
  La.resolveDocumentRequest(r.requestId, { sdiId: "IT999" }); // cleanup — stop its ladder
});

test("collectDocument: the document request reminds, then escalates if the owner never replies", async () => {
  const events = [];
  const off = La.onLadderEvent((e) => events.push(e));
  const r = await La.collectDocument(FULL_MANIFEST, CLIENT, {
    docType: "invoice", supplier: "Test Supplier", period: "2026-Q4",
    ladder: { reminderDelaysMs: [10], escalateAfterMs: 25 },
  });
  await new Promise((res) => setTimeout(res, 35));
  off();
  const reminder = events.find((e) => e.event === "reminder" && e.requestId === r.requestId);
  const escalate = events.find((e) => e.event === "escalate" && e.requestId === r.requestId);
  assert.ok(reminder, "should have reminded once");
  assert.ok(escalate, "should have escalated after the deadline");
  assert.equal(escalate.escalation.type, "escalation_requested");
  assert.equal(pendingDocumentRequests.get(r.requestId).status, "pending", "escalation must not fabricate the document — still needs a real reply");
  La.resolveDocumentRequest(r.requestId, { sdiId: "IT998" }); // cleanup
});

test("resolveDocumentRequest: cancels the ladder and reports document_delivered", async () => {
  const r = await La.collectDocument(FULL_MANIFEST, CLIENT, {
    docType: "invoice", supplier: "Another Supplier", period: "2026-Q1",
    ladder: { reminderDelaysMs: [15], escalateAfterMs: 30 },
  });
  const resolved = La.resolveDocumentRequest(r.requestId, { sdiId: "IT777" });
  assert.equal(resolved.a2a.type, "document_delivered");
  assert.equal(pendingDocumentRequests.has(r.requestId), false);

  const events = [];
  const off = La.onLadderEvent((e) => events.push(e));
  await new Promise((res) => setTimeout(res, 40)); // long enough that reminder/escalate WOULD fire if not cancelled
  off();
  assert.equal(events.filter((e) => e.requestId === r.requestId).length, 0, "no ladder events after resolution");

  const second = La.resolveDocumentRequest(r.requestId, {});
  assert.equal(second, null, "resolving an already-resolved (or unknown) request is a safe no-op");
});

test("prepareDocumentRequestResolution leaves local state pending until durable publish commits", async () => {
  const request = await La.collectDocument(FULL_MANIFEST, CLIENT, {
    docType: "invoice", supplier: "Durability Supplier", period: "2099-Q4",
  });
  const prepared = La.prepareDocumentRequestResolution(request.requestId, { sdiId: "IT-DURABLE" });
  assert.equal(prepared.a2a.type, "document_delivered");
  assert.equal(pendingDocumentRequests.has(request.requestId), true);
  const resolved = prepared.commit();
  assert.ok(resolved.evidence);
  assert.equal(pendingDocumentRequests.has(request.requestId), false);
  assert.equal(prepared.commit(), resolved, "commit is idempotent for a successful prepared resolution");
});

test("handleInstructionFromStudio: routes a recognised 'fetch X for Y' instruction", async () => {
  const r = await La.handleInstructionFromStudio(FULL_MANIFEST, CLIENT, { instruction: "fetch Verdi Srl for 2026-Q3" });
  assert.equal(r.a2a.type, "item_missing"); // falls through to collectDocument, same as above
  La.resolveDocumentRequest(r.requestId, {}); // cleanup
});

test("handleInstructionFromStudio: an unrecognised instruction escalates rather than guesses", async () => {
  const r = await La.handleInstructionFromStudio(FULL_MANIFEST, CLIENT, { instruction: "do something vague" });
  assert.equal(r.a2a.type, "question_for_studio");
  assert.equal(r.a2a.topic, "unrecognised_instruction");
  assert.ok(r.questionId, "escalating should open a tracked question");
  pendingQuestions.delete(r.questionId); // cleanup — leave pendingQuestions clean for later tests
});

test("handleInstructionFromStudio: always acknowledges receipt, separately from the actual result", async () => {
  const r = await La.handleInstructionFromStudio(FULL_MANIFEST, CLIENT, { instruction: "fetch Ack Test Srl for 2026-Q2" });
  assert.equal(r.ack.type, "acknowledgment");
  assert.equal(r.ack.to, "lo_smistatore");
  assert.notEqual(r.ack.type, r.a2a.type, "the acknowledgment and the actual result are two separate messages");
  La.resolveDocumentRequest(r.requestId, {}); // cleanup
});

test("handleInstructionFromStudio: answers from its own memory instead of escalating when it already knows", async () => {
  const logged = await La.logAttendanceOrExpense(FULL_MANIFEST, CLIENT, { kind: "expense", id: "trasferta-milano-test", amount: 88, note: "test expense" });
  assert.ok(logged.evidence, "the expense should be logged with evidence");

  const r = await La.handleInstructionFromStudio(FULL_MANIFEST, CLIENT, { instruction: "can you tell me about trasferta-milano-test?" });
  assert.equal(r.answeredFromMemory, true);
  assert.equal(r.a2a.type, "answer_with_evidence");
  assert.ok(r.a2a.answer.includes("trasferta-milano-test"));
  assert.equal(r.a2a.evidenceId, logged.evidence.id);
});

test("askStudio: tracks the outstanding question; resolveQuestion closes the oldest pending one for that client", async () => {
  const r1 = await La.askStudio(FULL_MANIFEST, CLIENT, "topic_one", "first question");
  assert.ok(r1.questionId);
  assert.equal(pendingQuestions.get(r1.questionId).status, "pending");

  const resolved = La.resolveQuestion(CLIENT, { answer: "here you go", evidenceId: "ev_test" });
  assert.equal(resolved.id, r1.questionId, "should resolve the oldest pending question for this client");
  assert.equal(pendingQuestions.has(r1.questionId), false);

  const none = La.resolveQuestion(CLIENT, {});
  assert.equal(none, null, "resolving with nothing pending is a safe no-op");
});

test("resolveQuestionById: resolves the exact question by id, unaffected by other pending questions", async () => {
  const older = await La.askStudio(FULL_MANIFEST, CLIENT, "topic_older", "asked first");
  const target = await La.askStudio(FULL_MANIFEST, CLIENT, "topic_target", "asked second, but this is the one we resolve");

  const resolved = La.resolveQuestionById(target.questionId, { answer: "specific answer", evidenceId: "ev_specific" });
  assert.equal(resolved.id, target.questionId, "must resolve the exact one asked for, not the oldest");
  assert.equal(resolved.answer, "specific answer");
  assert.equal(pendingQuestions.has(target.questionId), false);
  assert.equal(pendingQuestions.has(older.questionId), true, "the older, unrelated question must be untouched");

  assert.equal(La.resolveQuestionById(target.questionId, {}), null, "resolving an already-resolved id is a safe no-op");
  assert.equal(La.resolveQuestionById("not_a_real_id", {}), null, "resolving an unknown id is a safe no-op");

  pendingQuestions.delete(older.questionId); // cleanup
});

test("deliverMonthlyPack: summarises docs, missing requests and open questions, then sends pack_delivered", async () => {
  const packPeriod = "2099-PACKTEST"; // isolated period so this can't collide with anything another test wrote
  const collected = await La.collectDocument(FULL_MANIFEST, CLIENT, { docType: "invoice", supplier: "Pack Supplier", period: packPeriod });
  assert.equal(collected.found, false); // opens a document request — this is the "missing" case the pack should report

  const result = await La.deliverMonthlyPack(CLIENT, packPeriod);
  assert.equal(result.a2a.type, "pack_delivered");
  assert.equal(result.a2a.period, packPeriod);
  assert.equal(result.pack.missing.length, 1);
  assert.equal(result.pack.missing[0].supplier, "Pack Supplier");
  assert.equal(result.pack.docs.length, 0, "nothing was actually found for this period");

  La.resolveDocumentRequest(collected.requestId, {}); // cleanup
});

test("draftAndSendInvoice: blocks until the owner approves, then sends", async () => {
  const pending = La.draftAndSendInvoice(FULL_MANIFEST, CLIENT, { customer: "Bianchi Studio", amount: 1220 }, {
    ladder: { reminderDelaysMs: [], escalateAfterMs: null }, // no ladder noise for this test
  });
  let settledEarly = false;
  pending.then(() => { settledEarly = true; }).catch(() => {});
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(settledEarly, false, "must not send before the gate is approved");

  // resolve it via whichever ticket draftAndSendInvoice just opened
  const [ticket] = [...pendingGates.values()].filter((t) => t.action === "invoice");
  ticket.approve("owner_mario");
  const result = await pending;
  assert.equal(result.approval.approvedBy, "owner_mario");
});

test("requestOwnerApproval: deny() rejects the decision promise", async () => {
  const ticket = La.requestOwnerApproval(CLIENT, "invoice", { demo: true }, { reminderDelaysMs: [], escalateAfterMs: null });
  ticket.deny("not now");
  await assert.rejects(() => ticket.decision, /not now/);
});

test("requestOwnerApproval: reminder ladder fires, then stops once approved", async () => {
  const events = [];
  const off = La.onLadderEvent((e) => events.push(e));
  const ticket = La.requestOwnerApproval(CLIENT, "invoice", { demo: true }, { reminderDelaysMs: [10, 25], escalateAfterMs: 40 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ticket.remindersSent, 1, "one reminder should have fired by t+20ms");
  ticket.approve("owner_mario");
  await ticket.decision;
  await new Promise((r) => setTimeout(r, 40)); // long enough that the 2nd reminder / escalation WOULD have fired if not cancelled
  off();
  const remindersAfterApproval = events.filter((e) => e.event === "reminder" && e.gateId === ticket.id).length;
  assert.equal(remindersAfterApproval, 1, "the ladder must stop once approved — no reminders after that");
  assert.equal(events.some((e) => e.event === "escalate" && e.gateId === ticket.id), false, "must not escalate after approval");
  assert.equal(pendingGates.has(ticket.id), false, "an approved gate must be removed from pendingGates");
});

test("requestOwnerApproval: escalates via A2A to lo_smistatore if never resolved, but never auto-approves", async () => {
  const events = [];
  const off = La.onLadderEvent((e) => events.push(e));
  const ticket = La.requestOwnerApproval(CLIENT, "invoice", { demo: true }, { reminderDelaysMs: [], escalateAfterMs: 15 });
  await new Promise((r) => setTimeout(r, 30));
  off();
  assert.equal(ticket.status, "pending", "escalation must not resolve the gate — the owner still decides");
  const esc = events.find((e) => e.event === "escalate" && e.gateId === ticket.id);
  assert.ok(esc, "an escalate event should have fired");
  assert.equal(esc.escalation.type, "escalation_requested");
  assert.equal(esc.escalation.to, "lo_smistatore");
  ticket.deny("cleanup"); // avoid leaving a dangling pending promise for the test process
  ticket.decision.catch(() => {}); // the deny() above already rejects it — this just silences the unhandled-rejection warning
});

test("sportello_dipendenti escalates a question instead of answering it", async () => {
  const r = await La.answerEmployeeQuestion(FULL_MANIFEST, CLIENT, "employee_1", "should I deduct this?");
  assert.equal(r.escalated, true);
  assert.equal(r.a2a.type, "question_for_studio");
});

test("scadenze_pagamenti tracks and reminds without ever touching payment execution", async () => {
  const r = await La.trackDeadline(FULL_MANIFEST, CLIENT, { what: "F24", due: "2026-09-20", reminderWindowDays: 30 });
  assert.equal(r.tracked, true);
  assert.equal(typeof r.daysLeft, "number");
});

test("a skill switched off for this client is a no-op, not a silent broad grant", async () => {
  const limited = { seat: "l_amministrativo", skills: ["raccolta_documenti"] };
  const r = await La.sendReminder(limited, CLIENT, { name: "Cliente X", amount: 500, due: "2026-10-01" });
  assert.equal(r.skipped, true);
  assert.equal(r.skill, "incassi_e_solleciti");
});

test("the four hard blocks always refuse, unconditionally", () => {
  assert.throws(() => La.executePayment(), /REFUSED.*payments/);
  assert.throws(() => La.sendToAuthority(), /REFUSED.*send_to_authority/);
  assert.throws(() => La.giveTaxAdvice(), /REFUSED.*tax_advice/);
  assert.throws(() => La.contactStudioStaffDirectly(), /REFUSED.*contact_studio_staff/);
});

test("handleCorrectionRequest: relays to the owner, acknowledges, tracks, and the owner's answer becomes answer_with_evidence", async () => {
  const manifest = { skills: [] }; // relaying a studio request is not one of the 7 switchable skills
  const sent = [];
  const runtime = {
    sendOwner: async (template, vars) => { sent.push({ template, vars }); return { ok: true }; },
    toStudio: (m) => m,
    scheduleLadder: false,
  };
  const out = await handleCorrectionRequest(manifest, "client-corr", { ruleId: "VAT-3", message: "Rate 22% on exempt line", period: "2099-Q3" }, runtime);
  assert.equal(out.askedOwner, true);
  assert.equal(out.ack.type, "acknowledgment");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].template, "confirm_correction");
  assert.deepEqual(sent[0].vars, { rule: "VAT-3", period: "2099-Q3", detail: "Rate 22% on exempt line" });
  assert.equal(pendingCorrections.get(out.correctionId).status, "pending");

  const res = resolveCorrection(out.correctionId, { answer: "Line 4 is exempt, art. 10", confirmedBy: "owner" });
  assert.equal(res.a2a.type, "answer_with_evidence");
  assert.equal(res.a2a.to, "lo_smistatore");
  assert.equal(res.a2a.ref, out.correctionId);
  assert.equal(res.evidence.kind, "correction_answer");
  assert.equal(pendingCorrections.has(out.correctionId), false);
  assert.equal(resolveCorrection(out.correctionId, {}), null);
});

test("handleCorrectionRequest: legacy path reminds, then escalates to the studio but never closes the correction", async () => {
  const waTemplates = [];
  const out = await handleCorrectionRequest({ skills: [] }, "client-corr2",
    { ruleId: "VAT-9", message: "Missing evidence", period: "2099-Q4", ladder: { reminderDelaysMs: [10], escalateAfterMs: 40 } },
    { sendOwner: async (t) => { waTemplates.push(t); }, toStudio: (m) => m });
  await new Promise((r) => setTimeout(r, 120));
  const c = pendingCorrections.get(out.correctionId);
  assert.equal(c.status, "pending");
  assert.equal(c.escalated, true);
  assert.equal(c.escalation.type, "escalation_requested");
  assert.ok(waTemplates.length >= 2); // initial ask + at least one reminder
  resolveCorrection(out.correctionId, { answer: "ok" });
});

test("deliverMonthlyPack lists corrections still awaiting the owner", async () => {
  const out = await handleCorrectionRequest({ skills: [] }, "client-corr3", { ruleId: "VAT-1", message: "x", period: "2099-Q5" },
    { sendOwner: async () => {}, toStudio: (m) => m, scheduleLadder: false });
  const pack = await deliverMonthlyPack("client-corr3", "2099-Q5");
  assert.deepEqual(pack.pack.corrections.map((c) => c.ruleId), ["VAT-1"]);
  resolveCorrection(out.correctionId, {});
});
