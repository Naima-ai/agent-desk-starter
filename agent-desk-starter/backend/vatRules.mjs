// backend/vatRules.mjs — VAT checker rules.
// Concrete Italian VAT business rules, straight from the Rulebook (Section 6 —
// Applicable business rules, and Appendix A — Consolidated rule catalogue).
// Each result carries the SAME rule ID used in the rulebook (FMT-03, CST-03,
// CST-04, SEM-02, ...) so engineering and compliance are reading the same
// language. (A couple of extra controls that AREN'T in the rulebook's 21-rule
// catalogue get their own honest tag instead of borrowing one — see
// validator.mjs's PRIOR-PERIOD and DOC-MISSING checks.)
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
const LINE_TOLERANCE = 0.01; // CST-02 — €0.01 per line
// NOTE: CST-01 ("line total = qty x unit price - discounts") is NOT checked here —
// this starter kit's line shape only carries { net, vat }, not { qty, unitPrice,
// discount }. Implementing CST-01 for real needs those fields added to the batch
// model first; don't claim CST-01 coverage until that's true.

/** The rate implied by a line's own net/vat amounts, as a percentage. */
function impliedRate(line) {
  if (!line.net) return null;
  return Math.round((line.vat / line.net) * 100 * 100) / 100; // 2dp %
}

// A real Partita IVA is 11 bare digits, but it's routinely written with the
// "IT" country prefix (EU VAT-number format, e.g. "IT11234560123", as real
// invoice feeds do) — strip that before validating, or a genuinely valid
// number gets rejected before the check-digit math ever runs.
function normalisePiva(piva) {
  return (piva || "").trim().toUpperCase().replace(/^IT/, "");
}

/** Validates an Italian Partita IVA's check digit (mod-10, alternating-double
 *  algorithm) — the same rule the Agenzia delle Entrate's own systems use. */
function isValidPiva(piva) {
  const digits = normalisePiva(piva);
  if (!/^\d{11}$/.test(digits)) return false;
  let total = 0;
  for (let i = 0; i < 10; i++) {
    const d = Number(digits[i]);
    if (i % 2 === 0) {
      total += d; // 1st, 3rd, 5th... (0-indexed even) — as-is
    } else {
      let doubled = d * 2;
      if (doubled > 9) doubled -= 9;
      total += doubled;
    }
  }
  const checkDigit = (10 - (total % 10)) % 10;
  return checkDigit === Number(digits[10]);
}

/** FMT-03 — identifiers well-formed: Partita IVA present, 11 digits, and a
 *  valid check digit. Only evaluated on lines that carry a `piva` field —
 *  see the NOTE below runVatRules for what that means for coverage. */
