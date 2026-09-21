// backend/server.mjs — zero-framework HTTP + Server-Sent Events.
// Serves the frontend, streams bus events, exposes compile + run + gate endpoints.
import "./loadEnv.mjs"; // must be first — connector modules read process.env at import time
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { subscribe, history, publish } from "./bus.mjs";
import { makeMessage } from "../contracts/a2aSchema.mjs";
import { compile, compileWithJobText } from "./compiler.mjs";
import { runVatFilingPath } from "./scenario/vatFilingPath.mjs";
import * as teamSystem from "./connectors/teamSystem.mjs";
import {
  pendingGates, pendingDocumentRequests, pendingQuestions,
  resolveDocumentRequest, resolveQuestionById, deliverMonthlyPack, onLadderEvent,
  collectDocument, draftAndSendInvoice, sendReminder, logAttendanceOrExpense,
  answerEmployeeQuestion, trackDeadline, askStudio,
} from "./lAmministrativo.mjs";
import { onLadderEvent as onClassificationLadderEvent } from "./classificationGate.mjs";
import { route } from "./smistatore.mjs";
import { rosterFixture } from "./fixtures/roster.fixture.mjs";

// Bridge both L'Amministrativo's (owner-approval, WhatsApp-facing) and Il
// Classificatore's (studio-internal) reminder/escalation ladders onto the
// SSE bus so the frontend sees reminders and escalations live, not just the
// initial "pending" state. Wording differs by seat: only L'Amministrativo's
// reminders actually go out over WhatsApp to the client owner.
onLadderEvent((e) => bridgeLadderEvent(e, "sent to the owner"));
onClassificationLadderEvent((e) => bridgeLadderEvent(e, "still needs a studio professional to confirm it"));
function bridgeLadderEvent(e, remindPhrase) {
  publish("ladder", e);
  if (e.event === "reminder") {
    feedFromLadder(e, `reminder #${e.n} ${remindPhrase}${e.kind === "gate" ? ` (gate ${e.gateId})` : ` (request ${e.requestId})`}.`, "warn");
  } else if (e.event === "escalate") {
    feedFromLadder(e, `no response after ${e.kind === "gate" ? "the gate" : "the document request"} reminders — escalated to Lo Smistatore.`, "warn");
  }
}
function feedFromLadder(e, suffix, tone) {
  publish("feed", { agent: e.seat || "l_amministrativo", text: `${e.kind === "gate" ? "Gate" : "Document request"} ${suffix}`, tone });
}

// Bridge Lo Smistatore onto the bus: every already-signed a2a message
// addressed to it gets routed live, and the decision is published so the
// frontend can show it. Doesn't touch vatFilingPath.mjs or lAmministrativo.mjs —
// both already publish "a2a" events with a real `to`, this just reacts to them.
// >>> TODO (real): rosterFixture is a placeholder (see backend/fixtures/roster.fixture.mjs)
//     until there's a real staff directory; swap the import, nothing else changes.
subscribe((e) => {
  if (e.channel !== "a2a" || !e.message || e.message.to !== "lo_smistatore") return;
  try {
    const result = route(e.message, rosterFixture);
    publish("routing", result);
    if (result.kind === "routed_task") {
      publish("feed", {
        agent: "lo_smistatore",
        text: `Routed ${result.sourceMessageType} (${result.client}) to ${result.owner}` +
              `${result.escalated ? ` — escalated to tier ${result.escalationTier}` : ""}.`,
        tone: result.escalated ? "warn" : "info",
      });
    } else {
      publish("feed", {
        agent: "lo_smistatore",
        text: `Could not route ${result.sourceMessageType} for ${result.client} — ${result.reason}.`,
        tone: "warn",
      });
    }
  } catch (err) {
    // A malformed message or an unknown roster shape should never crash the
    // server — surface it on the feed instead, same as any other agent failure.
    publish("feed", { agent: "lo_smistatore", text: `Routing failed: ${err.message}`, tone: "warn" });
  }
});

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, "..", "frontend");
const PORT = process.env.PORT || 5173;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

