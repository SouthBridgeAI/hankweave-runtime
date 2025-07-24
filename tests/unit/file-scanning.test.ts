import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { scanWatchedFiles } from "../../server/utils";
import * as fs from "fs";
import * as path from "path";
import { rmSync } from "fs";

describe("scanWatchedFiles", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.resolve("tests", "test-area", `temp-test-scan-${Date.now()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("scans files matching pattern", async () => {
    // Create test files
    await fs.promises.writeFile(path.join(tempDir, "file1.txt"), "content1");
    await fs.promises.writeFile(path.join(tempDir, "file2.txt"), "content2");
    await fs.promises.writeFile(path.join(tempDir, "file3.log"), "log content");

    const results = await scanWatchedFiles(tempDir, "*.txt");
    
    expect(results).toHaveLength(2);
    const paths = results.map(r => r.path).sort();
    expect(paths).toEqual(["file1.txt", "file2.txt"]);
  });

  test("includes file content", async () => {
    const content = "test file content";
    await fs.promises.writeFile(path.join(tempDir, "test.txt"), content);

    const results = await scanWatchedFiles(tempDir, "*.txt");
    
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe(content);
  });

  test("includes lastModified timestamp", async () => {
    await fs.promises.writeFile(path.join(tempDir, "test.txt"), "content");

    const results = await scanWatchedFiles(tempDir, "*.txt");
    
    expect(results).toHaveLength(1);
    expect(results[0].lastModified).toBeDefined();
    expect(new Date(results[0].lastModified).getTime()).toBeGreaterThan(0);
  });

  test("handles nested directories", async () => {
    // Create nested structure
    await fs.promises.mkdir(path.join(tempDir, "src", "components"), { recursive: true });
    await fs.promises.writeFile(path.join(tempDir, "src", "index.ts"), "export {}");
    await fs.promises.writeFile(path.join(tempDir, "src", "components", "Button.tsx"), "export {}");

    const results = await scanWatchedFiles(tempDir, "**/*.{ts,tsx}");
    
    expect(results).toHaveLength(2);
    const paths = results.map(r => r.path).sort();
    expect(paths).toEqual([
      "src/components/Button.tsx",
      "src/index.ts"
    ]);
  });

  test("returns empty array when no files match", async () => {
    await fs.promises.writeFile(path.join(tempDir, "file.txt"), "content");

    const results = await scanWatchedFiles(tempDir, "*.md");
    
    expect(results).toEqual([]);
  });

  test("handles empty directories", async () => {
    const results = await scanWatchedFiles(tempDir, "*");
    
    expect(results).toEqual([]);
  });

  test("preserves file encoding", async () => {
    const unicodeContent = "Hello 世界 🌍";
    await fs.promises.writeFile(path.join(tempDir, "unicode.txt"), unicodeContent);

    const results = await scanWatchedFiles(tempDir, "*.txt");
    
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe(unicodeContent);
  });

  test("handles large files", async () => {
    const largeContent = "x".repeat(1000000); // 1MB of x's
    await fs.promises.writeFile(path.join(tempDir, "large.txt"), largeContent);

    const results = await scanWatchedFiles(tempDir, "*.txt");
    
    expect(results).toHaveLength(1);
    expect(results[0].content.length).toBe(1000000);
  });

  test("respects glob patterns", async () => {
    // Create various files
    await fs.promises.writeFile(path.join(tempDir, "test.js"), "js");
    await fs.promises.writeFile(path.join(tempDir, "test.ts"), "ts");
    await fs.promises.writeFile(path.join(tempDir, "test.jsx"), "jsx");
    await fs.promises.writeFile(path.join(tempDir, "test.tsx"), "tsx");
    await fs.promises.writeFile(path.join(tempDir, "test.css"), "css");

    const results = await scanWatchedFiles(tempDir, "*.{js,jsx,ts,tsx}");
    
    expect(results).toHaveLength(4);
    const extensions = results.map(r => path.extname(r.path)).sort();
    expect(extensions).toEqual([".js", ".jsx", ".ts", ".tsx"]);
  });

  test("handles special characters in filenames", async () => {
    const specialName = "file with spaces & special-chars!.txt";
    await fs.promises.writeFile(path.join(tempDir, specialName), "content");

    const results = await scanWatchedFiles(tempDir, "*.txt");
    
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe(specialName);
  });
});