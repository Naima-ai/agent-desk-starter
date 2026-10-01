const PERMANENT_CODES = new Set([
  "INVALID_A2A_MESSAGE", "INVALID_A2A_SIGNATURE", "PUBLISHER_MISMATCH",
  "RECIPIENT_NOT_ALLOWED", "MESSAGE_ID_CONFLICT",
]);

export function createRetryPolicy({ maxAttempts = 5, baseDelayMs = 250, maxDelayMs = 30_000, jitter = 0.2, random = Math.random } = {}) {
  return Object.freeze({
    maxAttempts,
    classify(error, attempt) {
      const code = error?.code || "CONSUMER_FAILED";
      const permanent = error?.retryable === false || PERMANENT_CODES.has(code);
      if (permanent || attempt >= maxAttempts) {
        return { retry: false, code, reason: permanent ? "permanent_failure" : "attempts_exhausted", delayMs: 0 };
      }
      const base = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, attempt - 1)));
      const spread = base * jitter;
      return { retry: true, code, reason: "transient_failure", delayMs: Math.max(0, Math.round(base - spread + random() * spread * 2)) };
    },
  });
}

