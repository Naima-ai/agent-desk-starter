// backend/classifier.mjs — Il Classificatore's brain.
// Resolves ONE low-confidence tail line to a Chart-of-Accounts account, using a
// learned rule if one exists (memory), otherwise a keyword heuristic (asks a human
// when still below threshold). Learns each operator correction as a durable rule.
// >>> TODO (real): replace the heuristic with an edge-SLM call over the line text
//     + the studio L2 chart conventions; keep the memory short-circuit.
import * as knowledge from "./memory/knowledgeStore.mjs";
import { chartOfAccounts } from "./seed.mjs";

const KEYWORDS = [["consulen", "60.10"], ["prestazion", "60.10"], ["utenz", "60.20"], ["merc", "30.10"], ["cancell", "70.05"], ["materiale", "70.05"]];
const THRESHOLD = 0.85;

// Keyed `client:<clientId>:coa:<supplier>` — the same client-partition
// convention L'Amministrativo's own facts use (memory/knowledgeStore.mjs) —
// so a supplier name that happens to recur across two different clients
// (e.g. two clients both buying from "Bianchi Studio") doesn't share one
// rule between them. Previously this was a bare `coa:<supplier>` key with
// no clientId at all, so a rule learned for one client silently applied to
// every other client with a same-named supplier too.
export function classifyLine(line, clientId) {
  const known = knowledge.get(`client:${clientId}:coa:${line.supplier}`);
  if (known) return { ...line, account: known.value, confidence: known.confidence, source: "memory", needsHuman: false };
  const desc = (line.desc || "").toLowerCase();
  const hit = KEYWORDS.find(([k]) => desc.includes(k));
  const account = hit ? hit[1] : chartOfAccounts[0].code;
  const confidence = hit ? 0.7 : 0.4;
  return { ...line, account, confidence, source: "heuristic", needsHuman: confidence < THRESHOLD };
}

// Learning a correction into a durable rule is L'Archivista's job now — see
// backend/archivista.mjs (proposeRule / confirmRule / learnConfirmed).
