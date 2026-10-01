import { createHash, randomUUID } from "node:crypto";
import { defaultApprovalStore } from "./approvalStore.mjs";
import { runtimeAudit } from "./audit.mjs";
import { AUDIT_FAILURE_POLICY } from "./auditLog.mjs";
import { isSystemRefusal, systemGateFor, systemRefusalsFor } from "./systemPolicy.mjs";

const APPROVERS = new Set(["owner", "studio_professional", "credential_owner"]);
const LEGACY_GATES = Object.freeze({
  transmission_to_ade: { approver: "studio_professional", actions: ["transmit_to_authority"], expiresInSeconds: 900 },
  line_below_confidence_threshold: { approver: "studio_professional", actions: ["post_below_confidence"], expiresInSeconds: 900 },
  rule_confirmation: { approver: "studio_professional", actions: ["confirm_rule", "auto_confirm_rule"], expiresInSeconds: 900 },
  credential_change: { approver: "credential_owner", actions: ["credential_change"], expiresInSeconds: 900 },
  human_review: { approver: "studio_professional", actions: ["*"], expiresInSeconds: 900 },
});

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function hashArguments(args) {
  return createHash("sha256").update(JSON.stringify(canonicalize(args))).digest("hex");
}

export function normalizeGate(gate) {
  if (gate == null || gate === "" || gate === "none_internal") return null;
  if (typeof gate === "object" && !Array.isArray(gate)) {
    if (APPROVERS.has(gate.approver) && Array.isArray(gate.actions) && gate.actions.length > 0) {
      return { approver: gate.approver, actions: [...gate.actions], expiresInSeconds: gate.expiresInSeconds || 900, source: "manifest:structured_gate" };
    }
    return { approver: "studio_professional", actions: ["*"], expiresInSeconds: 900, source: "manifest:malformed_gate" };
  }
  if (typeof gate !== "string") {
    return { approver: "studio_professional", actions: ["*"], expiresInSeconds: 900, source: "manifest:malformed_gate" };
  }
  if (LEGACY_GATES[gate]) return { ...LEGACY_GATES[gate], source: `manifest:legacy_gate:${gate}` };
  const parsed = gate.match(/^(owner|studio_professional|credential_owner)_approval\(([^)]+)\)$/);
  if (parsed) {
    return {
      approver: parsed[1],
      actions: parsed[2].split("|").map((action) => action.trim()).filter(Boolean),
      expiresInSeconds: 900,
      source: `manifest:legacy_gate:${gate}`,
    };
  }
  return { approver: "studio_professional", actions: ["*"], expiresInSeconds: 900, source: "manifest:unknown_gate" };
}

function gateMatches(gate, action) {
  return Boolean(gate?.actions.includes("*") || gate?.actions.includes(action));
}

function validIdentity(run, manifest, tool, args) {
  if (!run || typeof run.runId !== "string" || !run.runId || typeof run.seat !== "string" || !run.seat) return "INVALID_IDENTITY";
  if (typeof run.clientId !== "string" || !run.clientId || manifest?.seat !== run.seat) return "CLIENT_SCOPE_MISMATCH";
  if (!tool || typeof tool.id !== "string" || typeof tool.action !== "string") return "UNKNOWN_TOOL";
  if (!args || typeof args !== "object" || Array.isArray(args)) return "INVALID_TOOL_ARGUMENTS";
  if (Object.hasOwn(args, "clientId") && args.clientId !== run.clientId) return "CLIENT_SCOPE_MISMATCH";
  for (const path of tool.clientScopePaths || []) {
    const value = path.split(".").reduce((current, key) => current?.[key], args);
    if (value !== run.clientId) return "CLIENT_SCOPE_MISMATCH";
  }
  return null;
}

function boundaryFailure(manifest, tool) {
  if (tool.locations?.length && !tool.locations.includes(manifest.location)) return "LOCATION_NOT_ALLOWED";
  if (tool.memoryAccess) {
    const { mode, layer } = tool.memoryAccess;
    if (!manifest.memory?.[mode]?.includes(layer)) return "MEMORY_SCOPE_DENIED";
  }
  return null;
}

function publicApproval(record) {
  return {
    id: record.id, runId: record.runId, seat: record.seat, clientId: record.clientId,
    toolId: record.toolId, action: record.action, requiredApprover: record.requiredApprover,
    status: record.status, createdAt: record.createdAt, expiresAt: record.expiresAt,
  };
}

