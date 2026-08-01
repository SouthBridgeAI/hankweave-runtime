/**
 * Error Tracking - Privacy-Preserving Exception Capture via PostHog
 *
 * Uses PostHog's built-in error tracking instead of a separate tool (Sentry).
 * Captures crash reports with a privacy-scrubbing layer that strips
 * sensitive data (file paths, prompts, env vars, etc.) following the
 * same privacy principles as the telemetry system.
 *
 * Errors appear in PostHog's Error Tracking dashboard alongside
 * product analytics and LLM analytics - single pane of glass.
 */

import type { PostHog } from "posthog-node";

// =============================================================================
// Privacy Scrubbing
// =============================================================================

// Patterns to scrub from error messages and stack traces
const SENSITIVE_PATTERNS = [
  // Home directory paths
  /\/Users\/[^/\s]+/g,
  /\/home\/[^/\s]+/g,
  /C:\\Users\\[^\\\s]+/g,
  // API keys and tokens
  /(?:sk-|key-|token-|Bearer\s+)[a-zA-Z0-9_-]{10,}/g,
  // Environment variable values (KEY=VALUE patterns)
  /(?:API_KEY|SECRET|TOKEN|PASSWORD|ANTHROPIC_API_KEY|OPENAI_API_KEY|GEMINI_API_KEY)=\S+/gi,
  // Absolute paths that might reveal project structure
  /\/[^\s:]+\.(json|md|txt|yaml|yml)/g,
];

/**
 * Scrub sensitive data from a string.
 */
function scrubString(input: string): string {
  let result = input;
  for (const pattern of SENSITIVE_PATTERNS) {
    // Reset regex state since we use global flag
    pattern.lastIndex = 0;
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

/**
 * Scrub an Error object in place. Mutates .message and .stack
 * to remove sensitive data while preserving the error's identity,
 * prototype chain, and internal state (important for PostHog's
 * ErrorCoercer and stack frame parser).
 */
function scrubError(error: Error): Error {
  // Scrub message by overwriting the property
  // (Error.message is a writable data property)
  try {
    error.message = scrubString(error.message);
  } catch {
    // In rare cases message might not be writable (frozen objects);
    // fall back to creating a new Error if needed
    const fallback = new Error(scrubString(error.message));
    fallback.name = error.name;
    if (error.stack) {
      fallback.stack = scrubString(error.stack);
    }
    return fallback;
  }

  // Scrub stack trace in place
  if (error.stack) {
    error.stack = scrubString(error.stack);
  }

  return error;
}

// =============================================================================
// Error Tracking via PostHog
// =============================================================================

/** Reference to the PostHog client, set during init */
let posthogClient: PostHog | null = null;
let clientId: string | null = null;

/**
 * Initialize error tracking with a PostHog client instance.
 * Called from the TelemetryClient after it creates the PostHog instance.
 *
 * @param client - The PostHog Node client
 * @param distinctId - The anonymous client ID
 */
export function initErrorTracking(client: PostHog, distinctId: string): void {
  posthogClient = client;
  clientId = distinctId;
}

/**
 * Context for error captures, providing correlation data and
 * failure metadata for PostHog's Error Tracking dashboard.
 */
export interface ErrorCaptureContext {
  // Failure metadata
  codonStatus?: string;
  runStatus?: string;
  errorCode?: string;
  exitCode?: number;
  failureType?: string;

  // Correlation properties (for cross-referencing with telemetry events)
  runIdHash?: string;
  codonIdHash?: string;
  codonPosition?: number;
  model?: string;
  hankweaveVersion?: string;
}

/**
 * Capture an error with optional context.
 * Scrubs sensitive data before sending to PostHog.
 *
 * Uses PostHog's $exception event format for the Error Tracking dashboard.
 *
 * @param error - The error to capture. Pass the ORIGINAL caught error when
 *   possible — its stack trace points to where the failure actually happened.
 *   Avoid creating `new Error(message)` at the capture site, as that produces
 *   a useless stack trace pointing to the capturer, not the cause.
 * @param context - Optional metadata for filtering and correlation in PostHog.
 */
export function captureError(error: Error, context?: ErrorCaptureContext): void {
  if (!posthogClient || !clientId) return;

  try {
    const scrubbedError = scrubError(error);

    // Build properties for PostHog's error tracking
    const properties: Record<string, unknown> = {};

    // Add safe context as tags
    if (context) {
      // Failure metadata
      if (context.codonStatus) properties.codon_status = context.codonStatus;
      if (context.runStatus) properties.run_status = context.runStatus;
      if (context.errorCode) properties.error_code = context.errorCode;
      if (context.exitCode !== undefined) properties.exit_code = context.exitCode;
      if (context.failureType) properties.failure_type = context.failureType;

      // Correlation properties
      if (context.runIdHash) properties.run_id_hash = context.runIdHash;
      if (context.codonIdHash) properties.codon_id_hash = context.codonIdHash;
      if (context.codonPosition !== undefined) properties.codon_position = context.codonPosition;
      if (context.model) properties.model = context.model;
      if (context.hankweaveVersion) properties.hankweave_version = context.hankweaveVersion;
    }

    posthogClient.captureException(scrubbedError, clientId, properties);
  } catch {
    // Silent fail - error tracking should never cause errors itself
  }
}

/**
 * Flush pending error events.
 * Call during shutdown.
 */
export async function flushErrorTracking(timeoutMs = 2000): Promise<void> {
  if (!posthogClient) return;
  try {
    await Promise.race([
      posthogClient.flush(),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
  } catch {
    // Silent fail
  }
}
