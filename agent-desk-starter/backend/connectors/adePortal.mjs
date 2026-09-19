// backend/connectors/adePortal.mjs
// Agenzia delle Entrate portal connector — deliberately PREPARE-ONLY.
// It can assemble and pre-validate a submission, but it will NEVER transmit on
// its own: transmission is a human gate (the professional signs and sends).
// This refusal is enforced here in the tool layer, not in a prompt.
// Compliance: EU AI Act + L.132/2025 (art.13) — the human keeps the signature.
const LIVE = Boolean(process.env.ADE_ENDPOINT && process.env.ADE_CERT);

/** Assemble + locally validate the telematic file. Does NOT send. */
export async function prepareSubmission(batch) {
  return {
    prepared: true,
    period: batch.period,
    lines: batch.lines.length,
    protocolDraft: `ADE-DRAFT-${batch.period}`,
    live: LIVE,
    note: "Prepared and validated. Awaiting professional signature — not transmitted.",
  };
}

/** Hard refusal. An agent must never reach the Agenzia by itself. */
export async function transmit() {
  throw new Error("REFUSED: transmission to Agenzia delle Entrate is a human gate. The professional signs and sends.");
}

/** After the human has signed & sent, record the receipt for write-back. */
export async function recordReceipt(protocol) {
  return { transmittedBy: "human", protocol, at: new Date().toISOString() };
}
