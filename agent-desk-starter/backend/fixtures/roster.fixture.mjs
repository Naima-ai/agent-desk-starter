// backend/fixtures/roster.fixture.mjs
// -------------------------------------------------------------------
// Placeholder roster until there's a real staff directory / config
// source. Swap this import out in smistatore.mjs when that lands —
// nothing else needs to change, route() just takes a roster array.
//
// Direction, confirmed against backend/lAmministrativo.mjs (toStudio()) AND
// by actually running the real demo scenario through this wiring:
//   l_amministrativo -> lo_smistatore : pack_delivered, document_delivered,
//     item_missing, question_for_studio, escalation_requested, acknowledgment,
//     AND answer_with_evidence (when it answers a studio question from its
//     own memory instead of escalating — see handleInstructionFromStudio's
//     `known` branch. Caught this the hard way: routing it back to
//     l_amministrativo sent the client's own answer back to itself.)
//   lo_smistatore -> l_amministrativo : instruction_from_studio,
//     answer_with_evidence (studio answering a client-raised question —
//     server.mjs's /api/questions/:id/resolve addresses this directly,
//     never through lo_smistatore, so this direction never actually hits
//     route() in the current codebase — kept in the fixture for when it does.)
// So l_amministrativo's competence below is what it RECEIVES, not what it
// sends — but answer_with_evidence needs a studio-side owner instead, since
// every occurrence actually observed going TO lo_smistatore is the client
// answering, not the studio.
//
// ASSUMPTION (not yet confirmed with the team — flag this in review):
// item_missing / document_delivered / pack_delivered coming FROM the client
// are routed to l_addetto_iva, since it's the seat that raised the original
// anomaly the client is responding to (contracts/seats/l_addetto_iva.json
// declares a2a.handoff:lo_smistatore). question_for_studio and
// escalation_requested go to a human/studio_lead queue — there's no seat
// yet whose job is "answer client questions", so this is a deliberate
// backstop, not a real owner.
// -------------------------------------------------------------------

export const rosterFixture = [
  {
    agent: "l_amministrativo",
    // instruction_from_studio kept here for completeness (see note above) —
    // never actually exercised today, since that direction is always
    // pre-addressed straight to l_amministrativo and skips lo_smistatore.
    competence: ["instruction_from_studio"],
    clients: ["rossi_srl", "bianchi_snc"],
    available: true,
    tier: 0,
  },
  {
    agent: "l_addetto_iva",
    competence: ["item_missing", "document_delivered", "pack_delivered"],
    clients: ["*"],
    available: true,
    tier: 0,
  },
  {
    agent: "studio_lead",
    competence: ["question_for_studio", "escalation_requested", "acknowledgment", "answer_with_evidence"],
    clients: ["*"],
    available: true,
    tier: 0,
  },
  {
    agent: "studio_lead",
    // Same human, one tier up: catch-all backstop for anything the tier-0
    // rows above didn't match (nobody available, or an unexpected type).
    competence: [
      "pack_delivered", "document_delivered", "item_missing",
      "question_for_studio", "instruction_from_studio",
      "answer_with_evidence", "escalation_requested", "acknowledgment",
    ],
    clients: ["*"],
    available: true,
    tier: 2,
  },
];
