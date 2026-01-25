import { afterEach, describe, expect, it } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashDataSource } from "../../server/data-hasher.js";

/**
 * Tests for the stable input path functionality.
 *
 * When using --input or stdin, Hankweave now creates content-addressed files
 * in ~/.hankweave-cache/inputs/ instead of random temp files. This ensures
 * that identical input text produces the same data hash, enabling proper
 * resume functionality.
 */
describe("Stable Input Path", () => {
  const CACHE_DIR = path.join(os.homedir(), ".hankweave-cache", "inputs");
  const TEST_CONTENT = "test content for stable hashing";

  // Helper: replicate the stable path generation logic from index.ts
  function getStableInputPath(content: string, type: "input" | "stdin"): string {
    const contentHash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
    return path.join(CACHE_DIR, `${type}-${contentHash}.txt`);
  }

  afterEach(async () => {
    // Clean up test files
    const testPath = getStableInputPath(TEST_CONTENT, "input");
    if (fs.existsSync(testPath)) {
      await fs.promises.unlink(testPath);
    }
  });

  describe("content-addressed file naming", () => {
    it("should generate deterministic path for same content", () => {
      const path1 = getStableInputPath(TEST_CONTENT, "input");
      const path2 = getStableInputPath(TEST_CONTENT, "input");

      expect(path1).toBe(path2);
    });

    it("should generate different paths for different content", () => {
      const path1 = getStableInputPath("content A", "input");
      const path2 = getStableInputPath("content B", "input");

      expect(path1).not.toBe(path2);
    });

    it("should generate different paths for different types", () => {
      const inputPath = getStableInputPath(TEST_CONTENT, "input");
      const stdinPath = getStableInputPath(TEST_CONTENT, "stdin");

      expect(inputPath).not.toBe(stdinPath);
      expect(inputPath).toContain("input-");
      expect(stdinPath).toContain("stdin-");
    });

    it("should use cache directory under home", () => {
      const filePath = getStableInputPath(TEST_CONTENT, "input");

      expect(filePath.startsWith(os.homedir())).toBe(true);
      expect(filePath).toContain(".hankweave-cache");
      expect(filePath).toContain("inputs");
    });
  });

  describe("data hash stability", () => {
    it("should produce same hash when file is reused (not overwritten)", async () => {
      await fs.promises.mkdir(CACHE_DIR, { recursive: true });
      const filePath = getStableInputPath(TEST_CONTENT, "input");

      // Create file first time
      await fs.promises.writeFile(filePath, TEST_CONTENT);
      const hash1 = await hashDataSource(filePath, 5000);

      // Wait a moment to ensure different timestamp if file were recreated
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Check if file exists (simulating the logic in index.ts)
      // If file exists, don't overwrite - this preserves mtime
      if (!fs.existsSync(filePath)) {
        await fs.promises.writeFile(filePath, TEST_CONTENT);
      }

      const hash2 = await hashDataSource(filePath, 5000);

      // Hashes should match because we didn't overwrite the file
      expect(hash1).toBe(hash2);
    });

    it("should produce different hash when file is overwritten (mtime changes)", async () => {
      await fs.promises.mkdir(CACHE_DIR, { recursive: true });
      const filePath = getStableInputPath(TEST_CONTENT, "input");

      // Create file first time
      await fs.promises.writeFile(filePath, TEST_CONTENT);
      const hash1 = await hashDataSource(filePath, 5000);

      // Wait to ensure different mtime
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Overwrite the file (this is what we DON'T want to do in production)
      await fs.promises.writeFile(filePath, TEST_CONTENT);
      const hash2 = await hashDataSource(filePath, 5000);

      // Hashes will be different because mtime changed
      // This demonstrates why we check for file existence before writing
      expect(hash1).not.toBe(hash2);
    });
  });

  describe("edge cases", () => {
    it("should handle empty content", () => {
      const filePath = getStableInputPath("", "input");
      expect(filePath).toBeTruthy();
      expect(filePath).toContain("input-");
    });

    it("should handle unicode content", () => {
      const unicodeContent = "Hello 世界 🌍 مرحبا";
      const filePath = getStableInputPath(unicodeContent, "input");
      expect(filePath).toBeTruthy();
    });

    it("should handle very long content", () => {
      const longContent = "x".repeat(100000);
      const filePath = getStableInputPath(longContent, "input");
      expect(filePath).toBeTruthy();
      // Path should still be reasonable length (hash is fixed length)
      expect(filePath.length).toBeLessThan(200);
    });

    it("should handle content with special characters", () => {
      const specialContent = "line1\nline2\ttab\r\nwindows\0null";
      const filePath = getStableInputPath(specialContent, "input");
      expect(filePath).toBeTruthy();
    });
  });
});