export function createGuardrails({ approvalStore = defaultApprovalStore, audit = runtimeAudit, clock = () => Date.now(), idGenerator = randomUUID } = {}) {
  return async function authorize(request = {}) {
    const decisionId = idGenerator();
    const { run, manifest, tool, args = {}, approvalReceipt = null } = request;
    const policyRefs = [];
    let argsHash = null;

    const finish = async (decision) => {
      const record = {
        decisionId, runId: run?.runId || null, correlationId: run?.correlationId || null,
        seat: run?.seat || manifest?.seat || null, clientId: run?.clientId || null,
        toolId: tool?.id || null, action: tool?.action || null, argsHash,
        outcome: decision.outcome,
        reasonCode: decision.code || (decision.outcome === "allow" ? "ALLOWED" : "APPROVAL_REQUIRED"),
        policyRefs: [...policyRefs], approvalId: decision.approval?.id || decision.approvalId || null,
        at: new Date(clock()).toISOString(),
      };
      try {
        await audit.append(record);
      } catch {
        if (AUDIT_FAILURE_POLICY[tool?.risk] !== "allow") {
          return { outcome: "deny", decisionId, code: "AUDIT_UNAVAILABLE", reason: "High-risk tools require a durable audit decision." };
        }
      }
      return { decisionId, ...decision };
    };

    try {
      const identityError = validIdentity(run, manifest, tool, args);
      if (identityError) return finish({ outcome: "deny", code: identityError, reason: "Execution identity or client scope is invalid." });
      argsHash = hashArguments(args);
      if (!manifest.tools?.includes(tool.id)) {
        policyRefs.push("manifest:tools");
        return finish({ outcome: "deny", code: "TOOL_NOT_ALLOWED", reason: `Tool "${tool.id}" is not allowed by ${manifest.seat}.` });
      }
      if (isSystemRefusal(manifest.seat, tool.action)) {
        policyRefs.push(`system:refusal:${manifest.seat}:${tool.action}`);
        return finish({ outcome: "deny", code: "SYSTEM_REFUSAL", reason: `Action "${tool.action}" is blocked by system policy.` });
      }
      if (manifest.refuses?.includes(tool.action)) {
        policyRefs.push(`manifest:refusal:${tool.action}`);
        return finish({ outcome: "deny", code: "MANIFEST_REFUSAL", reason: `Action "${tool.action}" is refused by ${manifest.seat}.` });
      }
      const boundaryError = boundaryFailure(manifest, tool);
      if (boundaryError) {
        policyRefs.push(boundaryError === "LOCATION_NOT_ALLOWED" ? "manifest:location" : "manifest:memory");
        return finish({ outcome: "deny", code: boundaryError, reason: "The tool is outside the manifest execution boundary." });
      }

      const systemGate = systemGateFor(tool.action);
      const manifestGate = normalizeGate(manifest.gate);
      let toolGate = typeof tool.requiresApproval === "function" ? await tool.requiresApproval(args, request) : tool.requiresApproval;
      if (toolGate === true) {
        toolGate = { approver: tool.approver || "studio_professional", actions: [tool.action], expiresInSeconds: tool.approvalExpiresInSeconds || 900 };
      }
      const gate = systemGate || (toolGate && typeof toolGate === "object" ? toolGate : null) || (gateMatches(manifestGate, tool.action) ? manifestGate : null);
      if (!gate) return finish({ outcome: "allow" });

      policyRefs.push(systemGate ? `system:gate:${tool.action}` : (gate.source || `tool:gate:${tool.id}`));
      const binding = { runId: run.runId, seat: run.seat, clientId: run.clientId, toolId: tool.id, action: tool.action, argsHash };
      const consumed = await approvalStore.consumeApproved(binding, { approvalId: approvalReceipt?.id || null });
      if (consumed) return finish({ outcome: "allow", approvalId: consumed.id });
      const approval = await approvalStore.request(binding, {
        requiredApprover: gate.approver || "studio_professional",
        requester: run.actor || run.seat,
        expiresInSeconds: gate.expiresInSeconds || 900,
      });
      return finish({ outcome: "approval_required", approval: publicApproval(approval) });
    } catch {
      policyRefs.push("system:fail_closed");
      return finish({ outcome: "deny", code: "POLICY_EVALUATION_FAILED", reason: "Policy evaluation failed closed." });
    }
  };
}

export const authorizeToolCall = createGuardrails();
export { systemRefusalsFor };
