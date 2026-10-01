// contracts/a2aSchema.mjs
// -------------------------------------------------------------------
// THE CONTRACT (2 of 2): the typed A2A domain schema.
// A2A carries the task; THIS defines its meaning. Only these 9 message
// types may cross the agent-to-agent boundary. No free text.
// -------------------------------------------------------------------
import { z } from "zod";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

export const A2A_TYPES = [
  "pack_delivered", "document_delivered", "item_missing",
  "question_for_studio", "instruction_from_studio", "answer_with_evidence",
  "escalation_requested", "acknowledgment", "correction_request",
];

const Base = {
  id: z.string().min(1).max(160),
  from: z.string(), to: z.string(), client: z.string(),
  ts: z.string(), sig: z.string(),
  // Added by the runtime so every handoff can be tied back to one run/workflow.
  // These remain optional until the full versioned A2A v2 migration lands.
  correlationId: z.string().optional(),
  causationId: z.string().optional(),
};

export const A2AMessageSchema = z.discriminatedUnion("type", [
  z.object({ ...Base, type: z.literal("pack_delivered"), period: z.string(), items: z.number() }).strict(),
  z.object({ ...Base, type: z.literal("document_delivered"), doc: z.string(), sdiId: z.string().optional() }).strict(),
  z.object({ ...Base, type: z.literal("item_missing"), expected: z.string(), period: z.string(), urgency: z.enum(["low","normal","high"]) }).strict(),
  z.object({ ...Base, type: z.literal("question_for_studio"), topic: z.string(), body: z.string() }).strict(),
  z.object({ ...Base, type: z.literal("instruction_from_studio"), instruction: z.string(), due: z.string().optional() }).strict(),
  z.object({ ...Base, type: z.literal("answer_with_evidence"), answer: z.string(), evidenceId: z.string() }).strict(),
  z.object({ ...Base, type: z.literal("escalation_requested"), reason: z.string() }).strict(),
  z.object({ ...Base, type: z.literal("acknowledgment"), ref: z.string() }).strict(),
  // l_addetto_iva -> lo_smistatore: a VAT-rule anomaly (bad rate, bad P.IVA,
  // missing evidence, ...) that the client needs to fix, per L'Addetto
  // IVA's own job description ("route each anomaly through Lo Smistatore") —
  // added because this was previously just a narrated feed message, never
  // an actual routed A2A message.
  z.object({ ...Base, type: z.literal("correction_request"), ruleId: z.string(), message: z.string(), period: z.string() }).strict(),
]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalMessageBytes(payload) {
  const { sig, ...unsigned } = payload;
  return Buffer.from(JSON.stringify(canonicalize(unsigned)), "utf8");
}

// Signing stub — REPLACE with real asymmetric signing in production.
export function signMessage(payload, key = "dev-key") {
  const { sig, ...rest } = payload;
  const h = createHash("sha256").update(canonicalMessageBytes(rest)).update(String(key)).digest("hex");
  return { ...rest, sig: h.slice(0, 16) };
}

/** Development-v1 verification. Phase 1 replaces this shared key with Ed25519. */
export function verifyMessage(payload, key = "dev-key") {
  const parsed = A2AMessageSchema.safeParse(payload);
  if (!parsed.success) return false;
  const expected = signMessage(parsed.data, key).sig;
  const actualBytes = Buffer.from(parsed.data.sig, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function messageDigest(payload) {
  return createHash("sha256").update(canonicalMessageBytes(payload)).update(payload.sig || "").digest("hex");
}

/** Build + sign + validate a typed A2A message. Throws on schema violation. */
export function makeMessage(msg) {
  const signed = signMessage({ id: randomUUID(), ts: new Date().toISOString(), sig: "", ...msg });
  return A2AMessageSchema.parse(signed);
}
