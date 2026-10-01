import { defaultA2ABus } from "../messaging/a2aBus.mjs";
import { defaultUiBus } from "../messaging/uiBus.mjs";
import { resolveQuestion, resolveQuestionById } from "../lAmministrativo.mjs";
import { defaultAgentEngine } from "./agentEngine.mjs";

function runtimeFailure(result) {
  const error = new Error(result.error?.message || `Runtime ended with status "${result.status}".`);
  error.code = result.error?.code || "RUNTIME_CONSUMER_FAILED";
  error.retryable = result.error?.retryable ?? result.status === "failed";
  return error;
}

function permanentFailure(code, message) {
  const error = new Error(message);
  error.code = code;
  error.retryable = false;
  return error;
}

export class RuntimeA2AConsumers {
  #starting = null;
  #stops = [];
  #outcomes = new Map();
  #waiters = new Map();

  constructor({ bus, engine, uiBus = defaultUiBus, outcomeLimit = 500 } = {}) {
    if (!bus || !engine) throw new TypeError("Runtime A2A consumers require a bus and an agent engine.");
    this.bus = bus;
    this.engine = engine;
    this.uiBus = uiBus;
    this.outcomeLimit = outcomeLimit;
    this.started = false;
  }

  #record(messageId, outcome) {
    this.#outcomes.set(messageId, Object.freeze(outcome));
    while (this.#outcomes.size > this.outcomeLimit) this.#outcomes.delete(this.#outcomes.keys().next().value);
    const waiters = this.#waiters.get(messageId) || [];
    this.#waiters.delete(messageId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(outcome);
    }
  }

  async #route(message) {
    const run = await this.engine.runAgent({
      runId: `a2a:${message.id}:route`,
      seat: "lo_smistatore",
      operation: "route_message",
      input: { message },
      context: {
        clientId: message.client,
        correlationId: message.correlationId || message.id,
        causationId: message.id,
        actor: `agent:${message.from}`,
      },
    });
    if (run.status !== "completed") throw runtimeFailure(run);
    const result = run.artifacts[0];
    this.uiBus.publish("routing", result);
    if (result.kind === "routed_task") {
      this.uiBus.publish("feed", {
        agent: "lo_smistatore",
        text: `Routed ${result.sourceMessageType} (${result.client}) to ${result.owner}` +
          `${result.escalated ? ` — escalated to tier ${result.escalationTier}` : ""}.`,
        tone: result.escalated ? "warn" : "info",
      });
    } else {
      this.uiBus.publish("feed", {
        agent: "lo_smistatore",
        text: `Could not route ${result.sourceMessageType} for ${result.client} — ${result.reason}.`,
        tone: "warn",
      });
    }
    this.#record(message.id, { status: "completed", recipient: "lo_smistatore", result, run });
    return result;
  }

  async #administer(message) {
    if (message.type === "answer_with_evidence") {
      const resolved = message.ref
        ? resolveQuestionById(message.ref, message)
        : resolveQuestion(message.client, message);
      const result = { resolved: Boolean(resolved), questionId: resolved?.id || message.ref || null };
      this.#record(message.id, { status: "completed", recipient: "l_amministrativo", result });
      return result;
    }
    if (message.type === "acknowledgment") {
      const result = { acknowledged: true, ref: message.ref };
      this.#record(message.id, { status: "completed", recipient: "l_amministrativo", result });
      return result;
    }
    if (message.type !== "instruction_from_studio") {
      throw permanentFailure(
        "UNSUPPORTED_RECIPIENT_MESSAGE",
        `L'Amministrativo cannot consume A2A type "${message.type}".`,
      );
    }

    const run = await this.engine.runAgent({
      runId: `a2a:${message.id}:handle`,
      seat: "l_amministrativo",
      operation: "handle_instruction",
      input: { message: { instruction: message.instruction, due: message.due } },
      context: {
        clientId: message.client,
        correlationId: message.correlationId || message.id,
        causationId: message.id,
        actor: `agent:${message.from}`,
      },
    });
    if (run.status !== "completed" && run.status !== "awaiting_approval" && run.status !== "refused") {
      throw runtimeFailure(run);
    }
    const result = run.artifacts[0] || null;
    const outcome = { status: run.status, recipient: "l_amministrativo", result, run };
    this.#record(message.id, outcome);
    return outcome;
  }

  async start() {
    if (this.started) return this;
    if (this.#starting) return this.#starting;
    this.#starting = (async () => {
      const stops = [];
      try {
        stops.push(await this.bus.subscribeA2A(
          { recipient: "lo_smistatore", consumerId: "runtime:lo_smistatore:v1" },
          (message) => this.#route(message),
        ));
        stops.push(await this.bus.subscribeA2A(
          { recipient: "l_amministrativo", consumerId: "runtime:l_amministrativo:v1" },
          (message) => this.#administer(message),
        ));
        this.#stops = stops;
        this.started = true;
        return this;
      } catch (error) {
        for (const stop of stops.reverse()) await stop();
        throw error;
      }
    })().finally(() => { this.#starting = null; });
    return this.#starting;
  }

  waitForOutcome(messageId, { timeoutMs = 30_000 } = {}) {
    const existing = this.#outcomes.get(messageId);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const current = this.#waiters.get(messageId) || [];
          const remaining = current.filter((item) => item !== waiter);
          if (remaining.length) this.#waiters.set(messageId, remaining);
          else this.#waiters.delete(messageId);
          const error = new Error(`Timed out waiting for A2A outcome "${messageId}".`);
          error.code = "A2A_OUTCOME_TIMEOUT";
          error.retryable = true;
          reject(error);
        }, timeoutMs),
      };
      const current = this.#waiters.get(messageId) || [];
      current.push(waiter);
      this.#waiters.set(messageId, current);
    });
  }

  async close() {
    if (this.#starting) await this.#starting;
    for (const stop of this.#stops.reverse()) await stop();
    this.#stops = [];
    this.started = false;
    for (const waiters of this.#waiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(permanentFailure("A2A_CONSUMERS_CLOSED", "A2A consumers closed before the outcome arrived."));
      }
    }
    this.#waiters.clear();
  }
}

export const defaultRuntimeA2AConsumers = new RuntimeA2AConsumers({
  bus: defaultA2ABus,
  engine: defaultAgentEngine,
});

export const startDefaultA2AConsumers = defaultRuntimeA2AConsumers.start.bind(defaultRuntimeA2AConsumers);
export const waitForA2AOutcome = defaultRuntimeA2AConsumers.waitForOutcome.bind(defaultRuntimeA2AConsumers);
