// backend/scenario/vatFilingPath.mjs
// Drives the pre-filing validation demo end-to-end on mocks, emitting the events
// the UI renders. It begins in TeamSystem and ends at a human gate before the
// Agenzia delle Entrate — the agent never transmits by itself.
import { publish } from "../bus.mjs";
import * as evidence from "../memory/evidenceStore.mjs";
import { makeMessage } from "../../contracts/a2aSchema.mjs";
import { validateBatch } from "../validator.mjs";
import { classifyLine } from "../classifier.mjs";
import { requestClassificationConfirmation } from "../classificationGate.mjs";
import * as archivista from "../archivista.mjs";
import * as teamSystem from "../connectors/teamSystem.mjs";
import * as ade from "../connectors/adePortal.mjs";
import * as La from "../lAmministrativo.mjs";
import lAmministrativoManifest from "../../contracts/seats/l_amministrativo.json" with { type: "json" };

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const a2a = (m) => publish("a2a", { message: makeMessage(m) });
const feed = (agent, text, tone = "info") => publish("feed", { agent, text, tone });

/** The real Italian LIPE deadline: last day of the second month after the
 *  quarter ends (e.g. 2026-Q3 -> 30 Nov 2026). Used on the write-back so
 *  "the deadline" is an actual computed date, not a placeholder. */
