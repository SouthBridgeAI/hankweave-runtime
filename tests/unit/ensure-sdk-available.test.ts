import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeAgentSDKManager } from "../../server/claude-agent-sdk-manager.js";
import { captureEnv, restoreEnv } from "../utils/env-test-helpers.js";

describe("ClaudeAgentSDKManager.ensureSdkAvailable", () => {
  let originalEnv: Record<string, string | undefined>;
  let tempDir: string;

  beforeEach(() => {
    // Capture current environment state
    originalEnv = captureEnv();

    // Create temp directory for test files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-sdk-test-"));
  });

  afterEach(() => {
    // Restore original environment
    restoreEnv(originalEnv);

    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Helper to create a dummy CLI file
  function createDummyCliFile(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, "// Dummy CLI file for testing");
  }

  describe("Source Mode (not compiled)", () => {
    test("should return null when running from source", async () => {
      // Mock isCompiledExecutable to return false
      mock.module("../../server/claude-runtime-extractor.js", () => ({
        isCompiledExecutable: () => false,
        needsExtraction: () => false,
        getExtractedCliPath: () => "/fake/path",
        extractClaudeSdkFiles: async () => "/fake/path",
      }));

      expect(await ClaudeAgentSDKManager.ensureSdkAvailable()).toBeNull();
    });

    test("should not set CLAUDE_PATH_TO_CLAUDE_EXECUTABLE env var", async () => {
      // Ensure env var is not set before test
      delete process.env.CLAUDE_PATH_TO_CLAUDE_EXECUTABLE;

      mock.module("../../server/claude-runtime-extractor.js", () => ({
        isCompiledExecutable: () => false,
        needsExtraction: () => false,
        getExtractedCliPath: () => "/fake/path",
        extractClaudeSdkFiles: async () => "/fake/path",
      }));

      await ClaudeAgentSDKManager.ensureSdkAvailable();

      expect(process.env.CLAUDE_PATH_TO_CLAUDE_EXECUTABLE).toBeUndefined();
    });
  });

  describe("Compiled Mode - Cached SDK", () => {
    test("should use cached SDK when already extracted", async () => {
      const cliPath = path.join(tempDir, "cached", "cli.js");
      createDummyCliFile(cliPath);

      mock.module("../../server/claude-runtime-extractor.js", () => ({
        isCompiledExecutable: () => true,
        needsExtraction: () => false,
        getExtractedCliPath: () => cliPath,
        extractClaudeSdkFiles: async () => {
          throw new Error("Should not extract when cached");
        },
      }));

      const result = await ClaudeAgentSDKManager.ensureSdkAvailable();

      expect(result).toBe(cliPath);
    });

    test("should set CLAUDE_PATH_TO_CLAUDE_EXECUTABLE env var", async () => {
      const cliPath = path.join(tempDir, "cached", "cli.js");
      createDummyCliFile(cliPath);

      mock.module("../../server/claude-runtime-extractor.js", () => ({
        isCompiledExecutable: () => true,
        needsExtraction: () => false,
        getExtractedCliPath: () => cliPath,
        extractClaudeSdkFiles: async () => {
          throw new Error("Should not extract when cached");
        },
      }));

      await ClaudeAgentSDKManager.ensureSdkAvailable();

      expect(process.env.CLAUDE_PATH_TO_CLAUDE_EXECUTABLE).toBe(cliPath);
    });
  });

  describe("Compiled Mode - Fresh Extraction", () => {
    test("should extract SDK when not cached", async () => {
      const cliPath = path.join(tempDir, "extracted", "cli.js");
      let extractCalled = false;

      mock.module("../../server/claude-runtime-extractor.js", () => ({
        isCompiledExecutable: () => true,
        needsExtraction: () => true,
        getExtractedCliPath: () => {
          throw new Error("Should not call getExtractedCliPath when extraction needed");
        },
        extractClaudeSdkFiles: async () => {
          extractCalled = true;
          // Simulate extraction by creating the file
          createDummyCliFile(cliPath);
          return cliPath;
        },
      }));

      const result = await ClaudeAgentSDKManager.ensureSdkAvailable();

      expect(extractCalled).toBe(true);
      expect(result).toBe(cliPath);
    });

    test("should set env var after extraction", async () => {
      const cliPath = path.join(tempDir, "extracted", "cli.js");

      mock.module("../../server/claude-runtime-extractor.js", () => ({
        isCompiledExecutable: () => true,
        needsExtraction: () => true,
        getExtractedCliPath: () => {
          throw new Error("Should not call getExtractedCliPath");
        },
        extractClaudeSdkFiles: async () => {
          createDummyCliFile(cliPath);
          return cliPath;
        },
      }));

      await ClaudeAgentSDKManager.ensureSdkAvailable();

      expect(process.env.CLAUDE_PATH_TO_CLAUDE_EXECUTABLE).toBe(cliPath);
    });
  });

  describe("Error Cases", () => {
    test("should throw when extracted file doesn't exist", async () => {
      const nonExistentPath = path.join(tempDir, "does-not-exist", "cli.js");

      mock.module("../../server/claude-runtime-extractor.js", () => ({
        isCompiledExecutable: () => true,
        needsExtraction: () => false,
        getExtractedCliPath: () => nonExistentPath,
        extractClaudeSdkFiles: async () => {
          throw new Error("Should not extract");
        },
      }));

      await expect(ClaudeAgentSDKManager.ensureSdkAvailable()).rejects.toThrow(
        `Extracted Claude CLI not found at: ${nonExistentPath}`,
      );
    });

    test("should throw when extraction fails", async () => {
      mock.module("../../server/claude-runtime-extractor.js", () => ({
        isCompiledExecutable: () => true,
        needsExtraction: () => true,
        getExtractedCliPath: () => {
          throw new Error("Should not call");
        },
        extractClaudeSdkFiles: async () => {
          throw new Error("Extraction failed - corrupt archive");
        },
      }));

      await expect(ClaudeAgentSDKManager.ensureSdkAvailable()).rejects.toThrow(
        "Extraction failed - corrupt archive",
      );
    });

    test("should throw when file is created but then deleted before verification", async () => {
      const cliPath = path.join(tempDir, "deleted", "cli.js");

      mock.module("../../server/claude-runtime-extractor.js", () => ({
        isCompiledExecutable: () => true,
        needsExtraction: () => true,
        getExtractedCliPath: () => {
          throw new Error("Should not call");
        },
        extractClaudeSdkFiles: async () => {
          // Create file during extraction
          createDummyCliFile(cliPath);
          // Then delete it to simulate race condition
          fs.unlinkSync(cliPath);
          return cliPath;
        },
      }));

      await expect(ClaudeAgentSDKManager.ensureSdkAvailable()).rejects.toThrow(
        `Extracted Claude CLI not found at: ${cliPath}`,
      );
    });
  });
});
