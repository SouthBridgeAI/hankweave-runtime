/**
 * Error severity levels for Tadpole server.
 */
export enum ErrorSeverity {
  /** Fatal error - requires server shutdown */
  FATAL = "fatal",
  /** Phase error - current phase fails but server continues */
  PHASE = "phase",
  /** Operation error - single operation fails */
  OPERATION = "operation",
  /** Warning - logged but no action taken */
  WARNING = "warning",
}

/**
 * Custom error classes for different severity levels.
 */
export class TadpoleError extends Error {
  constructor(
    message: string,
    public readonly severity: ErrorSeverity,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TadpoleError";
  }
}

export class FatalError extends TadpoleError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, ErrorSeverity.FATAL, "FATAL_ERROR", context);
    this.name = "FatalError";
  }
}

export class PhaseError extends TadpoleError {
  constructor(message: string, phaseId: string, context?: Record<string, unknown>) {
    super(message, ErrorSeverity.PHASE, "PHASE_ERROR", { ...context, phaseId });
    this.name = "PhaseError";
  }
}

export class OperationError extends TadpoleError {
  constructor(message: string, operation: string, context?: Record<string, unknown>) {
    super(message, ErrorSeverity.OPERATION, "OPERATION_ERROR", {
      ...context,
      operation,
    });
    this.name = "OperationError";
  }
}

export class APITimeoutError extends TadpoleError {
  constructor(phaseId: string, context?: Record<string, unknown>) {
    super("Claude API request timed out", ErrorSeverity.PHASE, "API_TIMEOUT_ERROR", {
      ...context,
      phaseId,
    });
    this.name = "APITimeoutError";
  }
}
