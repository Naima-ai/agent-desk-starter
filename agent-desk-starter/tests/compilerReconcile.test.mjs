import test from "node:test";
import assert from "node:assert/strict";
import { reconcileWithSeed, getActiveManifest } from "../backend/compiler.mjs";

// What a small local model really returned for L'Amministrativo: the generic
// VAT-batch template from the compiler prompt, whatever the seat.
const genericTemplate = (seat) => ({
  ...getActiveManifest(seat),
  location: "studio_edge", tools: ["teamsystem.read_vat_batch", "teamsystem.write_journal"], skills: [],
  schedule: "event(teamsystem.vat_batch_ready)", gate: "human_review", artifact: "lipe_preview", unit: { per_batch: 40 }, refuses: [],
});

test("a model manifest cannot change what the seat can do: the vetted definition is kept", () => {
  const seed = getActiveManifest("l_amministrativo");
  const { manifest, warnings } = reconcileWithSeed("l_amministrativo", genericTemplate("l_amministrativo"));
  for (const k of ["location", "tools", "skills", "memory", "schedule", "gate", "artifact", "unit"]) {
    assert.deepEqual(manifest[k], seed[k], `${k} stays as vetted`);
  }
  assert.ok(manifest.skills.length > 0, "skills are not switched off");
  assert.ok(warnings.some((w) => /Ignored the model's changes to/.test(w)));
});

test("hard refusals can never be dropped by the model", () => {
  const seed = getActiveManifest("il_classificatore");
  const { manifest, warnings } = reconcileWithSeed("il_classificatore", genericTemplate("il_classificatore"));
  for (const r of seed.refuses) assert.ok(manifest.refuses.includes(r), `kept refusal ${r}`);
  assert.ok(warnings.some((w) => /restored/.test(w)));
});

test("refusals added by the job text are kept: a compile can only make a seat stricter", () => {
  const withExtra = { ...getActiveManifest("l_addetto_iva"), refuses: [...getActiveManifest("l_addetto_iva").refuses, "never_email_clients_after_18"] };
  const { manifest, warnings } = reconcileWithSeed("l_addetto_iva", withExtra);
  assert.ok(manifest.refuses.includes("never_email_clients_after_18"));
  assert.ok(warnings.some((w) => /Added refusals/.test(w)));
});

test("a manifest identical to the vetted one produces no warnings", () => {
  assert.deepEqual(reconcileWithSeed("l_addetto_iva", getActiveManifest("l_addetto_iva")).warnings, []);
});
