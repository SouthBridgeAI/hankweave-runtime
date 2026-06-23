import type { FailureReason } from "./types/types.js";

/**
 * Pure decision core of the runtime's failure policy
 * (HankweaveRuntime.resolveFailurePolicy delegates here; extracted for unit
 * testing, mirroring shouldExtendCodon in codon-runner.ts).
 *
 * - abort: retriable errors leave the server active for manual retry,
 *   permanent ones shut the run down.
 * - retry: retriable errors retry until maxAttempts is exhausted; permanent
 *   errors shut down immediately.
 * - ignore: always continue to the next codon.
 */
export function resolveFailureAction(params: {
  onFailure: "abort" | "retry" | "ignore";
  retriable: boolean;
  attempts: number;
  maxAttempts: number;
}): "shutdown" | "stay-active" | "retry" | "continue" {
  switch (params.onFailure) {
    case "abort":
      return params.retriable ? "stay-active" : "shutdown";
    case "retry":
      if (!params.retriable) return "shutdown";
      return params.attempts < params.maxAttempts ? "retry" : "shutdown";
    case "ignore":
      return "continue";
  }
}

/**
 * Classify API error text into a FailureReason with a retriability verdict.
 *
 * This is the single source of truth for deciding whether an API-level error
 * is transient (worth retrying under onFailure: "retry") or permanent.
 * Both the runtime's result-message handling and CodonRunner's extension
 * logic must use this — divergent heuristics in those two places previously
 * caused transient socket drops to abort runs that were configured to retry
 *
 * Classification policy:
 * - Billing/credit/quota and auth errors are permanent: retrying burns
 *   attempts on a hopeless request.
 * - Invalid-request (400) errors are permanent: the same request will fail
 *   the same way.
 * - Transport faults (socket closed/reset, connection errors), timeouts,
 *   rate limits, and server-side errors (5xx, overloaded) are transient.
 * - Unrecognized error text defaults to RETRIABLE: retries are bounded by
 *   retryConfig.maxAttempts, so a wrong "retriable" costs one extra attempt,
 *   while a wrong "non-retriable" kills the whole run. This default is gated on
 *   `opts.sessionEstablished`: when the caller knows no session was ever
 *   established (the process failed before its first message), unrecognized text
 *   is a local setup failure and is classified NON-retriable instead. The known
 *   transient/permanent patterns above are unaffected by the gate.
 */
