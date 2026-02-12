import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isCI, resolveTelemetryConfig } from "../../server/telemetry/telemetry-config.js";
import type { TelemetryConfig } from "../../server/telemetry/telemetry-types.js";
import { captureEnv, restoreEnv } from "../utils/env-test-helpers.js";

const DEFAULT_ENDPOINT = "https://hw-telemetry.southbridge.ai";

/**
 * All environment variables that affect telemetry config resolution.
 * Cleared before each test for a clean baseline.
 */
const TELEMETRY_ENV_VARS = [
  "DO_NOT_TRACK",
  "HANKWEAVE_TELEMETRY",
  "HANKWEAVE_TELEMETRY_ENDPOINT",
  "HANKWEAVE_TELEMETRY_DEBUG",
  "CI",
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

describe("resolveTelemetryConfig", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = captureEnv();
    for (const key of TELEMETRY_ENV_VARS) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    restoreEnv(savedEnv);
  });

  // ---------------------------------------------------------------------------
  // Default behavior
  // ---------------------------------------------------------------------------

  describe("defaults", () => {
    test("enabled by default with no env vars and no file config", () => {
      const config = resolveTelemetryConfig();
      expect(config.enabled).toBe(true);
      expect(config.endpoint).toBe(DEFAULT_ENDPOINT);
      expect(config.debug).toBe(false);
      expect(config.disabledReason).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Priority 1: DO_NOT_TRACK
  // ---------------------------------------------------------------------------

  describe("DO_NOT_TRACK", () => {
    test("DO_NOT_TRACK=1 disables telemetry", () => {
      process.env.DO_NOT_TRACK = "1";
      const config = resolveTelemetryConfig();
      expect(config.enabled).toBe(false);
      expect(config.disabledReason).toBe("DO_NOT_TRACK=1");
    });

    test("DO_NOT_TRACK=1 takes precedence over file config enabling telemetry", () => {
      process.env.DO_NOT_TRACK = "1";
      const config = resolveTelemetryConfig({ enabled: true });
      expect(config.enabled).toBe(false);
    });

    test("DO_NOT_TRACK=0 does not disable telemetry", () => {
      process.env.DO_NOT_TRACK = "0";
      const config = resolveTelemetryConfig();
      expect(config.enabled).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Priority 2: HANKWEAVE_TELEMETRY
  // ---------------------------------------------------------------------------

  describe("HANKWEAVE_TELEMETRY", () => {
    test("HANKWEAVE_TELEMETRY=0 disables telemetry", () => {
      process.env.HANKWEAVE_TELEMETRY = "0";
      const config = resolveTelemetryConfig();
      expect(config.enabled).toBe(false);
      expect(config.disabledReason).toBe("HANKWEAVE_TELEMETRY=0");
    });

    test("HANKWEAVE_TELEMETRY=false disables telemetry", () => {
      process.env.HANKWEAVE_TELEMETRY = "false";
      const config = resolveTelemetryConfig();
      expect(config.enabled).toBe(false);
    });

    test("HANKWEAVE_TELEMETRY=1 does not disable telemetry", () => {
      process.env.HANKWEAVE_TELEMETRY = "1";
      const config = resolveTelemetryConfig();
      expect(config.enabled).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Priority 3: CI detection
  // ---------------------------------------------------------------------------

  describe("CI detection", () => {
    test("CI=true disables telemetry", () => {
      process.env.CI = "true";
      const config = resolveTelemetryConfig();
      expect(config.enabled).toBe(false);
      expect(config.disabledReason).toBe("CI environment detected");
    });

    test("CI=1 disables telemetry", () => {
      process.env.CI = "1";
      const config = resolveTelemetryConfig();
      expect(config.enabled).toBe(false);
    });

    test("GITHUB_ACTIONS presence disables telemetry", () => {
      process.env.GITHUB_ACTIONS = "true";
      const config = resolveTelemetryConfig();
      expect(config.enabled).toBe(false);
    });

    test("BUILDKITE presence disables telemetry", () => {
      process.env.BUILDKITE = "true";
      const config = resolveTelemetryConfig();
      expect(config.enabled).toBe(false);
    });
  });

  describe("isCI", () => {
    test("returns false with no CI env vars", () => {
      expect(isCI()).toBe(false);
    });

    test("returns true for each existence-based CI var", () => {
      const existenceVars = [
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
      ];
      for (const varName of existenceVars) {
        process.env[varName] = "anything";
        expect(isCI()).toBe(true);
        delete process.env[varName];
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Priority 4: File config
  // ---------------------------------------------------------------------------

  describe("file config", () => {
    test("fileConfig.enabled=false disables telemetry", () => {
      const config = resolveTelemetryConfig({ enabled: false });
      expect(config.enabled).toBe(false);
      expect(config.disabledReason).toBe("Disabled in config file");
    });

    test("fileConfig.enabled=true keeps telemetry enabled", () => {
      const config = resolveTelemetryConfig({ enabled: true });
      expect(config.enabled).toBe(true);
    });

    test("fileConfig.endpoint is used when provided", () => {
      const config = resolveTelemetryConfig({
        endpoint: "https://custom.example.com",
      });
      expect(config.endpoint).toBe("https://custom.example.com");
    });

    test("fileConfig.debug is used when provided", () => {
      const config = resolveTelemetryConfig({ debug: true });
      expect(config.debug).toBe(true);
    });

    test("fileConfig.endpoint is used even when disabled", () => {
      const config = resolveTelemetryConfig({
        enabled: false,
        endpoint: "https://custom.example.com",
      });
      expect(config.endpoint).toBe("https://custom.example.com");
    });
  });

  // ---------------------------------------------------------------------------
  // Endpoint and debug resolution from env vars
  // ---------------------------------------------------------------------------

  describe("endpoint and debug from env", () => {
    test("HANKWEAVE_TELEMETRY_ENDPOINT overrides default", () => {
      process.env.HANKWEAVE_TELEMETRY_ENDPOINT = "https://env.example.com";
      const config = resolveTelemetryConfig();
      expect(config.endpoint).toBe("https://env.example.com");
    });

    test("HANKWEAVE_TELEMETRY_ENDPOINT overrides file config", () => {
      process.env.HANKWEAVE_TELEMETRY_ENDPOINT = "https://env.example.com";
      const config = resolveTelemetryConfig({
        endpoint: "https://file.example.com",
      });
      expect(config.endpoint).toBe("https://env.example.com");
    });

    test("HANKWEAVE_TELEMETRY_DEBUG=1 enables debug", () => {
      process.env.HANKWEAVE_TELEMETRY_DEBUG = "1";
      const config = resolveTelemetryConfig();
      expect(config.debug).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Precedence order
  // ---------------------------------------------------------------------------

  describe("precedence", () => {
    test("DO_NOT_TRACK takes precedence over HANKWEAVE_TELEMETRY=1", () => {
      process.env.DO_NOT_TRACK = "1";
      process.env.HANKWEAVE_TELEMETRY = "1";
      const config = resolveTelemetryConfig({ enabled: true });
      expect(config.enabled).toBe(false);
      expect(config.disabledReason).toBe("DO_NOT_TRACK=1");
    });

    test("HANKWEAVE_TELEMETRY=0 takes precedence over file config", () => {
      process.env.HANKWEAVE_TELEMETRY = "0";
      const config = resolveTelemetryConfig({ enabled: true });
      expect(config.enabled).toBe(false);
      expect(config.disabledReason).toBe("HANKWEAVE_TELEMETRY=0");
    });

    test("CI detection takes precedence over file config enabling", () => {
      process.env.CI = "true";
      const config = resolveTelemetryConfig({ enabled: true });
      expect(config.enabled).toBe(false);
      expect(config.disabledReason).toBe("CI environment detected");
    });
  });

  // ---------------------------------------------------------------------------
  // BUG: Early-exit paths call resolveTelemetryConfig() with no fileConfig
  // ---------------------------------------------------------------------------

  describe("early-exit path gap (HIGH-1)", () => {
    test("without fileConfig, telemetry is enabled even when user intended to opt out via file", () => {
      // This simulates what sendCliTelemetry() does for --help, --init, --validate, --cleanup:
      // it calls resolveTelemetryConfig() with NO arguments, ignoring hankweave.json entirely.
      //
      // A user who set { "telemetry": { "enabled": false } } in hankweave.json would expect
      // telemetry to be disabled for ALL commands, but early-exit paths skip file config.
      //
      // The config that SHOULD be passed (but isn't by early-exit paths):
      const fileConfig: TelemetryConfig = { enabled: false };

      // What the normal path does (correctly):
      const normalPathResult = resolveTelemetryConfig(fileConfig);
      expect(normalPathResult.enabled).toBe(false);

      // What early-exit paths do (the bug — no fileConfig passed):
      const earlyExitResult = resolveTelemetryConfig();
      expect(earlyExitResult.enabled).toBe(true); // BUG: should be false
    });

    test("env var opt-out still works for early-exit paths (workaround)", () => {
      // Users CAN opt out of early-exit telemetry via env vars
      process.env.DO_NOT_TRACK = "1";
      const config = resolveTelemetryConfig();
      expect(config.enabled).toBe(false);
    });
  });
});
