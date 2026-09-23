// backend/rosterStore.mjs — the REAL roster Lo Smistatore routes against,
// replacing backend/fixtures/roster.fixture.mjs's hardcoded array.
//
// Persists to disk (same pattern as teamsystem-firm-mock's custom-clients.json)
// so edits survive a restart, with a real add/update/remove API instead of a
// file you'd have to hand-edit and redeploy. Seeds itself from the existing
// fixture on first run, so nothing's behavior changes until someone actually
// edits a staff entry.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RosterEntrySchema } from "../contracts/rosterSchema.mjs";
import { rosterFixture } from "./fixtures/roster.fixture.mjs";

// Same top-level data/ directory knowledgeStore.mjs and evidenceStore.mjs
// already use (already gitignored as a whole — see .gitignore) — not a new
// backend/data/ location.
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "data");
const rosterFile = join(dataDir, "roster.json");

function load() {
  if (existsSync(rosterFile)) {
    return JSON.parse(readFileSync(rosterFile, "utf8"));
  }
  // First run: seed from the fixture, giving each entry a stable id so it
  // can be edited/removed individually (the fixture array has none).
  return rosterFixture.map((entry, i) => ({ id: `seed_${i}`, ...entry }));
}

let roster = load();

function persist() {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(rosterFile, JSON.stringify(roster, null, 2), "utf8");
}

/** The current roster, `{id, ...RosterEntrySchema}` per entry — what
 *  smistatore.mjs's route() actually reads now, instead of a fixed import. */
export function getRoster() {
  return roster;
}

/** Add a new staff entry. Returns the created entry (with its new id), or
 *  throws a ZodError if the shape is invalid (competence/tier/etc). */
export function addRosterEntry(entry) {
  const validated = RosterEntrySchema.parse(entry);
  const withId = { id: `staff_${Date.now()}_${Math.floor(Math.random() * 1000)}`, ...validated };
  roster = [...roster, withId];
  persist();
  return withId;
}

/** Update an existing entry by id (partial patch). Returns the updated
 *  entry, or null if no entry has that id. */
export function updateRosterEntry(id, patch) {
  const idx = roster.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const merged = RosterEntrySchema.parse({ ...roster[idx], ...patch });
  const updated = { id, ...merged };
  roster = [...roster.slice(0, idx), updated, ...roster.slice(idx + 1)];
  persist();
  return updated;
}

/** Remove a staff entry by id. Returns true if something was actually removed. */
export function removeRosterEntry(id) {
  const before = roster.length;
  roster = roster.filter((r) => r.id !== id);
  if (roster.length !== before) persist();
  return roster.length !== before;
}
