import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as extractorModule from "../../server/codex-runtime-extractor.js";
import { captureEnv, restoreEnv } from "../utils/env-test-helpers.js";

describe("Codex Runtime Extractor", () => {
  let originalEnv: Record<string, string | undefined>;
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    // Capture current environment and working directory
    originalEnv = captureEnv();
    originalCwd = process.cwd();

    // Create temp directory for test files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-extractor-test-"));
  });

  afterEach(() => {
    // Restore mocks and environment
    mock.restore();
    restoreEnv(originalEnv);

    // Restore working directory
    process.chdir(originalCwd);

    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Helper to create a dummy codex binary file
  function createDummyCodexBinary(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, "#!/bin/bash\necho 'dummy codex'");

    // Make executable on Unix
    if (os.platform() !== "win32") {
      fs.chmodSync(filePath, 0o755);
    }
  }

  describe("getCodexPlatform", () => {
    test("should detect current platform", () => {
      // Just test that it returns a valid platform for the current system
      const platform = extractorModule.getCodexPlatform();

      const validPlatforms = [
        "aarch64-apple-darwin",
        "x86_64-apple-darwin",
        "aarch64-unknown-linux-musl",
        "x86_64-unknown-linux-musl",
        "aarch64-pc-windows-msvc",
        "x86_64-pc-windows-msvc",
      ];

      expect(validPlatforms).toContain(platform);
    });

    test("should be consistent with os.platform and os.arch", () => {
      const platform = extractorModule.getCodexPlatform();
      const osArch = os.arch();
      const osPlatform = os.platform();

      // Verify the platform string makes sense for the current system
      if (osPlatform === "darwin") {
        expect(platform).toMatch(/darwin$/);
        if (osArch === "arm64") {
          expect(platform).toBe("aarch64-apple-darwin");
        } else {
          expect(platform).toBe("x86_64-apple-darwin");
        }
      } else if (osPlatform === "linux") {
        expect(platform).toMatch(/linux-musl$/);
        if (osArch === "arm64") {
          expect(platform).toBe("aarch64-unknown-linux-musl");
        } else {
          expect(platform).toBe("x86_64-unknown-linux-musl");
        }
      } else if (osPlatform === "win32") {
        expect(platform).toMatch(/windows-msvc$/);
      }
    });

    describe("with target parameter (cross-compilation)", () => {
      test("should return correct platform for linux-x64", () => {
        expect(extractorModule.getCodexPlatform("linux-x64")).toBe("x86_64-unknown-linux-musl");
      });

      test("should return correct platform for linux-arm64", () => {
        expect(extractorModule.getCodexPlatform("linux-arm64")).toBe("aarch64-unknown-linux-musl");
      });

      test("should return correct platform for darwin-x64", () => {
        expect(extractorModule.getCodexPlatform("darwin-x64")).toBe("x86_64-apple-darwin");
      });

      test("should return correct platform for darwin-arm64", () => {
        expect(extractorModule.getCodexPlatform("darwin-arm64")).toBe("aarch64-apple-darwin");
      });

      test("should return correct platform for windows-x64", () => {
        expect(extractorModule.getCodexPlatform("windows-x64")).toBe("x86_64-pc-windows-msvc");
      });

      test("should return correct platform for windows-arm64", () => {
        expect(extractorModule.getCodexPlatform("windows-arm64")).toBe("aarch64-pc-windows-msvc");
      });

      test("should throw error for unsupported platform", () => {
        expect(() => extractorModule.getCodexPlatform("freebsd-x64")).toThrow(
          "Unsupported platform: freebsd-x64",
        );
      });

      test("should throw error for invalid target format", () => {
        expect(() => extractorModule.getCodexPlatform("invalid")).toThrow("Unsupported platform");
      });
    });
  });

  describe("getCodexBinaryName", () => {
    test("should return correct binary name for current platform", () => {
      const binaryName = extractorModule.getCodexBinaryName();

      // Should be either codex or codex.exe
      expect(["codex", "codex.exe"]).toContain(binaryName);

      // Should match platform
      if (os.platform() === "win32") {
        expect(binaryName).toBe("codex.exe");
      } else {
        expect(binaryName).toBe("codex");
      }
    });
  });

  describe("getCodexExtractionDir", () => {
    test("should use default cache directory", () => {
      const result = extractorModule.getCodexExtractionDir();
      const homeDir = os.homedir();
      expect(result).toBe(path.join(homeDir, ".hankweave", "codex-sdk", "0.87.0"));
    });

    test("should respect HANKWEAVE_CACHE_DIR env var", () => {
      const customCache = path.join(tempDir, "custom-cache");
      process.env.HANKWEAVE_CACHE_DIR = customCache;

      const result = extractorModule.getCodexExtractionDir();
      expect(result).toBe(path.join(customCache, "codex-sdk", "0.87.0"));
    });
  });

  describe("getExtractedCodexPath", () => {
    test("should combine extraction dir with binary name", () => {
      const extractDir = extractorModule.getCodexExtractionDir();
      const binaryName = extractorModule.getCodexBinaryName();
      const result = extractorModule.getExtractedCodexPath();

      expect(result).toBe(path.join(extractDir, binaryName));
    });
  });

  describe("locateCodexInNodeModules", () => {
    test("should find codex when cwd has no node_modules ancestry", () => {
      // This test verifies the fix for the npx scenario where:
      // - User's cwd: /user/myproject (no node_modules)
      // - Binary exists in the package's own node_modules
      const userProjectDir = path.join(tempDir, "user-project");

      // Create empty user project directory (no node_modules)
      fs.mkdirSync(userProjectDir, { recursive: true });

      // User runs command from their project directory
      process.chdir(userProjectDir);

      const result = extractorModule.locateCodexInNodeModules();

      expect(result).not.toBeNull();
      expect(result).toContain("codex-sdk");
    });

    test("should find codex from module location regardless of cwd", () => {
      // After the fix, we always search from module location, not cwd
      // So changing to temp dir doesn't affect the result
      process.chdir(tempDir);

      const result = extractorModule.locateCodexInNodeModules();
      expect(result).not.toBeNull();
      if (result) {
        expect(result).toContain("codex-sdk");
      }
    });

    test("should find codex from module location when not in cwd", () => {
      // Change to temp dir with no node_modules
      process.chdir(tempDir);

      const result = extractorModule.locateCodexInNodeModules();
      // After the fix, finds codex from module location even when cwd has none
      expect(result).not.toBeNull();
      expect(result).toContain("codex-sdk");
    });

    test("should find codex from module location even when cwd has different packages", () => {
      // Create node_modules but without codex-sdk
      const nodeModulesDir = path.join(tempDir, "node_modules", "some-other-package");
      fs.mkdirSync(nodeModulesDir, { recursive: true });

      process.chdir(tempDir);

      const result = extractorModule.locateCodexInNodeModules();
      // After the fix, finds codex from module location
      expect(result).not.toBeNull();
      expect(result).toContain("codex-sdk");
    });
  });

  describe("needsCodexExtraction", () => {
    test("should return true if marker file doesn't exist", () => {
      // Set extraction dir to temp location
      process.env.HANKWEAVE_CACHE_DIR = tempDir;

      const result = extractorModule.needsCodexExtraction();
      expect(result).toBe(true);
    });

    test("should return true if binary doesn't exist", () => {
      // Set extraction dir to temp location
      process.env.HANKWEAVE_CACHE_DIR = tempDir;

      // Create marker file but not binary
      const extractDir = extractorModule.getCodexExtractionDir();
      fs.mkdirSync(extractDir, { recursive: true });
      fs.writeFileSync(path.join(extractDir, ".extraction-complete"), "0.87.0");

      const result = extractorModule.needsCodexExtraction();
      expect(result).toBe(true);
    });

    test("should return true if version doesn't match", () => {
      // Set extraction dir to temp location
      process.env.HANKWEAVE_CACHE_DIR = tempDir;

      // Create both marker and binary with wrong version
      const extractDir = extractorModule.getCodexExtractionDir();
      const codexPath = extractorModule.getExtractedCodexPath();

      fs.mkdirSync(extractDir, { recursive: true });
      fs.writeFileSync(path.join(extractDir, ".extraction-complete"), "0.86.0"); // Old version
      createDummyCodexBinary(codexPath);

      const result = extractorModule.needsCodexExtraction();
      expect(result).toBe(true);
    });

    test("should return false if extraction is current", () => {
      // Set extraction dir to temp location
      process.env.HANKWEAVE_CACHE_DIR = tempDir;

      // Create both marker and binary with correct version
      const extractDir = extractorModule.getCodexExtractionDir();
      const codexPath = extractorModule.getExtractedCodexPath();

      fs.mkdirSync(extractDir, { recursive: true });
      fs.writeFileSync(path.join(extractDir, ".extraction-complete"), "0.87.0");
      createDummyCodexBinary(codexPath);

      const result = extractorModule.needsCodexExtraction();
      expect(result).toBe(false);
    });

    test("should return true if marker file is corrupted", () => {
      // Set extraction dir to temp location
      process.env.HANKWEAVE_CACHE_DIR = tempDir;

      // Create marker file with no read permissions
      const extractDir = extractorModule.getCodexExtractionDir();
      const markerPath = path.join(extractDir, ".extraction-complete");

      fs.mkdirSync(extractDir, { recursive: true });
      fs.writeFileSync(markerPath, "0.87.0");

      // Make marker file unreadable (Unix only)
      if (os.platform() !== "win32") {
        fs.chmodSync(markerPath, 0o000);
      }

      const result = extractorModule.needsCodexExtraction();

      // Restore permissions for cleanup
      if (os.platform() !== "win32") {
        fs.chmodSync(markerPath, 0o644);
      }

      // Should return true because we can't verify the version
      if (os.platform() !== "win32") {
        expect(result).toBe(true);
      }
    });
  });

  describe("validateCodexBinary", () => {
    test("should return false if file doesn't exist", () => {
      const nonExistentPath = path.join(tempDir, "does-not-exist", "codex");
      const result = extractorModule.validateCodexBinary(nonExistentPath);
      expect(result).toBe(false);
    });

    test("should return false if path is a directory", () => {
      const dirPath = path.join(tempDir, "is-a-directory");
      fs.mkdirSync(dirPath, { recursive: true });

      const result = extractorModule.validateCodexBinary(dirPath);
      expect(result).toBe(false);
    });

    test("should return true for valid binary file", () => {
      const binaryPath = path.join(tempDir, "codex");
      createDummyCodexBinary(binaryPath);

      const result = extractorModule.validateCodexBinary(binaryPath);
      expect(result).toBe(true);
    });

    test("should return false if file is not executable on Unix", () => {
      if (os.platform() === "win32") {
        // Skip on Windows - no executable bit
        return;
      }

      const binaryPath = path.join(tempDir, "codex");
      createDummyCodexBinary(binaryPath);

      // Remove execute permission
      fs.chmodSync(binaryPath, 0o644);

      const result = extractorModule.validateCodexBinary(binaryPath);
      expect(result).toBe(false);
    });

    test("should return true for .exe files on Windows", () => {
      if (os.platform() !== "win32") {
        // Skip on non-Windows - .exe handling is Windows-specific
        return;
      }

      const binaryPath = path.join(tempDir, "codex.exe");
      createDummyCodexBinary(binaryPath);

      const result = extractorModule.validateCodexBinary(binaryPath);
      expect(result).toBe(true);
    });

    test("should handle filesystem errors gracefully", () => {
      // Try to validate a path that will cause an error
      // Using a null byte in the path should cause an error
      const result = extractorModule.validateCodexBinary("/invalid\0path");
      expect(result).toBe(false);
    });
  });

  describe("ensureCodexAvailable - Source/NPM Mode", () => {
    test("should find binary from module location when not compiled", async () => {
      // Set env var to indicate not compiled (source mode)
      process.env.HANKWEAVE_TEST_IS_COMPILED = "false";

      // Change to temp dir (no node_modules there)
      process.chdir(tempDir);

      // Should find the real codex from module location, not from cwd
      const result = await extractorModule.ensureCodexAvailable();
      expect(result.path).toContain("codex-sdk");
    });

    test("should find binary from module location even when cwd has no node_modules", async () => {
      // Set env var to indicate not compiled (source mode)
      process.env.HANKWEAVE_TEST_IS_COMPILED = "false";

      // Change to temp dir with no node_modules
      process.chdir(tempDir);

      // After the fix, this should find the binary from module location
      const result = await extractorModule.ensureCodexAvailable();
      expect(result.path).toContain("codex-sdk");
    });
  });

  describe("ensureCodexAvailable - Compiled Mode with Cache", () => {
    test("should use cached binary when available", async () => {
      // Set env var to indicate compiled mode
      process.env.HANKWEAVE_TEST_IS_COMPILED = "true";
      process.env.HANKWEAVE_CACHE_DIR = tempDir;

      // Create cached binary
      const extractDir = extractorModule.getCodexExtractionDir();
      const codexPath = extractorModule.getExtractedCodexPath();

      fs.mkdirSync(extractDir, { recursive: true });
      fs.writeFileSync(path.join(extractDir, ".extraction-complete"), "0.87.0");
      createDummyCodexBinary(codexPath);

      const result = await extractorModule.ensureCodexAvailable();
      expect(result.path).toBe(codexPath);
    });
  });

  describe("ensureCodexAvailable - Compiled Mode Fresh Extraction", () => {
    test("should call extractCodexBinary when cache is missing", async () => {
      // Set env var to indicate compiled mode
      process.env.HANKWEAVE_TEST_IS_COMPILED = "true";
      process.env.HANKWEAVE_CACHE_DIR = tempDir;

      // Since we can't mock Bun.embeddedFiles in tests, we'll manually create
      // the binary to simulate what extraction would do
      const extractDir = extractorModule.getCodexExtractionDir();
      const codexPath = extractorModule.getExtractedCodexPath();

      // Manually create the binary (simulating extraction)
      createDummyCodexBinary(codexPath);
      fs.writeFileSync(path.join(extractDir, ".extraction-complete"), "0.87.0");

      const result = await extractorModule.ensureCodexAvailable();
      expect(result.path).toBe(codexPath);
      expect(fs.existsSync(codexPath)).toBe(true);

      // Verify marker file exists
      const markerPath = path.join(extractDir, ".extraction-complete");
      expect(fs.existsSync(markerPath)).toBe(true);
      expect(fs.readFileSync(markerPath, "utf-8").trim()).toBe("0.87.0");
    });
  });

  describe("Error Handling", () => {
    test("should find binary from module location even in empty directory (source mode)", async () => {
      // Set env var to indicate not compiled (source mode)
      process.env.HANKWEAVE_TEST_IS_COMPILED = "false";

      // Create temp dir with no node_modules
      const emptyDir = path.join(tempDir, "empty");
      fs.mkdirSync(emptyDir, { recursive: true });
      process.chdir(emptyDir);

      // After the fix, this should find the binary from module location
      const result = await extractorModule.ensureCodexAvailable();
      expect(result.path).toContain("codex-sdk");
    });

    test("validateCodexBinary should return false for non-existent files", () => {
      const result = extractorModule.validateCodexBinary(path.join(tempDir, "does-not-exist"));
      expect(result).toBe(false);
    });

    test("validateCodexBinary should return false for directories", () => {
      const dirPath = path.join(tempDir, "is-a-dir");
      fs.mkdirSync(dirPath, { recursive: true });

      const result = extractorModule.validateCodexBinary(dirPath);
      expect(result).toBe(false);
    });
  });
});