function readBody(req) {
  // Collect raw Buffer chunks and decode ONCE at the end, explicitly as
  // UTF-8 — `data += chunk` coerces each Buffer independently and can also
  // split a multi-byte UTF-8 character across chunks, corrupting non-ASCII
  // text (found for real in the sibling TeamSystem Firm mock server: an em
  // dash came out as mojibake until this was fixed there too). This matters
  // here specifically because job descriptions are written in Italian.
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    for (const e of history()) res.write(`data: ${JSON.stringify(e)}\n\n`);
    const off = subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    req.on("close", off);
    return;
  }

  // GET /api/ts-clients — the roster from the TeamSystem Firm mock, for a
  // real client picker instead of a single hardcoded demo run.
  if (url.pathname === "/api/ts-clients" && req.method === "GET") {
    const list = await teamSystem.listClients();
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(list));
    return;
  }

  if (url.pathname === "/api/run-demo" || url.pathname === "/api/run-golden-path") {
    const clientId = url.searchParams.get("client") || "rossi_srl";
    // Never let a failure anywhere in the pipeline become an unhandled
    // rejection — that crashes the whole Node process (this happened for
    // real: a rejected Fatture in Cloud call took the entire server down
    // mid-demo, with no error visible in the UI, just silence).
    runVatFilingPath(clientId).catch((e) => {
      console.error("[demo] run failed:", e);
      publish("board", { step: "error", label: `Run failed for ${clientId}: ${e.message}` });
      publish("feed", { agent: "system", text: `Run failed: ${e.message}`, tone: "warn" });
    });
    res.writeHead(202).end('{"started":true}');
    return;
  }

  if (url.pathname.startsWith("/api/compile/")) {
    const seat = decodeURIComponent(url.pathname.split("/").pop());
    try {
      if (req.method === "POST") {
        const body = await readBody(req);
        const { jobText } = body ? JSON.parse(body) : {};
        const { manifest, skill, usedCustomJobText } = await compileWithJobText(seat, jobText);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ manifest, skill, usedCustomJobText }));
      } else {
        const { manifest, skill } = await compile(seat);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ manifest, skill }));
      }
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  // ---- owner-approval gate API (used by L'Amministrativo's draftAndSendInvoice) ----
  if (url.pathname === "/api/gates" && req.method === "GET") {
    const list = [...pendingGates.values()].map((t) => ({ id: t.id, clientId: t.clientId, action: t.action, payload: t.payload, status: t.status, remindersSent: t.remindersSent, escalated: t.escalated }));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(list));
    return;
  }
  const gateMatch = url.pathname.match(/^\/api\/gate\/([^/]+)\/(approve|deny)$/);
  if (gateMatch && req.method === "POST") {
    const [, id, action] = gateMatch;
    const ticket = pendingGates.get(id);
    if (!ticket) { res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "no such gate" })); return; }
    const body = await readBody(req);
    const { approvedBy, reason } = body ? JSON.parse(body) : {};
    try {
      if (action === "approve") ticket.approve(approvedBy || "owner"); else ticket.deny(reason);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, id, action }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  // ---- document-request API (used by L'Amministrativo's collectDocument) ----
  if (url.pathname === "/api/document-requests" && req.method === "GET") {
    const list = [...pendingDocumentRequests.values()].map((r) => ({ id: r.id, clientId: r.clientId, expected: r.expected, status: r.status, remindersSent: r.remindersSent, escalated: r.escalated }));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(list));
    return;
  }
  const docReqMatch = url.pathname.match(/^\/api\/document-requests\/([^/]+)\/resolve$/);
  if (docReqMatch && req.method === "POST") {
    const [, id] = docReqMatch;
    const body = await readBody(req);
    const { sdiId } = body ? JSON.parse(body) : {};
    const result = resolveDocumentRequest(id, { foundVia: "owner_reply", sdiId });
    if (!result) { res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "no such request, or already resolved" })); return; }
    publish("evidence", { record: result.evidence });
    publish("a2a", { message: result.a2a });
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, id }));
    return;
  }

  // ---- open questions to the studio (askStudio / resolveQuestion) ----
  if (url.pathname === "/api/questions" && req.method === "GET") {
    const list = [...pendingQuestions.values()].map((q) => ({ id: q.id, clientId: q.clientId, topic: q.topic, body: q.body, status: q.status, askedAt: q.askedAt }));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(list));
    return;
  }
  const questionMatch = url.pathname.match(/^\/api\/questions\/([^/]+)\/resolve$/);
  if (questionMatch && req.method === "POST") {
    const id = decodeURIComponent(questionMatch[1]);
    const question = pendingQuestions.get(id); // read before resolving, since resolving deletes it
    if (!question) { res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "no such question, or already resolved" })); return; }
    const body = await readBody(req);
    const { answer, evidenceId } = body ? JSON.parse(body) : {};
    const finalAnswer = answer || `Studio's reply to "${question.topic}".`;
    const finalEvidenceId = evidenceId || `studio_${Date.now()}`;
    // Simulate the incoming message this endpoint stands in for
    const incoming = makeMessage({ from: "lo_smistatore", to: "l_amministrativo", client: question.clientId, type: "answer_with_evidence", answer: finalAnswer, evidenceId: finalEvidenceId });
    publish("a2a", { message: incoming });
    resolveQuestionById(id, { answer: finalAnswer, evidenceId: finalEvidenceId });
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, id }));
    return;
  }

  // ---- proactive pack delivery (manual trigger, for testing independent of the full demo) ----
  const packMatch = url.pathname.match(/^\/api\/deliver-pack\/([^/]+)\/([^/]+)$/);
  if (packMatch && req.method === "POST") {
    const clientId = decodeURIComponent(packMatch[1]);
    const period = decodeURIComponent(packMatch[2]);
    const result = await deliverMonthlyPack(clientId, period);
    publish("evidence", { record: result.evidence });
    publish("a2a", { message: result.a2a });
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, pack: result.pack }));
    return;
  }

  // ---- live runtime status for one client: how many pending gates, document requests and open questions THIS client currently has ----
  const runtimeMatch = url.pathname.match(/^\/api\/runtime-status\/([^/]+)$/);
  if (runtimeMatch && req.method === "GET") {
    const clientId = decodeURIComponent(runtimeMatch[1]);
    const gates = [...pendingGates.values()].filter((g) => g.clientId === clientId).length;
    const docReqs = [...pendingDocumentRequests.values()].filter((r) => r.clientId === clientId).length;
    const questions = [...pendingQuestions.values()].filter((q) => q.clientId === clientId).length;
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ clientId, gates, docReqs, questions }));
    return;
  }

  // ---- skill sandbox: exercise one of L'Amministrativo's 7 skills directly,
  // with an explicit per-request `skills` list standing in for a client's
  // manifest override — makes "switched on per client" something you can
  // click through instead of only reading it in a job description. ----
  if (url.pathname === "/api/test-skill" && req.method === "POST") {
    const body = await readBody(req);
    const { skill, clientId, skills, args } = body ? JSON.parse(body) : {};
    const manifest = { seat: "l_amministrativo", skills: Array.isArray(skills) ? skills : [] };
    const a = args || {};
    try {
      let result;
      switch (skill) {
        case "raccolta_documenti":
          result = await collectDocument(manifest, clientId, { docType: a.docType || "invoice", supplier: a.supplier, period: a.period });
          break;
        case "fatturazione": {
          if (!manifest.skills.includes("fatturazione")) { result = { skipped: true, skill: "fatturazione" }; break; }
          let ticket = null;
          const pending = draftAndSendInvoice(manifest, clientId, { customer: a.customer, amount: Number(a.amount) || a.amount }, {
            onTicket: (t) => { ticket = { id: t.id, action: t.action, payload: t.payload }; },
          });
          pending.catch(() => {}); // a later deny() must not become an unhandled rejection in this now-detached promise
          await new Promise((r) => setTimeout(r, 30)); // give the microtask inside draftAndSendInvoice time to reach onTicket
          result = ticket ? { opened: true, ticket } : { skipped: true, skill: "fatturazione" };
          break;
        }
        case "incassi_e_solleciti":
          result = await sendReminder(manifest, clientId, { name: a.name, amount: Number(a.amount) || a.amount, due: a.due, contact: a.contact });
          break;
        case "presenze_note_spese":
          result = await logAttendanceOrExpense(manifest, clientId, { kind: a.kind || "expense", id: a.id, amount: Number(a.amount) || a.amount, note: a.note });
          break;
        case "sportello_dipendenti":
          result = await answerEmployeeQuestion(manifest, clientId, a.employee, a.question);
          break;
        case "scadenze_pagamenti":
          result = await trackDeadline(manifest, clientId, { what: a.what, due: a.due, reminderWindowDays: a.reminderWindowDays != null && a.reminderWindowDays !== "" ? Number(a.reminderWindowDays) : undefined });
          break;
        case "domande_allo_studio":
          result = await askStudio(manifest, clientId, a.topic, a.body);
          break;
        default:
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: `unknown skill "${skill}"` }));
          return;
      }
      // Anything this produced (evidence, an a2a message, a new gate) shows
      // up on the live bus too — not a side channel only this response sees.
      if (result && result.evidence) publish("evidence", { record: result.evidence });
      if (result && result.ack) publish("a2a", { message: result.ack });
      if (result && result.a2a) publish("a2a", { message: result.a2a });
      if (result && result.ticket) publish("gate", { id: result.ticket.id, clientId, action: result.ticket.action, payload: result.ticket.payload, status: "pending" });
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, result }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String((e && e.message) || e) }));
    }
    return;
  }

  // static
  let p = url.pathname === "/" ? "/index.html" : url.pathname;
  try {
    const body = await readFile(join(pub, p));
    res.writeHead(200, { "Content-Type": MIME[extname(p)] || "application/octet-stream", "Cache-Control": "no-store" }).end(body);
  } catch { res.writeHead(404).end("Not found"); }
});

server.listen(PORT, () => console.log(`Agent Desk starter on http://localhost:${PORT}`));
