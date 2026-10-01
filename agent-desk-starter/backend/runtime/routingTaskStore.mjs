import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export class RoutingTaskStore {
  #known = null;
  #queue = Promise.resolve();

  constructor(filePath = join(here, "..", "..", "data", "routing-tasks.jsonl")) {
    this.filePath = filePath;
  }

  async #loadKnown() {
    if (this.#known) return this.#known;
    this.#known = new Set();
    try {
      const content = await readFile(this.filePath, "utf8");
      for (const line of content.split("\n").filter(Boolean)) {
        const record = JSON.parse(line);
        if (record.sourceMessageId) this.#known.add(record.sourceMessageId);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return this.#known;
  }

  async persist({ sourceMessageId, result, at = new Date().toISOString() }) {
    if (!sourceMessageId) throw new TypeError("A routing source message ID is required.");
    const write = async () => {
      const known = await this.#loadKnown();
      if (known.has(sourceMessageId)) return { persisted: true, duplicate: true, sourceMessageId };
      const record = Object.freeze({ sourceMessageId, result, at });
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      known.add(sourceMessageId);
      return { persisted: true, duplicate: false, sourceMessageId };
    };
    this.#queue = this.#queue.then(write, write);
    return this.#queue;
  }

  async history() {
    await this.#queue;
    try {
      return (await readFile(this.filePath, "utf8"))
        .split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }
}

export const defaultRoutingTaskStore = new RoutingTaskStore();
