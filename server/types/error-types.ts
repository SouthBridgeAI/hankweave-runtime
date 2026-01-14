/**
 * Error severity levels for Hankweave server.
 */
export enum ErrorSeverity {
  /** Fatal error - requires server shutdown */
  FATAL = "fatal",
  /** Codon error - current codon fails but server continues */
  CODON = "codon",
  /** Operation error - single operation fails */
  OPERATION = "operation",
  /** Warning - logged but no action taken */
  WARNING = "warning",
}

/**
 * Custom error classes for different severity levels.
 */
export class HankweaveError extends Error {
  constructor(
    message: string,
    public readonly severity: ErrorSeverity,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HankweaveError";
  }
}

export class FatalError extends HankweaveError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, ErrorSeverity.FATAL, "FATAL_ERROR", context);
    this.name = "FatalError";
  }
}

export class CodonError extends HankweaveError {
  constructor(message: string, codonId: string, context?: Record<string, unknown>) {
    super(message, ErrorSeverity.CODON, "CODON_ERROR", { ...context, codonId });
    this.name = "CodonError";
  }
}

export class OperationError extends HankweaveError {
  constructor(message: string, operation: string, context?: Record<string, unknown>) {
    super(message, ErrorSeverity.OPERATION, "OPERATION_ERROR", {
      ...context,
      operation,
    });
    this.name = "OperationError";
  }
}

export class APITimeoutError extends HankweaveError {
  constructor(codonId: string, context?: Record<string, unknown>) {
    super("Claude API request timed out", ErrorSeverity.CODON, "API_TIMEOUT_ERROR", {
      ...context,
      codonId,
    });
    this.name = "APITimeoutError";
  }
}

export class ContextExceededError extends HankweaveError {
  constructor(
    message: string,
    public readonly originalError: unknown,
    context?: Record<string, unknown>,
  ) {
    super(message, ErrorSeverity.CODON, "CONTEXT_EXCEEDED_ERROR", context);
    this.name = "ContextExceededError";
  }
}

export class CommandError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "CommandError";
  }
}
