// contracts/manifestSchema.mjs
// -------------------------------------------------------------------
// THE CONTRACT (1 of 2): the Agent Manifest schema.
// Single source of truth the Job Card Compiler emits to and the runtime
// validates against. Hand THIS FILE to your coding tool when generating
// anything that reads or writes a manifest.
// -------------------------------------------------------------------
import { z } from "zod";

export const Layer = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);

export const MemoryScope = z.object({
  read: z.array(Layer).default([]),
  write: z.array(Layer).default([]),
  partition: z.string().optional(), // L'Amministrativo: scoped mirror of client L3
});

export const ManifestSchema = z.object({
  seat: z.string().regex(/^[a-z0-9_]+$/),
  desk: z.string().optional(),
  location: z.enum(["studio_edge", "client_side"]).default("studio_edge"),
  model: z.object({ edge: z.string(), fallback: z.string().default("llm") }),
  skills: z.array(z.string()).default([]),
  tools: z.array(z.string()).default([]),
  memory: MemoryScope,
  refuses: z.array(z.string()).default([]), // -> HARD runtime blocks
  gate: z.string().optional(),
  schedule: z.string().optional(),
  artifact: z.string().optional(),
  unit: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
});

/** Throws a ZodError listing every problem; returns the typed manifest. */
export function validateManifest(obj) {
  return ManifestSchema.parse(obj);
}
