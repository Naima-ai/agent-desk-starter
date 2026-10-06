// backend/classifier.mjs — Il Classificatore's brain.
// Resolves ONE low-confidence tail line to a Chart-of-Accounts account, using a
// learned rule if one exists (memory), otherwise an edge-SLM call over the line text
// + the studio L2 chart conventions (asks a human when still below threshold).
// Learns each operator correction as a durable rule via L'Archivista.

import * as knowledge from "./memory/knowledgeStore.mjs";
import { chartOfAccounts as fixtureChartOfAccounts } from "./seed.mjs";
import { askModel } from "./modelGateway.mjs";

const KEYWORDS = [
  ["consulen", "60.10"],
  ["prestazion", "60.10"],
  ["utenz", "60.20"],
  ["merc", "30.10"],
  ["cancell", "70.05"],
  ["materiale", "70.05"],
  ["hotel", "60.15"],
  ["alberg", "60.15"],
  ["viagg", "60.15"],
  ["trasport", "60.15"]
];

const THRESHOLD = 0.85;

// Resolves both `c.name` and `c.label` so system prompt never interpolates undefined
function classifierSystemPrompt(chartOfAccounts) {
  return `Sei Il Classificatore contabile per uno studio di commercialisti italiani.
Il tuo compito è analizzare la descrizione della riga di spesa e proporre il conto di costo appropriato dal piano dei conti aziendale.
Conti disponibili:
${chartOfAccounts.map((c) => `- Codice: ${c.code} (${c.name || c.label || "Spesa"})`).join("\n")}

Rispondi ESCLUSIVAMENTE con un JSON nel seguente formato:
{
  "account": "codice_conto",
  "confidence": 0.90,
  "reasoning": "motivazione sintetica"
}`;
}

/**
 * Classifies a single low-confidence tail line for ONE client.
 * Checks that client's durable memory first — keyed `client:<clientId>:coa:<supplier>`,
 * the same client-partition convention L'Amministrativo's own facts use, so a rule
 * learned for one client never silently applies to another client's same-named
 * supplier — then calls the SLM/LLM against THAT client's real chart of accounts
 * (not a fixed fixture: different clients genuinely have different charts, e.g.
 * reverse-charge/export/forfettario codes), and falls back to keywords if offline.
 *
 * @param {Object} line - Invoice line object (id, supplier, desc, net/amount, vatRate)
 * @param {string} clientId - which client this line belongs to (memory partition)
 * @param {Array} [coa] - this client's real chart of accounts; falls back to the
 *   single fixture client's chart if omitted (e.g. an older call site)
 * @returns {Promise<Object>} Line enriched with { account, code, confidence, confidenceFormatted, source, needsHuman }
 */
export async function classifyLine(line, clientId, coa = fixtureChartOfAccounts) {
  // 1. Memory short-circuit (L3 Client History / Confirmed rules from L'Archivista)
  const known = knowledge.get(`client:${clientId}:coa:${line.supplier}`);
  if (known) {
    const accountCode = known.value;
    const confidence = typeof known.confidence === "number" ? known.confidence : 1.0;
    return {
      ...line,
      account: accountCode,
      code: accountCode,
      confidence,
      confidenceFormatted: `${Math.round(confidence * 100)}%`,
      source: "memory",
      needsHuman: false
    };
  }

  // 2. Real SLM / LLM Classification via modelGateway
  const desc = (line.desc || "").trim();
  const supplier = (line.supplier || "").trim();

  if (desc || supplier) {
    try {
      const prompt = `Classifica questa riga contabile:\nFornitore: ${supplier || "N/D"}\nDescrizione: ${desc || "N/D"}\nImporto: ${line.amount ?? line.net ?? "N/D"}`;

      const rawResult = await askModel({
        prompt,
        systemPrompt: classifierSystemPrompt(coa),
        temperature: 0.1
      });

      let parsed = null;
      if (typeof rawResult === "string") {
        const cleaned = rawResult.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
        parsed = JSON.parse(cleaned);
      } else if (typeof rawResult === "object" && rawResult !== null) {
        parsed = rawResult;
      }

      // "never invent an account" (il_classificatore.job.txt) is a hard
      // constraint, not a suggestion — a model naming a code that isn't
      // actually in this client's chart of accounts must be treated as an
      // unusable answer (fall through to the keyword heuristic below,
      // which only ever returns codes that genuinely exist in `coa`), not
      // silently accepted as if it were real.
      const matched = coa.find((c) => c.code === parsed?.account);
      if (parsed && matched && typeof parsed.confidence === "number") {
        const accountCode = matched.code;
        const confidence = Math.min(1.0, Math.max(0.0, parsed.confidence));

        return {
          ...line,
          account: accountCode,
          code: accountCode,
          confidence,
          confidenceFormatted: `${Math.round(confidence * 100)}%`,
          source: "slm",
          needsHuman: confidence < THRESHOLD
        };
      }
    } catch (err) {
      // Model unavailable or offline -> fall through to keyword heuristic
    }
  }

  // 3. Deterministic Heuristic Fallback. Same "never invent an account"
  // constraint applies here — KEYWORDS is a fixed studio-wide list and has
  // no idea whether ITS codes exist in THIS client's actual chart (a
  // narrow chart, e.g. a forfettario or esente client, legitimately might
  // not carry "60.10" at all), so a keyword hit only counts if the client's
  // own chart confirms that code is real.
  const lowerDesc = desc.toLowerCase();
  const hit = KEYWORDS.find(([k, code]) => lowerDesc.includes(k) && coa.some((c) => c.code === code));
  const account = hit ? hit[1] : (coa[0]?.code || "60.10");
  const confidence = hit ? 0.7 : 0.4;

  return {
    ...line,
    account,
    code: account,
    confidence,
    confidenceFormatted: `${Math.round(confidence * 100)}%`,
    source: "heuristic",
    needsHuman: confidence < THRESHOLD
  };
}

// Learning a correction into a durable rule is L'Archivista's job now — see
// backend/archivista.mjs (proposeRule / confirmRule / learnConfirmed).
export default { classifyLine };
