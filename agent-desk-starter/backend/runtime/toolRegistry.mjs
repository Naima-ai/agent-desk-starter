import { RuntimeError } from "./errors.mjs";

const RISKS = new Set(["read", "write", "external_send", "payment", "authority"]);
const LOCATIONS = new Set(["studio_edge", "client_side"]);

export class ToolRegistry {
  #tools = new Map();

  register(definition) {
    const { id, action, risk, execute } = definition || {};
    if (typeof id !== "string" || !id) throw new TypeError("Tool id is required.");
    if (typeof action !== "string" || !action) throw new TypeError(`Tool "${id}" requires an action.`);
    if (!RISKS.has(risk)) throw new TypeError(`Tool "${id}" has unsupported risk "${risk}".`);
    if (typeof execute !== "function") throw new TypeError(`Tool "${id}" requires an execute function.`);
    if (this.#tools.has(id)) throw new Error(`Tool "${id}" is already registered.`);
    if (definition.aliases?.length) throw new TypeError(`Tool "${id}" aliases are not supported.`);
    if (definition.locations && (!Array.isArray(definition.locations) || definition.locations.some((location) => !LOCATIONS.has(location)))) {
      throw new TypeError(`Tool "${id}" has invalid locations.`);
    }
    if (definition.memoryAccess) {
      const { mode, layer } = definition.memoryAccess;
      if (!new Set(["read", "write"]).has(mode) || !Number.isInteger(layer) || layer < 0 || layer > 3) {
        throw new TypeError(`Tool "${id}" has invalid memory access metadata.`);
      }
    }
    if (definition.clientScopePaths && (!Array.isArray(definition.clientScopePaths) || definition.clientScopePaths.some((path) => typeof path !== "string" || !path))) {
      throw new TypeError(`Tool "${id}" has invalid client scope paths.`);
    }

    this.#tools.set(id, Object.freeze({
      id,
      action,
      risk,
      inputSchema: definition.inputSchema || null,
      outputSchema: definition.outputSchema || null,
      idempotent: Boolean(definition.idempotent),
      requiresApproval: definition.requiresApproval || false,
      approver: definition.approver || null,
      approvalExpiresInSeconds: definition.approvalExpiresInSeconds || 900,
      locations: definition.locations ? Object.freeze([...definition.locations]) : null,
      memoryAccess: definition.memoryAccess ? Object.freeze({ ...definition.memoryAccess }) : null,
      clientScopePaths: definition.clientScopePaths ? Object.freeze([...definition.clientScopePaths]) : Object.freeze([]),
      execute,
    }));
    return this;
  }

  resolve(id) {
    const tool = this.#tools.get(id);
    if (!tool) throw new RuntimeError("UNKNOWN_TOOL", `Tool "${id}" is not registered.`);
    return tool;
  }

  has(id) { return this.#tools.has(id); }
  ids() { return [...this.#tools.keys()]; }
}
