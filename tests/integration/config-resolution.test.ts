import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveSettings } from "../../server/config";
import { captureEnv, restoreEnv } from "../utils/env-test-helpers";

/**
 * Integration tests for resolveSettings() - testing the full configuration resolution
 * pipeline with all 5 layers working together.
 */

const TEST_DIR = path.resolve("tests", "test-area", "config-resolution-integration");

describe("resolveSettings - Integration Tests", () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    // Capture and clear environment
    originalEnv = captureEnv();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("STRANDWEAVE_RUNTIME_")) {
        delete process.env[key];
      }
    }

    // Create clean test directory
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    // Restore environment
    restoreEnv(originalEnv);

    // Clean up test directory
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  test("uses default config when no other layers are provided", () => {
    const result = resolveSettings();

    // Should have default values
    expect(result.port).toBe(7777);
    expect(result.autostart).toBe(true);
    expect(result.withoutProxy).toBe(false);
  });

  test("merges runtime config file (layer 2)", () => {
    const runtimeConfigPath = path.join(TEST_DIR, "strandweave.json");
    fs.writeFileSync(
      runtimeConfigPath,
      JSON.stringify({
        port: 8080,
        model: "opus",
        autostart: false,
      })
    );

    const result = resolveSettings({ runtimeConfigPath });

    expect(result.port).toBe(8080);
    expect(result.model).toBe("opus");
    expect(result.autostart).toBe(false);
  });

  test("merges strand file recommendations (layer 3)", () => {
    const strandPath = path.join(TEST_DIR, "strand.json");
    fs.writeFileSync(
      strandPath,
      JSON.stringify({
        recommendations: {
          model: "sonnet",
          dataHashTimeLimit: 15000,
          sentinel: {
            enablePersistence: false,
          },
        },
        strand: [
          {
            id: "test-codon",
            name: "Test",
            model: "sonnet",
            continuationMode: "fresh",
            promptText: "test",
          },
        ],
      })
    );

    const result = resolveSettings({ strandPath });

    expect(result.model).toBe("sonnet");
    expect(result.dataHashTimeLimit).toBe(15000);
    expect(result.sentinel?.enablePersistence).toBe(false);
  });

  test("merges environment variables (layer 4)", () => {
    process.env.STRANDWEAVE_RUNTIME_PORT = "9000";
    process.env.STRANDWEAVE_RUNTIME_MODEL = "opus";
    process.env.STRANDWEAVE_RUNTIME_WITHOUT_PROXY = "true";

    const result = resolveSettings();

    expect(result.port).toBe(9000);
    expect(result.model).toBe("opus");
    expect(result.withoutProxy).toBe(true);
  });

  test("merges CLI arguments (layer 5)", () => {
    const result = resolveSettings({
      cliArgs: {
        port: 9999,
        model: "opus",
        anthropicBaseUrl: "https://custom.api.com",
      },
    });

    expect(result.port).toBe(9999);
    expect(result.model).toBe("opus");
    expect(result.anthropicBaseUrl).toBe("https://custom.api.com");
  });

  test("CLI args override environment variables", () => {
    process.env.STRANDWEAVE_RUNTIME_PORT = "8000";
    process.env.STRANDWEAVE_RUNTIME_MODEL = "sonnet";

    const result = resolveSettings({
      cliArgs: {
        port: 9999,
        // model not overridden, should use env var
      },
    });

    expect(result.port).toBe(9999); // CLI wins
    expect(result.model).toBe("sonnet"); // From env
  });

  test("environment variables override strand recommendations", () => {
    const strandPath = path.join(TEST_DIR, "strand.json");
    fs.writeFileSync(
      strandPath,
      JSON.stringify({
        recommendations: {
          model: "sonnet",
          dataHashTimeLimit: 10000,
        },
        strand: [
          {
            id: "test",
            name: "Test",
            model: "sonnet",
            continuationMode: "fresh",
            promptText: "test",
          },
        ],
      })
    );

    process.env.STRANDWEAVE_RUNTIME_MODEL = "opus";

    const result = resolveSettings({ strandPath });

    expect(result.model).toBe("opus"); // Env wins
    expect(result.dataHashTimeLimit).toBe(10000); // From strand
  });

  test("strand recommendations override runtime config", () => {
    const runtimeConfigPath = path.join(TEST_DIR, "strandweave.json");
    fs.writeFileSync(
      runtimeConfigPath,
      JSON.stringify({
        port: 8080,
        model: "sonnet",
      })
    );

    const strandPath = path.join(TEST_DIR, "strand.json");
    fs.writeFileSync(
      strandPath,
      JSON.stringify({
        recommendations: {
          model: "opus", // Override runtime config
        },
        strand: [
          {
            id: "test",
            name: "Test",
            model: "sonnet",
            continuationMode: "fresh",
            promptText: "test",
          },
        ],
      })
    );

    const result = resolveSettings({ runtimeConfigPath, strandPath });

    expect(result.model).toBe("opus"); // Strand wins
    expect(result.port).toBe(8080); // From runtime config
  });

  test("runtime config overrides defaults", () => {
    const runtimeConfigPath = path.join(TEST_DIR, "strandweave.json");
    fs.writeFileSync(
      runtimeConfigPath,
      JSON.stringify({
        port: 8080,
        autostart: false,
      })
    );

    const result = resolveSettings({ runtimeConfigPath });

    expect(result.port).toBe(8080); // Runtime config wins
    expect(result.autostart).toBe(false); // Runtime config wins
    expect(result.withoutProxy).toBe(false); // Default (not overridden)
  });

  test("all 5 layers work together with correct precedence", () => {
    // Layer 2: Runtime config
    const runtimeConfigPath = path.join(TEST_DIR, "strandweave.json");
    fs.writeFileSync(
      runtimeConfigPath,
      JSON.stringify({
        port: 8080,
        model: "sonnet",
        autostart: false,
        logParsingInterval: 2000,
      })
    );

    // Layer 3: Strand recommendations
    const strandPath = path.join(TEST_DIR, "strand.json");
    fs.writeFileSync(
      strandPath,
      JSON.stringify({
        recommendations: {
          model: "opus", // Override runtime config
          dataHashTimeLimit: 15000,
        },
        strand: [
          {
            id: "test",
            name: "Test",
            model: "sonnet",
            continuationMode: "fresh",
            promptText: "test",
          },
        ],
      })
    );

    // Layer 4: Environment variables
    process.env.STRANDWEAVE_RUNTIME_PORT = "9000"; // Override runtime config
    process.env.STRANDWEAVE_RUNTIME_WITHOUT_PROXY = "true";

    // Layer 5: CLI arguments
    const result = resolveSettings({
      runtimeConfigPath,
      strandPath,
      cliArgs: {
        port: 9999, // Override everything
        anthropicBaseUrl: "https://custom.api.com",
      },
    });

    // Verify precedence (CLI > Env > Strand > Runtime > Default)
    expect(result.port).toBe(9999); // CLI (layer 5) wins
    expect(result.model).toBe("opus"); // Strand (layer 3) wins over runtime
    expect(result.autostart).toBe(false); // Runtime (layer 2)
    expect(result.withoutProxy).toBe(true); // Env (layer 4)
    expect(result.anthropicBaseUrl).toBe("https://custom.api.com"); // CLI (layer 5)
    expect(result.dataHashTimeLimit).toBe(15000); // Strand (layer 3)
    expect(result.logParsingInterval).toBe(2000); // Runtime (layer 2)
  });

  test("handles nested sentinel config merge across layers", () => {
    // Layer 2: Runtime config
    const runtimeConfigPath = path.join(TEST_DIR, "strandweave.json");
    fs.writeFileSync(
      runtimeConfigPath,
      JSON.stringify({
        sentinel: {
          enablePersistence: true,
          healthCheckGracePeriodMs: 1000,
        },
      })
    );

    // Layer 3: Strand recommendations
    const strandPath = path.join(TEST_DIR, "strand.json");
    fs.writeFileSync(
      strandPath,
      JSON.stringify({
        recommendations: {
          sentinel: {
            enablePersistence: false, // Override
            waitForAllHealthChecks: true, // Add new field
          },
        },
        strand: [
          {
            id: "test",
            name: "Test",
            model: "sonnet",
            continuationMode: "fresh",
            promptText: "test",
          },
        ],
      })
    );

    // Layer 4: Environment
    process.env.STRANDWEAVE_RUNTIME_SENTINEL_HEALTH_CHECK_GRACE_PERIOD_MS = "3000";

    const result = resolveSettings({ runtimeConfigPath, strandPath });

    // Should deep merge sentinel config
    expect(result.sentinel?.enablePersistence).toBe(false); // Strand wins
    expect(result.sentinel?.healthCheckGracePeriodMs).toBe(3000); // Env wins
    expect(result.sentinel?.waitForAllHealthChecks).toBe(true); // From strand
  });

  test("handles missing runtime config gracefully", () => {
    const result = resolveSettings({
      runtimeConfigPath: path.join(TEST_DIR, "nonexistent.json"),
    });

    // Should still work with defaults
    expect(result.port).toBe(7777);
  });

  test("handles missing strand file gracefully", () => {
    const result = resolveSettings({
      strandPath: path.join(TEST_DIR, "nonexistent.json"),
    });

    // Should still work with defaults
    expect(result.port).toBe(7777);
  });

  test("handles strand file without recommendations", () => {
    const strandPath = path.join(TEST_DIR, "strand.json");
    fs.writeFileSync(
      strandPath,
      JSON.stringify({
        // No recommendations field
        strand: [
          {
            id: "test",
            name: "Test",
            model: "sonnet",
            continuationMode: "fresh",
            promptText: "test",
          },
        ],
      })
    );

    const result = resolveSettings({ strandPath });

    // Should still work with defaults
    expect(result.port).toBe(7777);
  });

  test("handles empty runtime config file", () => {
    const runtimeConfigPath = path.join(TEST_DIR, "strandweave.json");
    fs.writeFileSync(runtimeConfigPath, JSON.stringify({}));

    const result = resolveSettings({ runtimeConfigPath });

    // Should use defaults
    expect(result.port).toBe(7777);
  });

  test("handles empty recommendations in strand file", () => {
    const strandPath = path.join(TEST_DIR, "strand.json");
    fs.writeFileSync(
      strandPath,
      JSON.stringify({
        recommendations: {}, // Empty
        strand: [
          {
            id: "test",
            name: "Test",
            model: "sonnet",
            continuationMode: "fresh",
            promptText: "test",
          },
        ],
      })
    );

    const result = resolveSettings({ strandPath });

    // Should use defaults
    expect(result.port).toBe(7777);
  });

  test("merges complex nested configurations correctly", () => {
    const runtimeConfigPath = path.join(TEST_DIR, "strandweave.json");
    fs.writeFileSync(
      runtimeConfigPath,
      JSON.stringify({
        port: 8080,
        sentinel: {
          enablePersistence: true,
        },
      })
    );

    process.env.STRANDWEAVE_RUNTIME_MODEL = "opus";
    process.env.STRANDWEAVE_RUNTIME_SENTINEL_HEALTH_CHECK_GRACE_PERIOD_MS = "5000";

    const result = resolveSettings({
      runtimeConfigPath,
      cliArgs: {
        autostart: false,
        sentinel: {
          waitForAllHealthChecks: true,
        },
      },
    });

    // Should deep merge everything
    expect(result.port).toBe(8080); // Runtime
    expect(result.model).toBe("opus"); // Env
    expect(result.autostart).toBe(false); // CLI
    expect(result.sentinel?.enablePersistence).toBe(true); // Runtime
    expect(result.sentinel?.healthCheckGracePeriodMs).toBe(5000); // Env
    expect(result.sentinel?.waitForAllHealthChecks).toBe(true); // CLI
  });
});
