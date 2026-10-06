// backend/compiler.mjs
// The Job Card Compiler: NL job description -> validated manifest -> OpenClaw skill file.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateManifest } from "../contracts/manifestSchema.mjs";
import { askModel } from "./modelGateway.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const seatsDir = join(here, "..", "contracts", "seats");

// The manifest actually driving each seat's behavior right now — until
// OpenClaw exists as a real runtime that LOADS a compiled manifest and
// executes an agent from it, this in-memory cache is the closest thing:
// compiling a seat (Agent page, or POST /api/compile/:seat) updates it, and
// the few call sites that already have a manifest-consuming hook (today:
// just lAmministrativo.mjs's skillEnabled()/assertAllowed()) read from here
// instead of a fixed static import — so compiling something the SAME
// server session's next real run actually reflects it. Resets to the seed
// manifests on restart, same as this server's other in-memory state.
const activeManifests = new Map(); // seatId -> validated manifest

function loadSeedManifestSync(seatId) {
  const raw = readFileSync(join(seatsDir, `${seatId}.json`), "utf8");
  return validateManifest(JSON.parse(raw));
}

/** A model-written manifest is NOT trusted to define what a seat can do. A 3B
 *  model asked to "compile" a job description returns a generic VAT-batch
 *  template (wrong tools, location, skills, memory, schedule, gate...) whatever
 *  the seat; installed as the live manifest it either makes the runtime refuse
 *  every run (RUNTIME_CONFIGURATION_INVALID) or silently switches off the
 *  seat's skills. So the vetted seed manifest stays authoritative for every
 *  capability field, and the compile can only make a seat STRICTER: refusals
 *  the job text adds are kept (union). Every field the model tried to change
 *  is reported in  so nothing is ignored silently. */
export function reconcileWithSeed(seatId, manifest) {
  const seed = loadSeedManifestSync(seatId);
  const warnings = [];
  const ignored = Object.keys(seed).filter((k) => k !== "refuses" && k !== "seat" && JSON.stringify(seed[k]) !== JSON.stringify(manifest[k]));
  if (ignored.length) warnings.push(`Ignored the model's changes to: ${ignored.join(", ")} (the vetted seat definition is kept)`);
  const droppedRefuses = seed.refuses.filter((x) => !manifest.refuses.includes(x));
  if (droppedRefuses.length) warnings.push(`The model dropped hard refusals; restored: ${droppedRefuses.join(", ")}`);
  const addedRefuses = manifest.refuses.filter((x) => !seed.refuses.includes(x));
  if (addedRefuses.length) warnings.push(`Added refusals from the job text: ${addedRefuses.join(", ")}`);
  return { manifest: validateManifest({ ...seed, refuses: [...seed.refuses, ...addedRefuses] }), warnings };
}

/** Synchronous on purpose — assertAllowed() is a hot, synchronous hard-block
 *  check (tests call it as `assert.throws(() => fn())`), and making the
 *  active-manifest lookup async would force that whole call chain async
 *  too, for no real benefit once the manifest is already cached. */
export function getActiveManifest(seatId) {
  if (!activeManifests.has(seatId)) activeManifests.set(seatId, loadSeedManifestSync(seatId));
  return activeManifests.get(seatId);
}

const COMPILER_SYSTEM_PROMPT = `Sei il Chief of Staff (Il Capogabinetto) del sistema Loop Agent Desk per commercialisti italiani.
Il tuo compito è analizzare la Job Description di un agente (scritta in linguaggio naturale italiano) 
ed estrarre un manifesto JSON rigoroso, valido secondo il ManifestSchema.

Struttura JSON richiesta:
{
  "seat": "nome_univoco_snake_case",
  "location": "studio_edge" | "client_edge",
  "model": { "edge": "qwen3.5-4b", "fallback": "kimi" },
  "tools": ["tool.uno", "tool.due"],
  "skills": [],
  "memory": { "read": [0, 1, 2, 3], "write": [3] },
  "refuses": ["divieto_1", "divieto_2"],
  "schedule": "event(...)",
  "gate": "nome_gate_umano",
  "artifact": "descrizione_artefatto",
  "unit": { "per_batch": 40 }
}
Rispondi SOLO con l'oggetto JSON, senza commenti e senza blocchi markdown.`;

/**
 * Parses raw Italian job text into a validated manifest.
 * Uses askModel (Edge SLM / Cloud Fallback) with fallback to verified seed JSON.
 */
