/**
 * Telemetry Configuration Resolution
 *
 * Resolves telemetry configuration from multiple sources with precedence:
 * 1. DO_NOT_TRACK=1 → disabled (universal standard)
 * 2. HANKWEAVE_TELEMETRY=0 → disabled (explicit disable)
 * 3. CI detected → disabled (auto-disable)
 * 4. Config telemetry.enabled=false → disabled
 * 5. Default → ENABLED
 */

import type { TelemetryConfig } from "./telemetry-types.js";

// =============================================================================
// CI Detection
// =============================================================================

/** Value-based CI env vars (must be "true" or "1") */
const CI_VALUE_VARS = ["CI"] as const;

/** Existence-based CI env vars (presence is sufficient) */
const CI_EXISTENCE_VARS = [
  "GITHUB_ACTIONS",
  "TRAVIS",
  "CIRCLECI",
  "GITLAB_CI",
  "JENKINS_URL",
  "BUILDKITE",
  "DRONE",
  "CI_NAME",
  "CODEBUILD_BUILD_ID",
  "TF_BUILD",
] as const;

/**
 * Detect if we're running in a CI environment.
 */
export function isCI(): boolean {
  // Value-based checks
  for (const varName of CI_VALUE_VARS) {
    const val = process.env[varName];
    if (val === "true" || val === "1") {
      return true;
    }
  }

  // Existence-based checks
  for (const varName of CI_EXISTENCE_VARS) {
    if (process.env[varName] !== undefined) {
      return true;
    }
  }

  return false;
}

// =============================================================================
// Configuration Resolution
// =============================================================================

export interface ResolvedTelemetryConfig {
  /** Whether telemetry is enabled */
  enabled: boolean;

  /** PostHog endpoint to send events to */
  endpoint: string;

  /** Debug mode: print payloads to console instead of sending */
  debug: boolean;

  /** Why telemetry is disabled (if applicable) */
  disabledReason?: string;
}

/**
 * Default PostHog endpoint.
 * Self-hosted instance on DigitalOcean droplet.
 *
 * Override via HANKWEAVE_TELEMETRY_ENDPOINT env var or config file.
 */
const DEFAULT_POSTHOG_HOST = "https://hw-telemetry.southbridge.ai";

/**
 * Resolve telemetry configuration from all sources.
 *
 * @param fileConfig - Configuration from hankweave.json telemetry section
 * @returns Resolved telemetry configuration
 */
export function resolveTelemetryConfig(fileConfig?: TelemetryConfig): ResolvedTelemetryConfig {
  // Priority 1: DO_NOT_TRACK=1 (universal standard)
  if (process.env.DO_NOT_TRACK === "1") {
    return {
      enabled: false,
      endpoint: DEFAULT_POSTHOG_HOST,
      debug: false,
      disabledReason: "DO_NOT_TRACK=1",
    };
  }

  // Priority 2: HANKWEAVE_TELEMETRY=0 or HANKWEAVE_TELEMETRY=false
  const telemetryEnv = process.env.HANKWEAVE_TELEMETRY;
  if (telemetryEnv === "0" || telemetryEnv === "false") {
    return {
      enabled: false,
      endpoint: DEFAULT_POSTHOG_HOST,
      debug: false,
      disabledReason: "HANKWEAVE_TELEMETRY=0",
    };
  }

  // Priority 3: CI detection (cannot be overridden in V1)
  if (isCI()) {
    return {
      enabled: false,
      endpoint: DEFAULT_POSTHOG_HOST,
      debug: false,
      disabledReason: "CI environment detected",
    };
  }

  // Priority 4: Config file
  if (fileConfig?.enabled === false) {
    return {
      enabled: false,
      endpoint: fileConfig.endpoint || DEFAULT_POSTHOG_HOST,
      debug: fileConfig.debug || false,
      disabledReason: "Disabled in config file",
    };
  }

  // Resolve endpoint from env or config
  const endpoint =
    process.env.HANKWEAVE_TELEMETRY_ENDPOINT || fileConfig?.endpoint || DEFAULT_POSTHOG_HOST;

  // Resolve debug from env or config
  const debug = process.env.HANKWEAVE_TELEMETRY_DEBUG === "1" || fileConfig?.debug || false;

  // Default: ENABLED
  return {
    enabled: true,
    endpoint,
    debug,
  };
}
