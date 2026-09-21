// contracts/a2aSchema.mjs
// -------------------------------------------------------------------
// THE CONTRACT (2 of 2): the typed A2A domain schema.
// A2A carries the task; THIS defines its meaning. Only these 9 message
// types may cross the agent-to-agent boundary. No free text.
// -------------------------------------------------------------------
import { z } from "zod";
import { createHash } from "node:crypto";

export const A2A_TYPES = [
  "pack_delivered", "document_delivered", "item_missing",
  "question_for_studio", "instruction_from_studio", "answer_with_evidence",
  "escalation_requested", "acknowledgment", "correction_request",
];

const Base = {
  from: z.string(), to: z.string(), client: z.string(),
  ts: z.string(), sig: z.string(),
};

export const A2AMessageSchema = z.discriminatedUnion("type", [
  z.object({ ...Base, type: z.literal("pack_delivered"), period: z.string(), items: z.number() }),
  z.object({ ...Base, type: z.literal("document_delivered"), doc: z.string(), sdiId: z.string().optional() }),
  z.object({ ...Base, type: z.literal("item_missing"), expected: z.string(), period: z.string(), urgency: z.enum(["low","normal","high"]) }),
  z.object({ ...Base, type: z.literal("question_for_studio"), topic: z.string(), body: z.string() }),
  z.object({ ...Base, type: z.literal("instruction_from_studio"), instruction: z.string(), due: z.string().optional() }),
  z.object({ ...Base, type: z.literal("answer_with_evidence"), answer: z.string(), evidenceId: z.string() }),
  z.object({ ...Base, type: z.literal("escalation_requested"), reason: z.string() }),
  z.object({ ...Base, type: z.literal("acknowledgment"), ref: z.string() }),
  // l_addetto_iva -> lo_smistatore: a VAT-rule anomaly (bad rate, bad P.IVA,
  // missing evidence, ...) that the client needs to fix, per L'Addetto
  // IVA's own job description ("route each anomaly through Lo Smistatore") —
  // added because this was previously just a narrated feed message, never
  // an actual routed A2A message.
  z.object({ ...Base, type: z.literal("correction_request"), ruleId: z.string(), message: z.string(), period: z.string() }),
]);

// Signing stub — REPLACE with real asymmetric signing in production.
export function signMessage(payload, key = "dev-key") {
  const { sig, ...rest } = payload;
  const h = createHash("sha256").update(JSON.stringify(rest) + key).digest("hex");
  return { ...rest, sig: h.slice(0, 16) };
}

/** Build + sign + validate a typed A2A message. Throws on schema violation. */
export function makeMessage(msg) {
  const signed = signMessage({ ts: new Date().toISOString(), sig: "", ...msg });
  return A2AMessageSchema.parse(signed);
}
