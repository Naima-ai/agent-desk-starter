// backend/loadEnv.mjs — loads .env into process.env if the file exists.
//
// Found for real: this server never actually loaded .env at all — no
// dotenv package, no --env-file flag anywhere — so a real, valid Fatture
// in Cloud token sitting in .env was silently ignored every single run,
// with every connector quietly falling back to its offline stub. Node's
// own `node --env-file=.env` looks like the obvious fix, but it HARD FAILS
// if the file doesn't exist (verified directly), and .env is gitignored —
// most teammates won't have one, so that would break `npm start` for
// everyone else. This is a tiny, dependency-free, missing-file-safe
// substitute: parse simple KEY=VALUE lines, skip blanks/comments, and
// never override a real environment variable that's already set.
//
// MUST be imported first, before any connector module — fattureInCloud.mjs
// and whatsapp.mjs both read process.env at module load time (top-level
// `const accessToken = process.env.FIC_ACCESS_TOKEN`), so if this runs
// after them, the values they captured are already stale.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, "..", ".env");

if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = value; // a real env var always wins over .env
  }
}
