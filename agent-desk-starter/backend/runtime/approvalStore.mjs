import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TERMINAL = new Set(["denied", "expired", "consumed"]);
const BINDING_FIELDS = ["runId", "seat", "clientId", "toolId", "action", "argsHash"];

function sameBinding(record, binding) {
  return BINDING_FIELDS.every((field) => record[field] === binding[field]);
}

function copy(record) {
  return record ? structuredClone(record) : null;
}

export class ApprovalStore {
  #records = new Map();
  #loaded = false;
  #queue = Promise.resolve();

  constructor({ filePath = null, clock = () => Date.now(), idGenerator = randomUUID } = {}) {
    this.filePath = filePath;
    this.clock = clock;
    this.idGenerator = idGenerator;
  }

  #exclusive(work) {
    const operation = this.#queue.then(work, work);
    this.#queue = operation.catch(() => {});
    return operation;
  }

  async #load() {
    if (this.#loaded) return;
    if (!this.filePath) {
      this.#loaded = true;
      return;
    }
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      for (const record of Array.isArray(parsed) ? parsed : []) {
        if (record && typeof record.id === "string") this.#records.set(record.id, record);
      }
      this.#loaded = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.#loaded = true;
    }
  }

  async #persist() {
    if (!this.filePath) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify([...this.#records.values()], null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.filePath);
  }

  #expire(now) {
    let changed = false;
    for (const record of this.#records.values()) {
      if ((record.status === "pending" || record.status === "approved") && Date.parse(record.expiresAt) <= now) {
        record.status = "expired";
        record.resolvedAt = new Date(now).toISOString();
        changed = true;
      }
    }
    return changed;
  }

  async request(binding, { requiredApprover, requester, expiresInSeconds = 900 } = {}) {
    return this.#exclusive(async () => {
      await this.#load();
      const now = this.clock();
      const expired = this.#expire(now);
      const existing = [...this.#records.values()].find((record) =>
        record.status === "pending" && record.requiredApprover === requiredApprover && sameBinding(record, binding));
      if (existing) {
        if (expired) await this.#persist();
        return copy(existing);
      }
      const record = {
        id: `approval_${this.idGenerator()}`,
        ...binding,
        requiredApprover,
        requester,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + expiresInSeconds * 1000).toISOString(),
        status: "pending",
        resolvedBy: null,
        resolvedRole: null,
        resolvedAt: null,
        consumedAt: null,
      };
      this.#records.set(record.id, record);
      await this.#persist();
      return copy(record);
    });
  }

  async approve(id, { approvedBy, approverRole } = {}) {
    return this.#exclusive(async () => {
      await this.#load();
      const now = this.clock();
      this.#expire(now);
      const record = this.#records.get(id);
      if (!record) throw new Error("No such approval.");
      if (record.status !== "pending") throw new Error(`Approval is ${record.status}.`);
      if (!approvedBy || approverRole !== record.requiredApprover) throw new Error("Approver identity or role does not match the gate.");
      record.status = "approved";
      record.resolvedBy = approvedBy;
      record.resolvedRole = approverRole;
      record.resolvedAt = new Date(now).toISOString();
      await this.#persist();
      return copy(record);
    });
  }

  async deny(id, { deniedBy = "unknown", reason = null } = {}) {
    return this.#exclusive(async () => {
      await this.#load();
      const now = this.clock();
      this.#expire(now);
      const record = this.#records.get(id);
      if (!record) throw new Error("No such approval.");
      if (record.status !== "pending") throw new Error(`Approval is ${record.status}.`);
      record.status = "denied";
      record.resolvedBy = deniedBy;
      record.resolvedAt = new Date(now).toISOString();
      record.denialReason = reason;
      await this.#persist();
      return copy(record);
    });
  }

  async consumeApproved(binding, { approvalId = null } = {}) {
    return this.#exclusive(async () => {
      await this.#load();
      const now = this.clock();
      const expired = this.#expire(now);
      const record = approvalId
        ? this.#records.get(approvalId)
        : [...this.#records.values()].find((candidate) => candidate.status === "approved" && sameBinding(candidate, binding));
      if (!record || record.status !== "approved" || !sameBinding(record, binding)) {
        if (expired) await this.#persist();
        return null;
      }
      record.status = "consumed";
      record.consumedAt = new Date(now).toISOString();
      await this.#persist();
      return copy(record);
    });
  }

  async get(id) {
    return this.#exclusive(async () => {
      await this.#load();
      const changed = this.#expire(this.clock());
      if (changed) await this.#persist();
      return copy(this.#records.get(id));
    });
  }

  async list({ status = null } = {}) {
    return this.#exclusive(async () => {
      await this.#load();
      const changed = this.#expire(this.clock());
      if (changed) await this.#persist();
      return [...this.#records.values()].filter((record) => !status || record.status === status).map(copy);
    });
  }

  async clear() {
    return this.#exclusive(async () => {
      await this.#load();
      this.#records.clear();
      await this.#persist();
    });
  }
}

const here = dirname(fileURLToPath(import.meta.url));
export const defaultApprovalStore = new ApprovalStore({
  filePath: join(here, "..", "..", "data", "runtime-approvals.json"),
});

export { TERMINAL as TERMINAL_APPROVAL_STATUSES };
