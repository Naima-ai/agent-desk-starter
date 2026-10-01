import { z } from "zod";
import { A2AMessageSchema } from "./a2aSchema.mjs";

const Id = z.string().min(1).max(160);
const IsoDateTime = z.string().datetime({ offset: true });

export const RuntimeActorSchema = z.string().refine(
  (value) => value === "system" || /^(agent|human):[a-zA-Z0-9_.-]+$/.test(value),
  { message: "actor must be system, agent:<id>, or human:<id>" },
);

export const RuntimeContextSchema = z.object({
  clientId: Id,
  correlationId: Id.optional(),
  causationId: Id.optional(),
  actor: RuntimeActorSchema.default("system"),
  deadline: IsoDateTime.optional(),
}).strict();

export const RuntimeRequestInputSchema = z.object({
  runId: Id.optional(),
  seat: z.string().regex(/^[a-z0-9_]+$/),
  operation: z.string().regex(/^[a-z0-9_]+$/),
  input: z.unknown().default({}),
  context: RuntimeContextSchema,
}).strict();

export const RuntimeRequestSchema = RuntimeRequestInputSchema.extend({
  runId: Id,
  context: RuntimeContextSchema.extend({ correlationId: Id }),
});

export const RuntimeErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean().default(false),
}).strict();

export const RuntimeResultSchema = z.object({
  runId: Id,
  seat: z.string().regex(/^[a-z0-9_]+$/),
  status: z.enum(["completed", "awaiting_approval", "refused", "failed"]),
  artifacts: z.array(z.unknown()),
  messages: z.array(A2AMessageSchema),
  approval: z.unknown().nullable(),
  error: RuntimeErrorSchema.nullable(),
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime,
}).strict();