export function checkSupplierIdentifier(line) {
  if (line.piva === undefined) return null; // this line doesn't track an identifier yet
  if (!line.piva) {
    return { ruleId: "FMT-03", severity: "Blocking", kind: "identifier_missing", line: line.id, message: `${line.supplier}: no Partita IVA on file.` };
  }
  if (!isValidPiva(line.piva)) {
    const reason = /^\d{11}$/.test(normalisePiva(line.piva))
      ? "fails the check-digit validation (SdI error 00417 territory)"
      : "is not 11 digits (optionally prefixed \"IT\")";
    return {
      ruleId: "FMT-03", severity: "Blocking", kind: "identifier_invalid", line: line.id, piva: line.piva,
      message: `${line.supplier}: Partita IVA "${line.piva}" ${reason}.`,
    };
  }
  return null;
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

/** CST-02 — "tax = base x rate; totals reconcile", within tolerance. */
export function checkArithmetic(line) {
  const rate = impliedRate(line);
  if (rate === null) return null;
  const nearestValidRate = VALID_RATES.reduce((a, b) => (Math.abs(b - rate) < Math.abs(a - rate) ? b : a));
  const expectedVat = Math.round(line.net * (nearestValidRate / 100) * 100) / 100;
  if (Math.abs(expectedVat - line.vat) > LINE_TOLERANCE) {
    return {
      ruleId: "CST-02", severity: "Major", kind: "arithmetic_mismatch", line: line.id,
      message: `VAT ${line.vat} does not reconcile with net ${line.net} x ${nearestValidRate}% (expected ~${expectedVat}).`,
    };
  }
  return null;
}

/** CON-01 — a mandatory field is required but explicitly absent. Checked as
 *  `=== null` (someone tried to populate it and it's genuinely empty), not
 *  `undefined` (this batch model just doesn't track that field on this line
 *  at all, which is a modelling gap, not a content defect — same convention
 *  as FMT-03's `piva === undefined` check above). */
export function checkMandatoryFields(line) {
  if (line.date === null) {
    return { ruleId: "CON-01", severity: "Major", kind: "field_missing", line: line.id, message: `${line.supplier}: the invoice/supply date is missing.` };
  }
  return null;
}

/** CON-02 — required supporting documentation (customs/transport proof for
 *  an export, a declaration of intent for a habitual-exporter supply, ...)
 *  must actually be attached, not just claimed. Only evaluated on lines that
 *  declare `requiresEvidence` — most lines don't need any. */
export function checkRequiredEvidence(line) {
  if (!line.requiresEvidence) return null;
  if (!line.evidenceAttached) {
    return { ruleId: "CON-02", severity: "Major", kind: "evidence_missing", line: line.id, message: `${line.supplier}: required supporting evidence is not attached.` };
  }
  return null;
}

/** CON-03 — mandatory legal wording: "Scissione dei pagamenti" for split
 *  payment (art. 17-ter), "Inversione contabile" for reverse charge (any
 *  N6.x line). Both are things a document must literally say, not just
 *  imply through its rate/Natura. */
export function checkLegalWording(line) {
  if (line.splitPayment && !line.legalWording) {
    return { ruleId: "CON-03", severity: "Major", kind: "wording_missing", line: line.id, message: `${line.supplier}: split-payment invoice is missing the mandatory "Scissione dei pagamenti" wording.` };
  }
  if (line.natura?.startsWith("N6") && !line.legalWording) {
    return { ruleId: "CON-03", severity: "Major", kind: "wording_missing", line: line.id, message: `${line.supplier}: reverse-charge invoice is missing the mandatory "Inversione contabile" wording.` };
  }
  return null;
}

/** CST-07 — temporal coherence: supply date should be on or before the
 *  invoice date. Only evaluated on lines that track both dates separately
 *  (most lines here only have one `date` field, which is fine — this rule
 *  just isn't applicable to those). */
export function checkTemporalCoherence(line) {
  if (!line.invoiceDate || !line.supplyDate) return null;
  if (new Date(line.supplyDate) > new Date(line.invoiceDate)) {
    return {
      ruleId: "CST-07", severity: "Minor", kind: "temporal_incoherence", line: line.id,
      message: `${line.supplier}: supply date (${line.supplyDate}) is after the invoice date (${line.invoiceDate}) — should be supply ≤ invoice ≤ registration.`,
    };
  }
  return null;
}

/** STR-02's cardinality clause, specifically: "each line has a unique line
 *  number" within one document (Rulebook Section 5.2). A batch-level check —
 *  it has to see every line in a document together to catch a collision,
 *  not one line at a time like the checks above. */
export function checkUniqueLineNumbers(lines) {
  const anomalies = [];
  const byDoc = new Map();
  for (const line of lines) {
    if (!line.docNumber || line.lineNumber == null) continue;
    if (!byDoc.has(line.docNumber)) byDoc.set(line.docNumber, new Map());
    const seen = byDoc.get(line.docNumber);
    if (seen.has(line.lineNumber)) {
      anomalies.push({
        ruleId: "STR-02", severity: "Major", kind: "duplicate_line_number", line: line.id,
        message: `Document ${line.docNumber}: line number ${line.lineNumber} is used by both ${seen.get(line.lineNumber)} and ${line.id} — each line must be uniquely numbered.`,
      });
    } else {
      seen.set(line.lineNumber, line.id);
    }
  }
  return anomalies;
}

/** SdI error 00327 (Rulebook Table 7): a VAT Group member's invoice must
 *  carry THAT MEMBER's own Codice Fiscale — using the Group's own CF instead
 *  is a real, named rejection code, not a generic identifier problem, so it
 *  gets its own tag rather than being folded into FMT-03. `vatGroup` comes
 *  from the client's own master data, not the line — pass it in. */
export function checkVatGroupIdentity(line, vatGroup) {
  if (!vatGroup?.isMember || !line.counterpartyCfUsed) return null;
  if (line.counterpartyCfUsed === vatGroup.groupCf) {
    return {
      ruleId: "SDI-00327", severity: "Blocking", kind: "vat_group_cf_misuse", line: line.id,
      message: `Invoice uses the VAT Group's CF (${vatGroup.groupCf}) instead of this member's own CF (${vatGroup.memberCf}).`,
    };
  }
  return null;
}

const KNOWN_DOC_TYPES = new Set(Array.from({ length: 29 }, (_, i) => `TD${String(i + 1).padStart(2, "0")}`));

/** STR-01 — the document type is recognised and mapped to a known template
 *  (FatturaPA TD01-TD29). Only evaluated on lines whose `docType` was
 *  actually extracted during ingestion (real XML-sourced lines) — most
 *  lines here don't carry this field at all, which is fine, not a defect. */
export function checkDocumentType(line) {
  if (line.docType === undefined) return null;
  if (!KNOWN_DOC_TYPES.has(line.docType)) {
    return { ruleId: "STR-01", severity: "Blocking", kind: "doc_type_unrecognised", line: line.id, message: `${line.supplier}: document type "${line.docType}" is not a recognised FatturaPA type (TD01-TD29).` };
  }
  return null;
}

const LINE_ONLY_CHECKS = [
  checkSupplierIdentifier, checkNaturaSubcode, checkRateNaturaExclusivity, checkRateValidity, checkArithmetic,
  checkMandatoryFields, checkRequiredEvidence, checkLegalWording, checkTemporalCoherence, checkDocumentType,
];

/** Run every VAT rule against every line in the batch, plus the batch-level
 *  ones. checkRateCategoryMatch needs the client's taxonomy (chart of
 *  accounts with an expected rate per category); checkVatGroupIdentity needs
 *  the client's VAT-Group membership info — pass both in via `context`,
 *  don't hardcode either here.
 *  NOTE on FMT-03 coverage: only lines that carry a `piva` field are checked.
 *  Not every line in this batch has one yet (the schema was never made to
 *  require it) — that's real, partial coverage, not full Il Verificatore-grade
 *  formal validation. Il Verificatore (new in the brief's v10) owns doing this
 *  properly, across every document; this is a narrower stand-in until that
 *  seat exists. */
export function runVatRules(lines, taxonomy = [], context = {}) {
  const anomalies = [];
  for (const line of lines) {
    for (const check of LINE_ONLY_CHECKS) {
      const hit = check(line);
      if (hit) anomalies.push(hit);
    }
    const categoryHit = checkRateCategoryMatch(line, taxonomy);
    if (categoryHit) anomalies.push(categoryHit);
    const groupHit = checkVatGroupIdentity(line, context.vatGroup);
    if (groupHit) anomalies.push(groupHit);
  }
  anomalies.push(...checkUniqueLineNumbers(lines));
  return anomalies;
}
