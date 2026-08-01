import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashDataSource } from "../../server/data-hasher.js";

/**
 * Tests for data hash stability of stable input files.
 *
 * When using --input or stdin, Hankweave creates content-addressed files
 * instead of random temp files, and reuses an existing file rather than
 * overwriting it so the mtime-sensitive data hash stays stable across runs.
 */
describe("Stable Input Path", () => {
  const TEST_CONTENT = "test content for stable hashing";
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    // Isolated per-run directory: never touches the shared user-level cache,
    // so concurrent test runs cannot race on a content-addressed filename.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hankweave-stable-input-"));
    filePath = path.join(tmpDir, "input-test.txt");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("data hash stability", () => {
    it("should produce same hash when file is reused (not overwritten)", async () => {
      await fs.promises.writeFile(filePath, TEST_CONTENT);
      const hash1 = await hashDataSource(filePath, 5000);

      // Hash again without touching the file (index.ts skips the write when
      // the content-addressed file already exists, preserving its mtime)
      const hash2 = await hashDataSource(filePath, 5000);

      expect(hash1).toBe(hash2);
    });

    it("should produce different hash when the file's mtime changes", async () => {
      await fs.promises.writeFile(filePath, TEST_CONTENT);
      const hash1 = await hashDataSource(filePath, 5000);

      // Bump mtime deterministically — the effect an overwrite would have.
      // The hash includes mtimeMs, so it must change even for identical
      // content; this is why index.ts checks existence before writing.
      const later = new Date(Date.now() + 60_000);
      await fs.promises.utimes(filePath, later, later);
      const hash2 = await hashDataSource(filePath, 5000);

      expect(hash1).not.toBe(hash2);
    });
  });
});
