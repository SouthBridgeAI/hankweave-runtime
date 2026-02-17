/**
 * Telemetry Module - Barrel Exports
 *
 * Privacy-preserving telemetry for Hankweave.
 * See: intermediates/40-telemetry/TELEMETRY_SPEC.md
 */

// Error tracking (via PostHog)
export {
  captureError,
  type ErrorCaptureContext,
  flushErrorTracking,
  initErrorTracking,
} from "./error-tracking.js";
// First-run notice
export { showFirstRunNotice } from "./first-run-notice.js";
// Privacy transformations
export {
  sha256,
  toPrivacyPreservingCodon,
  toPrivacyPreservingCodonExecution,
  toPrivacyPreservingHank,
  toPrivacyPreservingLoop,
  toPrivacyPreservingRun,
} from "./privacy-maps.js";
// Client
export { TelemetryClient } from "./telemetry-client.js";
// Collector
export { TelemetryCollector } from "./telemetry-collector.js";
export type { ResolvedTelemetryConfig } from "./telemetry-config.js";
// Configuration
export { isCI, resolveTelemetryConfig } from "./telemetry-config.js";
// Identity
export { getOrCreateClientId, isFirstRun } from "./telemetry-identity.js";
export type {
  PrivacyPreservingCodon,
  PrivacyPreservingCodonExecution,
  PrivacyPreservingHank,
  PrivacyPreservingLoop,
  PrivacyPreservingProvider,
  PrivacyPreservingRun,
  PrivacyPreservingTokenUsage,
  TelemetryConfig,
  TelemetryEventName,
  TelemetryIdentity,
  TelemetryUserProperties,
} from "./telemetry-types.js";
// Types
export {
  TELEMETRY_SCHEMA_VERSION,
  telemetryConfigSchema,
} from "./telemetry-types.js";
