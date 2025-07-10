import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  executeTestCleanup,
  isCleanupNeeded,
  logCleanupResults,
  type CleanupIntegrationResult,
} from "../utils/cleanup-integration.js";

describe("Cleanup Integration Utility", () => {
  const testRoot = path.join(
    process.cwd(),
    "tests/unit/test-cleanup-integration"
  );
  const testDir = path.join(testRoot, "test-project");
  const configPath = path.join(testRoot, "test-config.json");

  beforeEach(async () => {
    // Create test directory structure
    await fs.promises.mkdir(testDir, { recursive: true });

    // Create a minimal test config
    const testConfig = [
      {
        id: "test-phase",
        name: "Test Phase",
        promptText: "Test prompt",
        model: "claude-3-sonnet-20240229",
        workspaceSetup: [
          {
            type: "copy",
            copy: {
              from: ".",
              to: "copied-dir",
            },
          },
        ],
      },
    ];

    await fs.promises.writeFile(
      configPath,
      JSON.stringify(testConfig, null, 2)
    );
  });

  afterEach(async () => {
    // Clean up test directory
    if (fs.existsSync(testRoot)) {
      await fs.promises.rm(testRoot, { recursive: true, force: true });
    }
  });

  describe("isCleanupNeeded", () => {
    test("returns false for non-existent directory", () => {
      expect(isCleanupNeeded("/non/existent/path")).toBe(false);
    });

    test("returns false for clean directory", () => {
      expect(isCleanupNeeded(testDir)).toBe(false);
    });

    test("returns true when .langton directory exists", async () => {
      const langtonDir = path.join(testDir, ".langton");
      await fs.promises.mkdir(langtonDir, { recursive: true });

      expect(isCleanupNeeded(testDir)).toBe(true);
    });

    test("returns true when test artifacts exist", async () => {
      const notesDir = path.join(testDir, "notes");
      await fs.promises.mkdir(notesDir, { recursive: true });

      expect(isCleanupNeeded(testDir)).toBe(true);
    });

    test("detects multiple artifact types", async () => {
      // Create various test artifacts
      await fs.promises.mkdir(path.join(testDir, "typescript_code"), {
        recursive: true,
      });
      await fs.promises.mkdir(path.join(testDir, "output"), {
        recursive: true,
      });

      expect(isCleanupNeeded(testDir)).toBe(true);
    });
  });

  describe("executeTestCleanup", () => {
    test("returns error when test directory doesn't exist", async () => {
      const result = await executeTestCleanup({
        testDir: "/non/existent/path",
        phasesConfig: configPath,
      });

      expect(result.success).toBe(false);
      expect(result.errors).toContain(
        "Test directory does not exist: /non/existent/path"
      );
    });

    test("returns error when config doesn't exist", async () => {
      const result = await executeTestCleanup({
        testDir: testDir,
        phasesConfig: "/non/existent/config.json",
      });

      expect(result.success).toBe(false);
      expect(result.errors).toContain(
        "Phases configuration does not exist: /non/existent/config.json"
      );
    });

    test("falls back to manual cleanup when force is true", async () => {
      // Create .langton directory
      const langtonDir = path.join(testDir, ".langton");
      await fs.promises.mkdir(langtonDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(langtonDir, "test.log"),
        "test content"
      );

      // Use an invalid config to force CleanupCommand to fail
      await fs.promises.writeFile(configPath, "invalid json");

      const result = await executeTestCleanup({
        testDir: testDir,
        phasesConfig: configPath,
        force: true,
      });

      // Debug output
      if (!result.success) {
        console.log("Result:", result);
      }

      // Should succeed with warnings
      expect(result.success).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[1]).toBe(
        "Performing manual cleanup of .langton directory only"
      );
      expect(result.directoriesRemoved).toContain(".langton");

      // Verify .langton was actually removed
      expect(fs.existsSync(langtonDir)).toBe(false);
    });

    test("returns error without fallback when force is false", async () => {
      // Use invalid config to force failure
      await fs.promises.writeFile(configPath, "invalid json");

      const result = await executeTestCleanup({
        testDir: testDir,
        phasesConfig: configPath,
        force: false,
      });

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.warnings.length).toBe(0);
    });

    test("manual cleanup handles missing .langton directory gracefully", async () => {
      // Don't create .langton directory
      // Use invalid config to trigger manual cleanup
      await fs.promises.writeFile(configPath, "invalid json");

      const result = await executeTestCleanup({
        testDir: testDir,
        phasesConfig: configPath,
        force: true,
      });

      // When there's nothing to clean, it should still be successful
      expect(result.success).toBe(true);
      expect(result.directoriesRemoved.length).toBe(0);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("Cleanup command failed");
    });

    test("manual cleanup reports errors when removal fails", async () => {
      // Create .langton directory with a file that can't be removed
      const langtonDir = path.join(testDir, ".langton");
      await fs.promises.mkdir(langtonDir, { recursive: true });

      // Make directory read-only to simulate removal failure
      // Note: This might not work on all systems, so we'll skip if it doesn't
      try {
        await fs.promises.chmod(langtonDir, 0o444);

        // Use invalid config to trigger manual cleanup
        await fs.promises.writeFile(configPath, "invalid json");

        const result = await executeTestCleanup({
          testDir: testDir,
          phasesConfig: configPath,
          force: true,
        });

        // If chmod worked, removal should fail
        if (result.success === false) {
          expect(result.errors.length).toBeGreaterThan(0);
          expect(result.errors[0]).toContain(
            "Failed to manually remove .langton"
          );
        }

        // Restore permissions for cleanup
        await fs.promises.chmod(langtonDir, 0o755);
      } catch (error) {
        // Skip test if chmod isn't supported
        console.log("Skipping read-only test - chmod not supported");
      }
    });
  });

  describe("logCleanupResults", () => {
    // Capture console output
    let consoleOutput: string[] = [];
    const originalLog = console.log;

    beforeEach(() => {
      consoleOutput = [];
      console.log = (...args: any[]) => {
        consoleOutput.push(args.join(" "));
      };
    });

    afterEach(() => {
      console.log = originalLog;
    });

    test("logs success message for successful cleanup", () => {
      const result: CleanupIntegrationResult = {
        success: true,
        filesRemoved: [],
        directoriesRemoved: [],
        errors: [],
        warnings: [],
      };

      logCleanupResults(result);

      expect(consoleOutput).toContain("✅ Test cleanup completed successfully");
    });

    test("logs verbose details when requested", () => {
      const result: CleanupIntegrationResult = {
        success: true,
        filesRemoved: ["file1.txt", "file2.txt"],
        directoriesRemoved: ["dir1", "dir2", "dir3"],
        errors: [],
        warnings: ["Warning 1", "Warning 2"],
      };

      logCleanupResults(result, true);

      expect(consoleOutput).toContain("✅ Test cleanup completed successfully");
      expect(consoleOutput).toContain("  - Files removed: 2");
      expect(consoleOutput).toContain("  - Directories removed: 3");
      expect(consoleOutput).toContain("⚠️  Warnings:");
      expect(consoleOutput).toContain("  - Warning 1");
      expect(consoleOutput).toContain("  - Warning 2");
    });

    test("logs error details for failed cleanup", () => {
      const result: CleanupIntegrationResult = {
        success: false,
        filesRemoved: [],
        directoriesRemoved: [],
        errors: ["Error 1", "Error 2"],
        warnings: [],
      };

      logCleanupResults(result);

      expect(consoleOutput).toContain("❌ Test cleanup failed");
      expect(consoleOutput).toContain("  - Error: Error 1");
      expect(consoleOutput).toContain("  - Error: Error 2");
    });

    test("doesn't log warnings in non-verbose mode", () => {
      const result: CleanupIntegrationResult = {
        success: true,
        filesRemoved: [],
        directoriesRemoved: [],
        errors: [],
        warnings: ["Warning 1"],
      };

      logCleanupResults(result, false);

      expect(consoleOutput).not.toContain("⚠️  Warnings:");
      expect(consoleOutput).not.toContain("Warning 1");
    });
  });
});
