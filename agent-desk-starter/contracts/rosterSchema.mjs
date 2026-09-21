// contracts/rosterSchema.mjs
// -------------------------------------------------------------------
// THE ROSTER CONTRACT — what lo_smistatore is allowed to look at when
// deciding who gets a message.
//
// IMPORTANT: this shape is deliberately minimal. There is no field for
// response time, success rate, quality score, or anything else derived
// from how someone has performed. That's not an oversight — it's the
// enforcement mechanism for the manifest's
//   refuses: ["rank_people", "route_by_measured_behaviour"]
// If a field isn't in this schema, route() can't read it, full stop.
// Do not add performance-shaped fields here without a real policy
// conversation first.
// -------------------------------------------------------------------
import { z } from "zod";
import { A2A_TYPES } from "./a2aSchema.mjs";

export const RosterEntrySchema = z.object({
  agent: z.string(),                       // seat id, e.g. "l_amministrativo"
  competence: z.array(z.enum(A2A_TYPES)),  // message types this agent can handle
  clients: z.array(z.string()),            // client ids this agent owns ("*" = all)
  available: z.boolean(),                  // presence/capacity signal only
  tier: z.number().int().min(0),           // escalation order: 0 = primary, 1 = backup, ...
});

export const RosterSchema = z.array(RosterEntrySchema);

/** Throws a ZodError listing every problem; returns the typed roster. */
export function validateRoster(obj) {
  return RosterSchema.parse(obj);
}
