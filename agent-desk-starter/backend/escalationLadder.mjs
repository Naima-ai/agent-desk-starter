// backend/escalationLadder.mjs
// A small, generic reminder/escalation scheduler

// This module only schedules. It has no opinion about WHAT a reminder or an
// escalation does — callers supply onRemind(n)/onEscalate() callbacks, so the
// same scheduler works for "ping the owner again on WhatsApp" and "escalate
// an unapproved invoice gate to the studio" without duplicating timer logic.
export function startLadder({ reminderDelaysMs = [], escalateAfterMs = null, onRemind, onEscalate }) {
    const timers = [];
    reminderDelaysMs.forEach((delay, i) => {
      timers.push(setTimeout(() => onRemind?.(i + 1), delay));
    });
    if (escalateAfterMs != null) {
      timers.push(setTimeout(() => onEscalate?.(), escalateAfterMs));
    }
    return {
      /** Stop every scheduled reminder/escalation — call this the moment the
        underlying request resolves (approved, denied, document delivered). */
      cancel() { timers.forEach(clearTimeout); },
    };
  }
  