export function classifyApiErrorText(
  text: string,
  opts?: { sessionEstablished?: boolean },
): FailureReason {
  const errorText = typeof text === "string" && text.length > 0 ? text : "Unknown API error";
  const lower = errorText.toLowerCase();
  // Default true: existing single-arg callers keep the original retriable
  // fallback. Only callers that can prove non-establishment pass false.
  const sessionEstablished = opts?.sessionEstablished ?? true;

  // Status codes are matched on word boundaries so they don't false-match
  // inside larger numbers (e.g. "after 2400s" must not match 400).
  const hasCode = (code: string): boolean => new RegExp(`\\b${code}\\b`).test(lower);

  // --- Permanent failures (checked first: most specific signals) ---

  // Explicit rate-limit signals win over the broad billing/quota match below.
  // A 429/rate_limit_error that also mentions a per-minute "quota" (e.g.
  // "429 rate_limit_error: quota exceeded, retry after 60s") is a TRANSIENT rate
  // limit, not exhausted billing. Only the WORDED forms short-circuit here; a
  // bare "429" stays ambiguous and is resolved after the billing check, because
  // OpenAI returns 429 for permanent insufficient_quota too.
  const hasExplicitRateLimit =
    lower.includes("rate limit") || lower.includes("rate_limit") || lower.includes("rate-limit");
  if (hasExplicitRateLimit) {
    return {
      type: "rate-limit",
      retriable: true,
      message: `API rate limit: ${errorText}`,
    };
  }

  // Billing/credit/quota AND provider usage-limit caps are permanent: retrying
  // burns attempts on a hopeless request. The usage-limit phrasings come from
  // the non-Anthropic shims we drive (e.g. pi/opencode surface
  // `GoUsageLimitError`, `FreeUsageLimitError`, "Monthly usage limit reached",
  // "out of budget", "available balance"). Without these, our default-retriable
  // policy would keep retrying a depleted plan/balance until maxAttempts.
  const isBilling =
    lower.includes("credit") ||
    lower.includes("billing") ||
    lower.includes("insufficient") ||
    lower.includes("quota") ||
    lower.includes("available balance") ||
    lower.includes("out of budget") ||
    // "usage limit" (spaced) and "usagelimit" (camelCase error names lowercased)
    /usage\s?limit/.test(lower);
  if (isBilling) {
    return {
      type: "api-error",
      retriable: false,
      message: `API billing/usage error: ${errorText}`,
    };
  }

  // Checked before the numeric status-code branches below (auth's 401/403,
  // invalid-request's 400). A message that says "timeout"/"timed out" is a
  // transient timeout even when it embeds a standalone duration like
  // "Request timed out after 400 seconds" — that bare "400" would otherwise
  // word-match hasCode("400") and be misclassified as a permanent invalid
  // request (and "401"/"403" durations as auth), bypassing onFailure:"retry".
  const isTimeout = lower.includes("timeout") || lower.includes("timed out");
  if (isTimeout) {
    return {
      type: "timeout",
      retriable: true,
      message: errorText,
    };
  }

  const isAuth =
    hasCode("401") ||
    hasCode("403") ||
    lower.includes("authentication") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("api key") ||
    lower.includes("oauth");
  if (isAuth) {
    return {
      type: "api-error",
      retriable: false,
      message: `API auth error: ${errorText}`,
    };
  }

  const isInvalidRequest =
    lower.includes("invalid_request") || lower.includes("invalid request") || hasCode("400");
  if (isInvalidRequest) {
    return {
      type: "api-error",
      retriable: false,
      message: `API invalid request: ${errorText}`,
    };
  }

  // --- Transient failures ---

  // Bare "429" with no worded rate-limit signal and no billing/quota text above:
  // a plain "Too Many Requests" that is transient. (Worded rate limits already
  // short-circuited before the billing check; quota-429 was caught as billing.)
  if (hasCode("429")) {
    return {
      type: "rate-limit",
      retriable: true,
      message: `API rate limit: ${errorText}`,
    };
  }

  // Transport faults (socket/connection drops, resets, stream terminations) are
  // transient. Matched explicitly — rather than via the fallback below — so they
  // stay retriable even when no session was established (see the gated fallback).
  const isTransport =
    lower.includes("socket") ||
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("epipe") ||
    lower.includes("etimedout") ||
    lower.includes("connection reset") ||
    lower.includes("connection closed") ||
    lower.includes("connection error") ||
    (lower.includes("stream") && lower.includes("terminated")) ||
    lower.includes("network");
  if (isTransport) {
    return {
      type: "api-error",
      retriable: true,
      message: `API transport error: ${errorText}`,
    };
  }

  // Server-side 5xx / overloaded errors are transient. Also matched explicitly so
  // they survive the session-established gate on the fallback.
  const isServerError =
    hasCode("500") ||
    hasCode("502") ||
    hasCode("503") ||
    hasCode("504") ||
    hasCode("529") ||
    lower.includes("overloaded") ||
    lower.includes("internal server error") ||
    lower.includes("bad gateway") ||
    lower.includes("service unavailable");
  if (isServerError) {
    return {
      type: "api-error",
      retriable: true,
      message: `API server error: ${errorText}`,
    };
  }

  // Unrecognized error text. Default is RETRIABLE (bounded by maxAttempts), BUT
  // gated on session establishment: if no session was ever established
  // (sessionEstablished === false), the process died before exchanging its first
  // message and the text matched none of the known transient API signals above —
  // that is a local setup/process failure (bad executable, spawn error, bad cwd,
  // shim resume-resolution failure), which retrying cannot fix. Classify it
  // NON-retriable. When a session WAS established (default), keep the retriable
  // policy: a mid-conversation crash with unfamiliar text is plausibly transient.
  if (sessionEstablished === false) {
    return {
      type: "api-error",
      retriable: false,
      message: `Local setup/process error (no session established): ${errorText}`,
    };
  }
  return {
    type: "api-error",
    retriable: true,
    message: `API error in result: ${errorText}`,
  };
}

/**
 * Synthesize a failure reason for a codon that ended in a FAILED state without
 * any classified reason of its own (no error result message, no transient-crash
 * classification from the runner).
 *
 * This is the single convergence point for every process manager when a process
 * exits without reporting a usable outcome:
 *  - An early/pre-init shim exit on an API error returns a non-zero code with no
 *    result message (gemini shim.ts:593 `!systemEmitted`; pi index.ts:452;
 *    opencode shim.ts:462/486 and binary/arg-resolution failures).
 *  - The Claude Agent SDK or any child process can crash without a terminal
 *    result.
 *
 * Retriability is gated on session establishment (`sessionEstablished`):
 *  - established then exited with no result → plausibly transient, RETRIABLE
 *    (bounded by retryConfig.maxAttempts), mirroring classifyApiErrorText's
 *    policy for unrecognized errors.
 *  - never established (the process exited before its first message) → a local
 *    setup/binary/resume-resolution failure that retrying cannot fix →
 *    NON-retriable. Defaults to true so callers that don't supply the signal
 *    keep the original retriable behavior.
 *
 * Returns undefined (no synthesis — preserve the existing non-retriable default)
 * when the failure is intentional or owned by another mechanism:
 *  - force-stop: the user asked to stop; retrying would fight that intent.
 *  - context-exceeded: the loop/termination logic owns this outcome, not retry.
 */
export function synthesizeMissingFailureReason(params: {
  isForceStopping: boolean;
  isContextExceeded: boolean;
  exitCode: number;
  sessionEstablished?: boolean;
}): FailureReason | undefined {
  if (params.isForceStopping) return undefined;
  if (params.isContextExceeded) return undefined;

  const sessionEstablished = params.sessionEstablished ?? true;
  return {
    type: "api-error",
    retriable: sessionEstablished !== false,
    message:
      sessionEstablished === false
        ? `Codon process exited before establishing a session (exit code ${params.exitCode})`
        : `Codon process exited without a result message (exit code ${params.exitCode})`,
  };
}
