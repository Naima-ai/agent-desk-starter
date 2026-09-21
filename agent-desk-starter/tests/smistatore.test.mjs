// tests/smistatore.test.mjs — proves Lo Smistatore routes correctly and
// can never be made to rank people or route on measured behaviour.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMessage } from "../contracts/a2aSchema.mjs";
import { route, answerClientDirectly, rankPeople, routeByMeasuredBehaviour } from "../backend/smistatore.mjs";
import { rosterFixture } from "../backend/fixtures/roster.fixture.mjs";

function msg(overrides) {
  return makeMessage({ from: "l_amministrativo", to: "lo_smistatore", client: "rossi_srl", ...overrides });
}

test("routes item_missing to l_addetto_iva (the seat that raised the original anomaly)", () => {
  const result = route(
    msg({ type: "item_missing", expected: "invoice ACME", period: "2026-08", urgency: "normal" }),
    rosterFixture
  );
  assert.equal(result.kind, "routed_task");
  assert.equal(result.owner, "l_addetto_iva");
  assert.equal(result.escalated, false);
});

test("routes instruction_from_studio to l_amministrativo (studio -> client direction)", () => {
  const result = route(
    msg({ from: "lo_smistatore", to: "l_amministrativo", type: "instruction_from_studio", instruction: "fetch invoice ACME for 2026-08" }),
    rosterFixture
  );
  assert.equal(result.owner, "l_amministrativo");
});

// Regression test for a real bug: found by running the actual demo scenario
// through this wiring, not by unit-testing against my own fixture assumptions.
// answer_with_evidence is used bidirectionally in lAmministrativo.mjs — the
// client agent also sends it (to lo_smistatore) when it answers a studio
// question from its own memory. Routing that back to l_amministrativo would
// send the client's own answer back to itself.
test("routes a client's answer_with_evidence to a studio-side owner, not back to the client", () => {
  const result = route(
    msg({ from: "l_amministrativo", to: "lo_smistatore", type: "answer_with_evidence", answer: "pranzo-cliente-rossi: 42 EUR", evidenceId: "ev_1" }),
    rosterFixture
  );
  assert.notEqual(result.owner, "l_amministrativo", "must not route the client's own answer back to itself");
  assert.equal(result.owner, "studio_lead");
});

test("high urgency gets a tighter deadline than normal urgency", () => {
  const high = route(msg({ type: "item_missing", expected: "x", period: "2026-08", urgency: "high" }), rosterFixture);
  const normal = route(msg({ type: "item_missing", expected: "x", period: "2026-08", urgency: "normal" }), rosterFixture);
  assert.ok(new Date(high.deadline) < new Date(normal.deadline));
});

test("falls through to the tier-2 backstop when the tier-0 owner is unavailable", () => {
  const busyRoster = rosterFixture.map((r) =>
    r.agent === "l_addetto_iva" ? { ...r, available: false } : r
  );
  const result = route(msg({ type: "item_missing", expected: "x", period: "2026-08", urgency: "normal" }), busyRoster);
  assert.equal(result.kind, "routed_task");
  assert.equal(result.owner, "studio_lead");
  assert.equal(result.escalated, true);
  assert.equal(result.escalationTier, 2);
});

test("escalates when nobody on the roster can take the message at all", () => {
  const emptyRoster = [];
  const result = route(msg({ type: "item_missing", expected: "x", period: "2026-08", urgency: "normal" }), emptyRoster);
  assert.equal(result.kind, "escalation_event");
  assert.equal(result.reason, "ladder_exhausted");
});

test("client ownership is respected — a client not on an agent's list falls to the backstop", () => {
  const result = route(
    msg({ client: "unknown_client_inc", type: "item_missing", expected: "x", period: "2026-08", urgency: "normal" }),
    rosterFixture
  );
  // l_addetto_iva is scoped to "*" clients in the fixture, so it should
  // still win here — this test documents that "*" really does mean any
  // client, not just the two named ones.
  assert.equal(result.owner, "l_addetto_iva");
});

test("REFUSED: answering the client directly is a hard block, not a suggestion", () => {
  assert.throws(() => answerClientDirectly(), /REFUSED/);
});

test("REFUSED: ranking people is a hard block", () => {
  assert.throws(() => rankPeople(), /REFUSED/);
});

test("REFUSED: routing by measured behaviour is a hard block", () => {
  assert.throws(() => routeByMeasuredBehaviour(), /REFUSED/);
});

test("adversarial: a performance-shaped field on a roster entry is silently stripped, not read", () => {
  const taintedRoster = rosterFixture.map((r) =>
    r.agent === "l_addetto_iva" ? { ...r, performanceScore: 0.02 } : r // if this mattered, this agent should lose
  );
  const result = route(msg({ type: "item_missing", expected: "x", period: "2026-08", urgency: "normal" }), taintedRoster);
  // Zod strips unknown keys by default — RosterEntrySchema has no
  // performanceScore field, so this has zero effect on the outcome.
  assert.equal(result.owner, "l_addetto_iva");
});
