// contracts/routingSchema.mjs
// -------------------------------------------------------------------
// THE ROUTING OUTPUT CONTRACT — matches lo_smistatore's manifest:
//   artifact: "routed_task{owner, deadline}"
//
// route() always returns one of these two shapes, never null/undefined
// and never a raw string. Callers branch on the discriminant `kind`.
// -------------------------------------------------------------------
import { z } from "zod";
import { A2A_TYPES } from "./a2aSchema.mjs";

export const RoutedTaskSchema = z.object({
  kind: z.literal("routed_task"),
  owner: z.string(),
  deadline: z.string(),                 // ISO date string
  sourceMessageType: z.enum(A2A_TYPES),
  client: z.string(),
  escalated: z.boolean().default(false),
  escalationTier: z.number().int().optional(),
});

export const EscalationEventSchema = z.object({
  kind: z.literal("escalation_event"),
  client: z.string(),
  sourceMessageType: z.enum(A2A_TYPES),
  reason: z.enum(["no_available_owner", "ladder_exhausted"]),
  triedTiers: z.array(z.number().int()),
});

export const RoutingResultSchema = z.discriminatedUnion("kind", [
  RoutedTaskSchema,
  EscalationEventSchema,
]);
