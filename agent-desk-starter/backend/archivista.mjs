// backend/archivista.mjs — L'Archivista's brain.
// Turns a confirmed correction into durable, typed knowledge (Loop Cortex
// Memory). A new rule runs in SHADOW mode — proposed but not yet trusted —
// until a human confirms it at the gate; confidence decays if a confirmed rule
// is never re-verified, so a stale mapping doesn't stay authoritative forever.
// (Previously this lived as one function inside classifier.mjs — pulled out
// here so the Archivist is its own seat, per ARCHITECTURE.md.)
// >>> TODO (real): trigger proposeRule() from every seat's correction event,
//     not just the classifier's; run decayConfidence() as a periodic job.
import * as knowledge from "./memory/knowledgeStore.mjs";

const SHADOW_CONFIDENCE = 0.6;
const CONFIRMED_CONFIDENCE = 0.98;
const DECAY_AFTER_DAYS = 90;
const DECAY_STEP = 0.1;

// "Never store without evidence" (l_archivista.job.txt) is a hard
// constraint, not a suggestion — found unenforced: proposeRule() and
// confirmRule() both happily stored a rule with evidenceId left undefined.
function assertHasEvidence(evidenceId, action) {
  if (!evidenceId) {
    throw new Error(`REFUSED: l_archivista will not ${action} without evidence — hard block, not a suggestion.`);
  }
}

/** Propose a rule from a single observation. Recorded immediately, but marked
 *  "shadow" — not confident enough to auto-apply until a human confirms it. */
export function proposeRule({ key, kind, scope, value, source, evidenceId }) {
  assertHasEvidence(evidenceId, "propose a rule");
  return knowledge.upsert({ key, kind, scope, value, source, evidenceId, status: "shadow", confidence: SHADOW_CONFIDENCE });
}

/** A human confirms the fix at the gate: promote the rule to confirmed and trusted. */
export function confirmRule(key, confirmedBy, evidenceId) {
  const existing = knowledge.get(key);
  const resolvedEvidenceId = evidenceId ?? existing?.evidenceId;
  assertHasEvidence(resolvedEvidenceId, "confirm a rule");
  return knowledge.upsert({
    ...(existing || {}),
    key,
    status: "confirmed",
    confidence: CONFIRMED_CONFIDENCE,
    confirmedBy,
    evidenceId: resolvedEvidenceId,
  });
}

/** Convenience for the common case: the human corrects it once, at the gate,
 *  and that single act is both the proposal and the confirmation. */
export function learnConfirmed({ key, kind, scope, value, confirmedBy, evidenceId }) {
  proposeRule({ key, kind, scope, value, source: "correction", evidenceId });
  return confirmRule(key, confirmedBy, evidenceId);
}

/** Confidence decay: a confirmed rule not re-verified in a while loses trust a
 *  step at a time, rather than staying authoritative forever unchecked. */
export function decayConfidence(now = new Date()) {
  const decayed = [];
  for (const rec of knowledge.all()) {
    if (rec.status !== "confirmed") continue;
    const ageDays = (now - new Date(rec.lastVerified)) / (1000 * 60 * 60 * 24);
    if (ageDays > DECAY_AFTER_DAYS) {
      decayed.push(knowledge.upsert({ ...rec, confidence: Math.max(0, rec.confidence - DECAY_STEP) }));
    }
  }
  return decayed;
}
