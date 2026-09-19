// backend/vatRules.mjs — VAT checker rules.
// Concrete Italian VAT business rules, straight from the Rulebook (Section 6 —
// Applicable business rules, and Appendix A — Consolidated rule catalogue).
// Each result carries the SAME rule ID used in the rulebook (CST-03, CST-04,
// SEM-02, ...) so engineering and compliance are reading the same language.
//
// This engine only checks what the line data itself proves (rate math, Natura
// shape, and the category-vs-rate mapping the client's own chart of accounts
// declares). It never decides a rate is "right" by looking at the description —
// that judgement call belongs to a real tax professional and the client's
// signed-off configuration profile, not this file.
// >>> TODO (real): load VALID_NATURA / VALID_RATES and the arithmetic tolerance
//     from the client's signed-off configuration profile, not these defaults.

const VALID_RATES = [0, 4, 5, 10, 22]; // Rule 6.1-a — Table A, DPR 633/1972
const NATURA_CODES_REQUIRING_SUBCODE = ["N2", "N3", "N6"]; // bare codes are rejected
const VALID_NATURA = [
  "N1",
  "N2.1", "N2.2",
  "N3.1", "N3.2", "N3.3", "N3.4", "N3.5", "N3.6",
  "N4", "N5",
  "N6.1", "N6.2", "N6.3", "N6.4", "N6.5", "N6.6", "N6.7", "N6.8", "N6.9",
  "N7",
];
const LINE_TOLERANCE = 0.01; // CST-01 — €0.01 per line

/** The rate implied by a line's own net/vat amounts, as a percentage. */
function impliedRate(line) {
  if (!line.net) return null;
  return Math.round((line.vat / line.net) * 100 * 100) / 100; // 2dp %
}

/** SEM-01 — a generic N2/N3/N6 code without its mandatory sub-code is rejected;
 *  an unrecognised Natura code is rejected outright. */
export function checkNaturaSubcode(line) {
  if (!line.natura) return null;
  if (NATURA_CODES_REQUIRING_SUBCODE.includes(line.natura)) {
    return {
      ruleId: "SEM-01", severity: "Blocking", kind: "natura_missing_subcode", line: line.id,
      message: `Natura ${line.natura} needs a mandatory sub-code (e.g. ${line.natura}.1) — the bare code is not admissible.`,
    };
  }
  if (!VALID_NATURA.includes(line.natura)) {
    return {
      ruleId: "SEM-01", severity: "Blocking", kind: "natura_invalid", line: line.id,
      message: `Natura code "${line.natura}" is not a recognised code.`,
    };
  }
  return null;
}

/** CST-03 — rate/Natura mutual exclusivity: a 0% line must carry a Natura code;
 *  a taxed line (rate > 0) must not carry one. The two are mutually exclusive. */
export function checkRateNaturaExclusivity(line) {
  const rate = impliedRate(line);
  if (rate === null) return null;
  if (rate === 0 && !line.natura) {
    return { ruleId: "CST-03", severity: "Blocking", kind: "natura_missing", line: line.id, message: "0% VAT with no Natura code." };
  }
  if (rate > 0 && line.natura) {
    return {
      ruleId: "CST-03", severity: "Blocking", kind: "natura_with_rate", line: line.id,
      message: `Rate ${rate}% carries a Natura code (${line.natura}) — the two are mutually exclusive.`,
    };
  }
  return null;
}

/** Rule 6.1-a — the applied rate must be one of the legally admissible rates.
 *  Reduced rates are mandatory exceptions; anything not listed is 22%. */
export function checkRateValidity(line) {
  const rate = impliedRate(line);
  if (rate === null) return null;
  const nearest = VALID_RATES.reduce((a, b) => (Math.abs(b - rate) < Math.abs(a - rate) ? b : a));
  if (Math.abs(rate - nearest) > 0.5) {
    return {
      ruleId: "SEM-02", severity: "Major", kind: "rate_invalid", line: line.id,
      message: `Rate ${rate}% is not one of the admissible VAT rates (${VALID_RATES.join(", ")}%).`,
    };
  }
  return null;
}

/** CST-04 — the primary "wrong VAT % on a cost line" control. The applied rate
 *  must match the rate the client's own taxonomy maps to this line's category —
 *  not the studio's preference, and not a guess by this engine. */
export function checkRateCategoryMatch(line, taxonomy = []) {
  if (!line.account) return null; // still in the tail — nothing to check against yet
  const category = taxonomy.find((c) => c.code === line.account);
  if (!category || category.rate == null) return null; // category has no registered rate — not this rule's job
  const rate = impliedRate(line);
  if (rate === null) return null;
  if (Math.round(rate) !== Math.round(category.rate)) {
    return {
      ruleId: "CST-04", severity: "Major", kind: "rate_mismatch", line: line.id,
      category: category.code, observed: rate, expected: category.rate,
      message: `Line ${line.id} (${category.name}): applied ${rate}% but ${category.rate}% is expected for this category.`,
    };
  }
  return null;
}

/** CST-01/CST-02 arithmetic coherence, adapted to the net/vat fields this
 *  starter kit carries: vat should equal net x rate, within tolerance. */
export function checkArithmetic(line) {
  const rate = impliedRate(line);
  if (rate === null) return null;
  const nearestValidRate = VALID_RATES.reduce((a, b) => (Math.abs(b - rate) < Math.abs(a - rate) ? b : a));
  const expectedVat = Math.round(line.net * (nearestValidRate / 100) * 100) / 100;
  if (Math.abs(expectedVat - line.vat) > LINE_TOLERANCE) {
    return {
      ruleId: "CST-01", severity: "Major", kind: "arithmetic_mismatch", line: line.id,
      message: `VAT ${line.vat} does not reconcile with net ${line.net} x ${nearestValidRate}% (expected ~${expectedVat}).`,
    };
  }
  return null;
}

const LINE_ONLY_CHECKS = [checkNaturaSubcode, checkRateNaturaExclusivity, checkRateValidity, checkArithmetic];

/** Run every VAT rule against every line in the batch. checkRateCategoryMatch
 *  needs the client's taxonomy (chart of accounts with an expected rate per
 *  category) — pass it in, don't hardcode it here. */
export function runVatRules(lines, taxonomy = []) {
  const anomalies = [];
  for (const line of lines) {
    for (const check of LINE_ONLY_CHECKS) {
      const hit = check(line);
      if (hit) anomalies.push(hit);
    }
    const categoryHit = checkRateCategoryMatch(line, taxonomy);
    if (categoryHit) anomalies.push(categoryHit);
  }
  return anomalies;
}
