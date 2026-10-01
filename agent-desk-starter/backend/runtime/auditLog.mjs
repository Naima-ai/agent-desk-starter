import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class MemoryAuditLog {
  #records = [];

  async append(record) {
    this.#records.push(Object.freeze({ ...record }));
  }

  history() { return this.#records.slice(); }
  clear() { this.#records.length = 0; }
}

export class JsonlAuditLog {
  #records = [];
  #queue = Promise.resolve();

  constructor(filePath) {
    if (!filePath) throw new TypeError("Audit file path is required.");
    this.filePath = filePath;
  }

  async append(record) {
    const frozen = Object.freeze({ ...record });
    this.#queue = this.#queue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(frozen)}\n`, { mode: 0o600 });
      this.#records.push(frozen);
    });
    return this.#queue;
  }

  async history() {
    await this.#queue;
    try {
      return (await readFile(this.filePath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  async clear() {
    await this.#queue;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, "", { mode: 0o600 });
    this.#records.length = 0;
  }
}

// Reads are allowed if audit storage is temporarily unavailable. Writes,
// external sends, payments and authority operations fail closed in guardrails.
export const AUDIT_FAILURE_POLICY = Object.freeze({
  read: "allow",
  write: "deny",
  external_send: "deny",
  payment: "deny",
  authority: "deny",
});
