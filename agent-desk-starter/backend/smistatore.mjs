// backend/smistatore.mjs — Lo Smistatore's brain.
//
// The receptionist. Given a typed A2A message, decides whose desk it goes
// on — competence + client ownership + availability, nothing else. Never
// answers a client itself, never ranks people, never routes on anything
// performance-shaped (see contracts/rosterSchema.mjs for why that's not
// just a policy, it's a schema constraint).
//
// STATUS: pure function today, not yet wired into bus.mjs/server.mjs.
// Call route() directly for now — see tests/smistatore.test.mjs.
// (Same "pure first, wire the bus later" order lAmministrativo.mjs's
// skills followed before server.mjs's /api/test-skill sandbox existed.)
//
// >>> TODO (real): once guardrails.mjs exists, delete assertAllowed()
//     below and let it wrap route() generically instead — don't let
//     both exist at once, that's how a refusal quietly stops being
//     enforced.
import { A2AMessageSchema } from "../contracts/a2aSchema.mjs";
import { validateRoster } from "../contracts/rosterSchema.mjs";
import { RoutedTaskSchema, EscalationEventSchema } from "../contracts/routingSchema.mjs";

const SEAT = "lo_smistatore";

// Mirrors contracts/seats/lo_smistatore.json's `refuses` — same pattern
// lAmministrativo.mjs uses for its own REFUSES constant.
const REFUSES = ["answer_client_directly", "rank_people", "route_by_measured_behaviour"];

// ---------------------------------------------------------------------------
// Hard blocks. Enforced at the call layer, in code, on every call — not a
// prompt hint the model could talk itself around.
// ---------------------------------------------------------------------------
function assertAllowed(action) {
  if (REFUSES.includes(action)) {
    throw new Error(`REFUSED: ${SEAT} will not perform "${action}" — hard block, not a suggestion.`);
  }
}

// These exist so the refusal is something you can call and watch fail, not
// just a comment. Nothing in route() ever calls them — that's the point.
export function answerClientDirectly() { assertAllowed("answer_client_directly"); }
export function rankPeople() { assertAllowed("rank_people"); }
export function routeByMeasuredBehaviour() { assertAllowed("route_by_measured_behaviour"); }

// Urgency -> deadline offset. Only item_missing carries urgency today;
// everything else gets a flat default.
const URGENCY_HOURS = { high: 4, normal: 24, low: 72 };
const DEFAULT_DEADLINE_HOURS = 24;

function computeDeadline(message) {
  const hours =
    message.type === "item_missing"
      ? URGENCY_HOURS[message.urgency] ?? DEFAULT_DEADLINE_HOURS
      : DEFAULT_DEADLINE_HOURS;
  return new Date(Date.now() + hours * 3600 * 1000).toISOString();
}

/**
 * Filters the roster down to agents who can legally take this message:
 * competence match, client ownership match ("*" = any client), and
 * currently available. No sorting by anything performance-shaped — only
 * `tier` (declared escalation order, a static config value) is ever used
 * to pick among survivors.
 */
function candidatesAtTier(message, roster, tier) {
  return roster.filter(
    (r) =>
      r.tier === tier &&
      r.available &&
      r.competence.includes(message.type) &&
      (r.clients.includes(message.client) || r.clients.includes("*"))
  );
}

/**
 * route(message, roster) -> RoutedTask | EscalationEvent
 *
 * message: a validated A2AMessageSchema object (already signed/parsed by
 *          makeMessage() upstream — re-validated here defensively).
 * roster:  array matching RosterEntrySchema (see backend/fixtures/roster.fixture.mjs
 *          for the placeholder used until there's a real staff directory).
 */
export function route(message, roster) {
  const msg = A2AMessageSchema.parse(message);
  const board = validateRoster(roster);

  const tiers = [...new Set(board.map((r) => r.tier))].sort((a, b) => a - b);
  const triedTiers = [];

  for (const tier of tiers) {
    triedTiers.push(tier);
    const candidates = candidatesAtTier(msg, board, tier);
    if (candidates.length > 0) {
      // Multiple survivors at the same tier: pick the first in declared
      // roster order. Deliberately NOT sorted by anything dynamic.
      const chosen = candidates[0];
      return RoutedTaskSchema.parse({
        kind: "routed_task",
        owner: chosen.agent,
        deadline: computeDeadline(msg),
        sourceMessageType: msg.type,
        client: msg.client,
        escalated: tier > 0,
        escalationTier: tier > 0 ? tier : undefined,
      });
    }
  }

  return EscalationEventSchema.parse({
    kind: "escalation_event",
    client: msg.client,
    sourceMessageType: msg.type,
    reason: "ladder_exhausted",
    triedTiers,
  });
}
