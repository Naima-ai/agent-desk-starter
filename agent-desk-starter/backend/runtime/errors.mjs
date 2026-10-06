export class RuntimeError extends Error {
  constructor(code, message, { status = "failed", retryable = false, details = null } = {}) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }
}

export class RuntimeRefusalError extends RuntimeError {
  constructor(code, message, details = null) {
    super(code, message, { status: "refused", retryable: false, details });
    this.name = "RuntimeRefusalError";
  }
}

export class RuntimeApprovalRequiredError extends RuntimeError {
  constructor(approval) {
    super("APPROVAL_REQUIRED", "Human approval is required before this action can run.", {
      status: "awaiting_approval",
      retryable: false,
      details: approval,
    });
    this.name = "RuntimeApprovalRequiredError";
    this.approval = approval;
  }
}

export class RuntimeTimeoutError extends RuntimeError {
  constructor(message = "The agent run exceeded its deadline.") {
    super("RUN_TIMEOUT", message, { status: "failed", retryable: true });
    this.name = "RuntimeTimeoutError";
  }
}

