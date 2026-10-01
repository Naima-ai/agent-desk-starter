import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonlAuditLog } from "./auditLog.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const runtimeAudit = new JsonlAuditLog(join(here, "..", "..", "data", "runtime-audit.jsonl"));
