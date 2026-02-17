/**
 * Telemetry Client - PostHog Integration
 *
 * Handles sending telemetry events to PostHog.
 * Fire-and-forget with 2s timeout. Silent fail on all errors.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PostHog } from "posthog-node";
import type { ResolvedTelemetryConfig } from "./telemetry-config.js";
import type { TelemetryEventName, TelemetryUserProperties } from "./telemetry-types.js";

// =============================================================================
// Constants
// =============================================================================

const TELEMETRY_TIMEOUT_MS = 2000;

/**
 * PostHog project API key.
 * This is the *public* write-only key used to send events - safe to embed in source code.
 * Self-hosted PostHog instance: https://hw-telemetry.southbridge.ai
 *
 * Override via POSTHOG_API_KEY env var.
 */
const POSTHOG_API_KEY = "phc_hDo9EY9g5eB18EYqnR2etTcEKXId7Rw971hoKQDxo5A";

// =============================================================================
// Telemetry Client
// =============================================================================

/** Path to debug JSONL file */
const DEBUG_JSONL_PATH = path.join(
  process.env.HANKWEAVE_CACHE_DIR || path.join(os.homedir(), ".hankweave"),
  "telemetry-debug.jsonl",
);

export class TelemetryClient {
  private posthog: PostHog | null = null;
  private config: ResolvedTelemetryConfig;
  private clientId: string;
  private userProperties: TelemetryUserProperties;

  constructor(
    config: ResolvedTelemetryConfig,
    clientId: string,
    userProperties: TelemetryUserProperties,
  ) {
    this.config = config;
    this.clientId = clientId;
    this.userProperties = userProperties;

    if (config.enabled && !config.debug) {
      try {
        this.posthog = new PostHog(process.env.POSTHOG_API_KEY || POSTHOG_API_KEY, {
          host: config.endpoint,
          flushAt: 1, // Send immediately (we batch ourselves)
          flushInterval: 0, // Don't auto-flush
          // Auto-capture uncaught exceptions and unhandled rejections with real
          // stack traces. This supplements manual captureException() calls and
          // catches errors that bypass our custom error handling.
          enableExceptionAutocapture: true,
        });
      } catch {
        // Silent fail - PostHog client creation failed
        this.posthog = null;
      }
    }
  }

  /**
   * Get the underlying PostHog client instance.
   * Used by error tracking to call captureException on the same client.
   */
  getPostHogClient(): PostHog | null {
    return this.posthog;
  }

  /**
   * Get the anonymous client ID.
   */
  getClientId(): string {
    return this.clientId;
  }

  /**
   * Send a telemetry event.
   * Fire-and-forget with timeout. Never throws.
   */
  async capture(event: TelemetryEventName, properties: Record<string, unknown>): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    const eventPayload = {
      distinctId: this.clientId,
      event,
      properties: {
        ...properties,
        schema_version: 1,
        $set: this.userProperties,
      },
      timestamp: new Date(),
    };

    // Debug mode: print to console + write to JSONL file
    if (this.config.debug) {
      console.log(`[TELEMETRY DEBUG] ${event}:`, JSON.stringify(eventPayload, null, 2));
      this.writeDebugJsonl(eventPayload);
      return;
    }

    if (!this.posthog) {
      return;
    }

    try {
      this.posthog.capture(eventPayload);

      // Flush with timeout
      await Promise.race([
        this.posthog.flush(),
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error("timeout")), TELEMETRY_TIMEOUT_MS),
        ),
      ]);
    } catch {
      // Silent fail - telemetry should never impact user experience
    }
  }

  /**
   * Send multiple events at once.
   * Fire-and-forget with timeout. Never throws.
   */
  async captureMany(
    events: Array<{
      event: TelemetryEventName;
      properties: Record<string, unknown>;
    }>,
  ): Promise<void> {
    if (!this.config.enabled || events.length === 0) {
      return;
    }

    for (const { event, properties } of events) {
      const eventPayload = {
        distinctId: this.clientId,
        event,
        properties: {
          ...properties,
          schema_version: 1,
          $set: this.userProperties,
        },
        timestamp: new Date(),
      };

      if (this.config.debug) {
        console.log(`[TELEMETRY DEBUG] ${event}:`, JSON.stringify(eventPayload, null, 2));
        this.writeDebugJsonl(eventPayload);
        continue;
      }

      if (this.posthog) {
        try {
          this.posthog.capture(eventPayload);
        } catch {
          // Silent fail per event
        }
      }
    }

    // Single flush for all events
    if (!this.config.debug && this.posthog) {
      try {
        await Promise.race([
          this.posthog.flush(),
          new Promise((_resolve, reject) =>
            setTimeout(() => reject(new Error("timeout")), TELEMETRY_TIMEOUT_MS),
          ),
        ]);
      } catch {
        // Silent fail
      }
    }
  }

  /**
   * Write a payload to the debug JSONL file.
   * Appends one JSON line per event for easy inspection.
   */
  private writeDebugJsonl(payload: Record<string, unknown>): void {
    try {
      const dir = path.dirname(DEBUG_JSONL_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.appendFileSync(DEBUG_JSONL_PATH, `${JSON.stringify(payload)}\n`);
    } catch {
      // Silent fail
    }
  }

  /**
   * Shutdown the client. Call at process exit.
   */
  async shutdown(): Promise<void> {
    if (this.posthog) {
      try {
        await Promise.race([
          this.posthog.shutdown(),
          new Promise((_resolve, reject) =>
            setTimeout(() => reject(new Error("timeout")), TELEMETRY_TIMEOUT_MS),
          ),
        ]);
      } catch {
        // Silent fail
      }
    }
  }
}