function computeVatDeadline(periodId) {
  const m = /^(\d{4})-Q(\d)$/.exec(periodId || "");
  if (!m) return null;
  const year = Number(m[1]), quarter = Number(m[2]);
  const endMonth1Indexed = quarter * 3 + 2; // Q3 -> month 11 (November)
  const deadlineYear = year + Math.floor((endMonth1Indexed - 1) / 12);
  const normMonth = ((endMonth1Indexed - 1) % 12) + 1;
  const lastDay = new Date(deadlineYear, normMonth, 0).getDate(); // day 0 of next month = last day of this one
  return `${deadlineYear}-${String(normMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

/** A one-line, plain-language summary of an anomaly — the same sentence
 *  vatRules.mjs already writes into `message`, just without assuming the
 *  reader knows what a rule ID means. */
function describeAnomaly(an) {
  return an.message || `${an.kind.replace(/_/g, " ")}${an.supplier ? ` — ${an.supplier}` : ""}`;
}

export async function runVatFilingPath(clientId = "rossi_srl") {
  publish("board", { step: "start", label: "Pre-filing validation started" });

  // 1 — TeamSystem compiles the periodic VAT/LIPE/F24 batch from the ledger,
  // and hands over the client's master data + chart of accounts (the
  // rate<->category table) alongside it — all three come from the
  // TeamSystem Firm mock now, not a direct import of one fixture client.
  const master = await teamSystem.readMasterData(clientId);
  const vatBatch = await teamSystem.readVatBatch(clientId);
  const priorPeriod = await teamSystem.readPriorPeriod(clientId);
  const chartOfAccounts = await teamSystem.readChartOfAccounts(clientId);
  const period = vatBatch.period;
  feed("teamsystem", `TeamSystem compiled the ${vatBatch.kind} batch for ${master.name} (${period}) from the ledger.`);
  publish("board", { step: "batch", label: `${master.name} — batch ${period}: ${vatBatch.lines.length} lines` });
  await wait(600);

  // 2 — L'Addetto IVA validates completeness, coherence, prior periods & VAT rules.
  let received = [];
  let { tail, anomalies } = validateBatch(vatBatch, { receivedDocs: received, priorPeriod, taxonomy: chartOfAccounts, vatGroup: master.vatGroup, formatAnomalies: vatBatch.formatAnomalies });
  feed("l_addetto_iva", `Validated vs prior periods: ${tail.length} low-confidence line(s), ${anomalies.length} anomaly(ies).`,
       tail.length || anomalies.length ? "warn" : "good");
  publish("board", {
    step: "validated",
    label: (tail.length === 0 && anomalies.length === 0)
      ? "Checked — everything looks correct, nothing needs attention"
      : `Checked — ${tail.length ? `${tail.length} line${tail.length === 1 ? "" : "s"} need${tail.length === 1 ? "s" : ""} a category` : ""}${tail.length && anomalies.length ? ", " : ""}${anomalies.length ? `${anomalies.length} problem${anomalies.length === 1 ? "" : "s"} found` : ""}`,
  });
  await wait(700);

  // 3 — Solve the low-confidence tail (pre-fill): Il Classificatore.
  for (const line of tail) {
    const r = await classifyLine(line, vatBatch.client, chartOfAccounts);
    publish("coa", { supplier: line.supplier, account: r.account, confidence: r.confidence, options: chartOfAccounts });
    feed("il_classificatore", `Tail line ${line.id} (${line.supplier}) -> account ${r.account} @ conf ${r.confidence}.`);
    await wait(500);

// 5 (memory) — low confidence -> a REAL gate: the run pauses here until a
// human actually approves or denies it via POST /api/gate/:id/approve|deny
// (same mechanism as the invoice-approval gate below) — confirmed at the
// gate -> rule saved, under whoever's name actually approved it.
    if (r.needsHuman) {
      publish("board", { step: "ask", label: `Line ${line.id}: low confidence — waiting for a human to confirm ${r.account}` });
      const ev = evidence.put({ kind: "tail_line", supplier: line.supplier, line: line.id, period });
      publish("evidence", { record: ev });

      const gate = requestClassificationConfirmation(vatBatch.client, line, r);
      publish("gate", { id: gate.id, clientId: vatBatch.client, action: gate.action, payload: gate.payload, status: "pending" });
      feed("il_classificatore", `Waiting for a human to confirm ${line.supplier} -> ${r.account} (gate ${gate.id}).`, "warn");

      const outcome = await gate.decision.then((d) => ({ approved: true, ...d })).catch((e) => ({ approved: false, error: e.message }));
      publish("gate", { id: gate.id, clientId: vatBatch.client, status: outcome.approved ? "approved" : "denied" });

      if (!outcome.approved) {
        feed("l_archivista", `Classification for ${line.supplier} was declined — stays unclassified in the tail.`, "warn");
        await wait(400);
        continue;
      }

      const rule = archivista.learnConfirmed({
        key: `client:${vatBatch.client}:coa:${line.supplier}`, kind: "coa_mapping", scope: `client:${vatBatch.client}`,
        value: outcome.account, confirmedBy: outcome.approvedBy || "unknown", evidenceId: ev.id,
      });
      publish("knowledge", { record: rule, note: "Rule confirmed at the gate and stored — auto-applied next period." });
      feed("l_archivista", `Rule saved to Cortex: ${line.supplier} -> ${outcome.account} (conf 0.98), confirmed by ${outcome.approvedBy || "unknown"}. Tail shrinks next period.`, "good");
      await wait(400);
    }
  }

  // 4 — Act on each anomaly. A missing document routes through Lo Smistatore
  // to the real L'Amministrativo; a VAT-rule or prior-period anomaly is a
  // correction request instead (Rulebook Section 9.2) — the record is held
  // either way until it clears.
  for (const an of anomalies) {
    if (an.kind !== "item_missing") {
      feed("l_addetto_iva", `Anomaly (${an.ruleId}): ${an.message}`, "warn");
      publish("board", { step: "flagged", label: `Problem found — ${describeAnomaly(an)}` });
      const ev = evidence.put({ kind: "anomaly", ruleId: an.ruleId, detail: an, period });
      publish("evidence", { record: ev });
      feed("lo_smistatore", "Correction request queued for the client (template 9.2 — request for correction).", "info");
      await wait(600);
      continue;
    }

    a2a({ type: "instruction_from_studio", from: "lo_smistatore", to: "l_amministrativo", client: vatBatch.client,
          instruction: `fetch ${an.expected.replace(/^invoice\s+/, "")} for ${an.period}`, due: an.period });
    feed("lo_smistatore", `Anomaly routed to the client agent: ${an.expected}.`);
    await wait(600);

    // Checks the bank feed + SDI inbox first; 
    // if genuinely missing it opens a tracked request with its own reminder/escalation ladde.
    const result = await La.handleInstructionFromStudio(lAmministrativoManifest, vatBatch.client, {
      instruction: `fetch ${an.expected.replace(/^invoice\s+/, "")} for ${an.period}`,
    });

    if (result.ack) publish("a2a", { message: result.ack }); // acknowledged before any of the actual work below
    if (result.a2a) publish("a2a", { message: result.a2a });

    if (result.askedOwner) {
      feed("l_amministrativo", `Missing invoice not on file — asked the owner on WhatsApp (request ${result.requestId}).`);
      await wait(1200);
      // In the real flow this waits for the owner's WhatsApp reply or a later
      // SDI-inbox poll. The demo simulates the reply arriving here, but goes
      // through the real resolveDocumentRequest() path
      const sdiId = "IT" + Math.floor(Math.random() * 900 + 100);
      const resolved = La.resolveDocumentRequest(result.requestId, { foundVia: "owner_reply", sdiId });
      if (resolved) {
        publish("evidence", { record: resolved.evidence });
        publish("a2a", { message: resolved.a2a });
        a2a({ from: "lo_smistatore", to: "l_amministrativo", client: vatBatch.client, type: "acknowledgment", ref: sdiId });
      }
      feed("l_addetto_iva", "Missing invoice received — re-inserted into the batch.", "good");
      vatBatch.lines.push({ id: "L5", supplier: "Verdi Srl", desc: "Fornitura mensile", net: 600.0, vat: 132.0, account: "30.10", confidence: 0.95 });
      received.push({ supplier: "Verdi Srl", period: an.period });
    } else if (result.found) {
      feed("l_addetto_iva", "L'Amministrativo found the invoice on the client's own systems — no need to ask the owner.", "good");
      vatBatch.lines.push({ id: "L5", supplier: "Verdi Srl", desc: "Fornitura mensile", net: 600.0, vat: 132.0, account: "30.10", confidence: 0.95 });
      received.push({ supplier: "Verdi Srl", period: an.period });
    }
    await wait(700);
  }

  // 4c-4f — L'Amministrativo's other skills (memory answers, escalation,
  // proactive pack delivery, the owner-approval gate). These are specific
  // demo beats written against Rossi Srl's own data (a named expense, a
  // named draft customer) — they only make sense for that one client, so
  // they're gated here rather than replayed nonsensically against every
  // other client in the mock.
  if (clientId === "rossi_srl") {
    // 4c — Answer-from-memory demo
    const loggedExpense = await La.logAttendanceOrExpense(lAmministrativoManifest, vatBatch.client, {
      kind: "expense", id: "pranzo-cliente-rossi", amount: 42, note: "Pranzo di lavoro con il cliente",
    });
    if (loggedExpense.evidence) {
      publish("evidence", { record: loggedExpense.evidence });
      feed("l_amministrativo", "Logged a client expense (pranzo-cliente-rossi, €42) to its own client memory.");
      await wait(500);

      a2a({ type: "instruction_from_studio", from: "lo_smistatore", to: "l_amministrativo", client: vatBatch.client,
            instruction: "what was the pranzo-cliente-rossi expense?" });
      feed("lo_smistatore", "Studio asked about a specific expense.");
      await wait(500);

      const answered = await La.handleInstructionFromStudio(lAmministrativoManifest, vatBatch.client, {
        instruction: "what was the pranzo-cliente-rossi expense?",
      });
      if (answered.ack) publish("a2a", { message: answered.ack });
      if (answered.a2a) publish("a2a", { message: answered.a2a });
      feed("l_amministrativo",
        answered.answeredFromMemory
          ? "Already had this in its own memory — answered directly instead of escalating."
          : "Didn't recognise this from memory — escalated to the studio instead.",
        answered.answeredFromMemory ? "good" : "warn");
      await wait(600);
    }

    // 4d — Escalation demo
    a2a({ type: "instruction_from_studio", from: "lo_smistatore", to: "l_amministrativo", client: vatBatch.client,
          instruction: "what is the client's current ATECO code?" });
    feed("lo_smistatore", "Studio asked something this seat has no record of.");
    await wait(500);

    const escalated = await La.handleInstructionFromStudio(lAmministrativoManifest, vatBatch.client, {
      instruction: "what is the client's current ATECO code?",
    });
    if (escalated.ack) publish("a2a", { message: escalated.ack });
    if (escalated.a2a) publish("a2a", { message: escalated.a2a });
    feed("l_amministrativo",
      escalated.questionId
        ? `Doesn't know this — escalated to the studio rather than guessing (open question ${escalated.questionId}).`
        : "Unexpected: this should have escalated.",
      "warn");
    await wait(600);

    // 4e — Proactive delivery
    publish("board", { step: "pack", label: "L'Amministrativo assembles and delivers the monthly pack" });
    const packResult = await La.deliverMonthlyPack(vatBatch.client, period);
    publish("evidence", { record: packResult.evidence });
    publish("a2a", { message: packResult.a2a });
    feed("l_amministrativo",
      `Monthly pack delivered for ${period}: ${packResult.pack.docs.length} doc(s), ${packResult.pack.missing.length} still missing, ${packResult.pack.questions.length} open question(s).`,
      "good");
    await wait(700);

    // 4f — Owner-approval gate demo
    publish("board", { step: "gate_open", label: "L'Amministrativo: invoice drafted — waiting for owner approval" });
    let ticketId;
    const gatePromise = La.draftAndSendInvoice(lAmministrativoManifest, vatBatch.client, { customer: "Cliente Demo Srl", amount: 950 }, {
      onTicket: (ticket) => {
        ticketId = ticket.id;
        feed("l_amministrativo", `Invoice drafted for Cliente Demo Srl (€950) — owner approval required (gate ${ticket.id}).`, "warn");
        publish("gate", { id: ticket.id, clientId: vatBatch.client, action: ticket.action, payload: ticket.payload, status: "pending" });
      },
    });

    const outcome = await gatePromise.then((r) => ({ status: "approved", r })).catch((e) => ({ status: "denied", error: e.message }));
    feed("l_amministrativo", `Gate ${ticketId} resolved: ${outcome.status}.`, outcome.status === "approved" ? "good" : "warn");
    publish("gate", { id: ticketId, clientId: vatBatch.client, status: outcome.status });
  }

  // 6 — Re-assemble + prove; re-validate to show it now passes clean.
  const recheck = validateBatch(vatBatch, { receivedDocs: received, priorPeriod, taxonomy: chartOfAccounts, vatGroup: master.vatGroup, formatAnomalies: vatBatch.formatAnomalies });
  const stillOpen = recheck.tail.length + recheck.anomalies.length;
  publish("board", {
    step: "reassembled",
    label: stillOpen === 0
      ? "Re-checked after the fixes — everything is now correct"
      : `Re-checked after the fixes — ${stillOpen} item${stillOpen === 1 ? "" : "s"} still need${stillOpen === 1 ? "s" : ""} attention`,
  });
  const prepared = await ade.prepareSubmission(vatBatch);
  feed("l_addetto_iva", `Batch re-assembled and pre-validated (${prepared.protocolDraft}). Ready for signature.`, "good");
  await wait(600);

  // 7 — Human gate: the agent REFUSES to transmit; the professional signs & sends.
  publish("board", { step: "gate", label: "Human gate — professional signs & sends to the Agenzia" });
  try {
    await ade.transmit(); // hard refusal, by design
  } catch (e) {
    feed("l_addetto_iva", String(e.message), "warn");
  }
  await wait(500);

  // write-back to TeamSystem: a real status + a real computed deadline, not
  // a hardcoded string. The mock renders this as a notification in the
  // client's own tab — this is what that notification actually says.
  const deadline = computeVatDeadline(period);
  const summary = stillOpen === 0
    ? `Batch validated and clean for ${period} — ready for the professional's signature.`
    : `Batch prepared for ${period} with ${stillOpen} item${stillOpen === 1 ? "" : "s"} still open — professional review needed before signing.`;
  const wb = await teamSystem.writeBack(vatBatch.client, period, {
    status: "awaiting_signature", summary, deadline, tailCount: recheck.tail.length, anomalyCount: recheck.anomalies.length,
  });
  publish("board", { step: "writeback", label: wb.deliveredToFirm ? `Sent back to TeamSystem — deadline ${deadline}` : "Couldn't reach TeamSystem — filing update saved locally only" });
  feed("teamsystem",
    wb.deliveredToFirm
      ? `Sent back to TeamSystem: ${summary} Deadline: ${deadline}.`
      : `TeamSystem wasn't reachable — this filing update did NOT reach it, saved locally only.`,
    wb.deliveredToFirm ? "good" : "warn");

  publish("board", { step: "done", label: "Pre-filing validation complete" });
  return { ok: true };
}