export async function parseJobTextToManifest(jobText, fallbackSeatId = null) {
  if (jobText && typeof jobText === "string" && jobText.trim()) {
    const prompt = `Analizza la seguente Job Description ed emetti il manifesto JSON corrispondente:\n\n${jobText}`;
    try {
      const rawResult = await askModel({
        prompt,
        systemPrompt: COMPILER_SYSTEM_PROMPT,
        temperature: 0.1
      });

      let parsed = null;
      if (typeof rawResult === "string") {
        const cleaned = rawResult.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
        parsed = JSON.parse(cleaned);
      } else if (typeof rawResult === "object" && rawResult !== null) {
        parsed = rawResult;
      }

      if (parsed) {
        // The caller always knows which seat it's compiling (both call sites
        // below pass it) — that's more authoritative than whatever the model
        // says, so it always wins, not just when the model left `seat` blank.
        // Found for real: modelGateway.mjs's OFFLINE fallback (no local SLM,
        // no cloud key — the default in this dev environment) always returns
        // a hardcoded manifest shaped for "l_addetto_iva" regardless of which
        // seat asked, so compiling e.g. "l_amministrativo" silently returned
        // l_addetto_iva's manifest instead — `!parsed.seat` never caught it
        // because the fallback DOES set a (wrong) seat.
        if (fallbackSeatId) {
          parsed.seat = fallbackSeatId;
        }
        return validateManifest(parsed);
      }
    } catch (err) {
      // Model unavailable, timed out, or unparseable JSON -> fall through to disk seed
    }
  }

  // Resilient fallback: load the seed manifest for this seat from disk
  if (fallbackSeatId) {
    const raw = await readFile(join(seatsDir, `${fallbackSeatId}.json`), "utf8");
    return validateManifest(JSON.parse(raw));
  }

  throw new Error("compiler: Unable to parse job text and no valid fallback seatId provided.");
}

// STEP 1: parse NL -> manifest.
// Reads the seat's .job.txt, passes it to the SLM/LLM, and validates the output.
export async function parseJobToManifest(seatId) {
  const jobPath = join(seatsDir, `${seatId}.job.txt`);
  const jobText = await readFile(jobPath, "utf8").catch(() => "");
  return parseJobTextToManifest(jobText, seatId);
}

// STEP 2: validate against the contract (this is the guardrail gate).
// STEP 3: emit an OpenClaw skill file (SOUL.md-style) with hard blocks.
export async function compile(seatId) {
  const { manifest, warnings } = reconcileWithSeed(seatId, await parseJobToManifest(seatId));
  const job = await readFile(join(seatsDir, `${seatId}.job.txt`), "utf8").catch(() => "");
  const skill = emitSkill(manifest, job);
  const outDir = join(here, "..", "build", "skills");
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, `${seatId}.md`), skill, "utf8");
  activeManifests.set(seatId, manifest); // this is now what the real pipeline reads for this seat
  return { manifest, skill, warnings };
}

// Used by the frontend's "write the job in Italian" box.
// Parses custom job text via SLM/LLM into a live manifest validated by ManifestSchema.
export async function compileWithJobText(seatId, jobText) {
  const { manifest, warnings } = reconcileWithSeed(seatId, await parseJobTextToManifest(jobText, seatId));
  const skill = emitSkill(manifest, jobText || "");
  const outDir = join(here, "..", "build", "skills");
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, `${seatId}.md`), skill, "utf8");
  activeManifests.set(seatId, manifest); // this is now what the real pipeline reads for this seat
  return { manifest, skill, warnings, usedCustomJobText: Boolean(jobText) };
}

export function emitSkill(m, job) {
  const block = (arr) => (Array.isArray(arr) && arr.length ? arr.map((x) => `- ${x}`).join("\n") : "- (none)");
  return `# SOUL — ${m.seat}
> Generated by the Job Card Compiler. Do not edit by hand; edit the job description and recompile.

## Mission (from the job description)
${job.trim() || "(job description not provided)"}

## Runtime binding
- location: ${m.location}
- model: edge=${m.model.edge}, fallback=${m.model.fallback}
- memory: read=[${m.memory.read}] write=[${m.memory.write}]${m.memory.partition ? ` partition=${m.memory.partition}` : ""}

## Allowed tools
${block(m.tools)}
${m.skills && m.skills.length ? `\n## Skills (per client)\n${block(m.skills)}` : ""}

## HARD BLOCKS (enforced at runtime, not prompt hints)
${block(m.refuses)}
${m.gate ? `\n## Human gate\n- ${m.gate}` : ""}

## Proof / metering
- artifact: ${m.artifact || "(none)"}
- unit: ${JSON.stringify(m.unit)}
`;
}

export default { compile, compileWithJobText, parseJobToManifest, parseJobTextToManifest, emitSkill, getActiveManifest };
