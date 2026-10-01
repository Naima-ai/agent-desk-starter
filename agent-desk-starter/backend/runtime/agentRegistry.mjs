import { RuntimeError } from "./errors.mjs";

function normalizeOperation(name, operation) {
  if (typeof operation === "function") return { name, handler: operation, inputSchema: null, outputSchema: null, tools: null };
  if (!operation || typeof operation.handler !== "function") {
    throw new TypeError(`Agent operation "${name}" must provide a handler function.`);
  }
  if (operation.tools !== undefined && (!Array.isArray(operation.tools) || operation.tools.some((toolId) => typeof toolId !== "string" || !toolId))) {
    throw new TypeError(`Agent operation "${name}" has an invalid tool capability list.`);
  }
  return {
    name,
    handler: operation.handler,
    inputSchema: operation.inputSchema || null,
    outputSchema: operation.outputSchema || null,
    tools: Array.isArray(operation.tools) ? Object.freeze([...new Set(operation.tools)]) : null,
  };
}

export class AgentRegistry {
  #agents = new Map();

  register({ seat, operations }) {
    if (!/^[a-z0-9_]+$/.test(seat || "")) throw new TypeError("Agent seat must be snake_case.");
    if (this.#agents.has(seat)) throw new Error(`Agent "${seat}" is already registered.`);
    if (!operations || typeof operations !== "object" || Array.isArray(operations)) {
      throw new TypeError(`Agent "${seat}" must declare operations.`);
    }

    const normalized = new Map();
    for (const [name, operation] of Object.entries(operations)) {
      if (!/^[a-z0-9_]+$/.test(name)) throw new TypeError(`Operation "${name}" must be snake_case.`);
      normalized.set(name, normalizeOperation(name, operation));
    }
    if (normalized.size === 0) throw new TypeError(`Agent "${seat}" must declare at least one operation.`);

    this.#agents.set(seat, Object.freeze({ seat, operations: normalized }));
    return this;
  }

  resolve(seat, operation) {
    const agent = this.#agents.get(seat);
    if (!agent) throw new RuntimeError("UNKNOWN_AGENT", `No runtime adapter is registered for seat "${seat}".`);
    const resolved = agent.operations.get(operation);
    if (!resolved) {
      throw new RuntimeError("UNKNOWN_OPERATION", `Seat "${seat}" does not expose operation "${operation}".`);
    }
    return resolved;
  }

  has(seat) { return this.#agents.has(seat); }
  seats() { return [...this.#agents.keys()]; }
  operations(seat) {
    const agent = this.#agents.get(seat);
    return agent ? [...agent.operations.values()] : [];
  }
}
