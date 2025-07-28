import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { UnifiedFileResolver } from "../../server/file-resolver";

describe("UnifiedFileResolver", () => {
  let tempDir: string;
  let resolver: UnifiedFileResolver;

  beforeEach(async () => {
    tempDir = path.resolve("tests", "test-area", `temp-resolver-${Date.now()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });
    resolver = new UnifiedFileResolver();
  });

  afterEach(async () => {
    resolver.clearCache();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  test("resolves files matching patterns", async () => {
    // Create test files
    await fs.promises.writeFile(path.join(tempDir, "file1.txt"), "content1");
    await fs.promises.writeFile(path.join(tempDir, "file2.txt"), "content2");
    await fs.promises.writeFile(path.join(tempDir, "file3.log"), "log content");

    const files = await resolver.resolveFiles(tempDir, ["*.txt"]);

    expect(files).toHaveLength(2);
    expect(files.sort()).toEqual(["file1.txt", "file2.txt"]);
  });

  test("respects .gitignore rules", async () => {
    // Create test files
    await fs.promises.writeFile(path.join(tempDir, "include.txt"), "included");
    await fs.promises.writeFile(path.join(tempDir, "ignore.txt"), "ignored");
    await fs.promises.writeFile(path.join(tempDir, ".gitignore"), "ignore.txt\n");

    const files = await resolver.resolveFiles(tempDir, ["*.txt"]);

    expect(files).toHaveLength(1);
    expect(files).toEqual(["include.txt"]);
  });

  test("handles nested .gitignore files", async () => {
    // Create nested structure
    await fs.promises.mkdir(path.join(tempDir, "src"), { recursive: true });
    await fs.promises.writeFile(path.join(tempDir, "root.txt"), "root");
    await fs.promises.writeFile(path.join(tempDir, "src", "src.txt"), "src");
    await fs.promises.writeFile(path.join(tempDir, "src", "ignore.txt"), "ignored");

    // Root gitignore
    await fs.promises.writeFile(path.join(tempDir, ".gitignore"), "*.log\n");

    // Nested gitignore
    await fs.promises.writeFile(path.join(tempDir, "src", ".gitignore"), "ignore.txt\n");

    const files = await resolver.resolveFiles(tempDir, ["**/*.txt"]);

    expect(files.sort()).toEqual(["root.txt", "src/src.txt"]);
  });

  test("handles negation patterns", async () => {
    // Create test files
    await fs.promises.mkdir(path.join(tempDir, "build"), { recursive: true });
    await fs.promises.writeFile(path.join(tempDir, "build", "output.js"), "output");
    await fs.promises.writeFile(path.join(tempDir, "build", "important.js"), "important");

    // Gitignore with negation
    await fs.promises.writeFile(path.join(tempDir, ".gitignore"), "build/\n!build/important.js\n");

    const files = await resolver.resolveFiles(tempDir, ["**/*.js"]);

    // Git ignores ALL files in build/ directory once it's ignored
    expect(files).toEqual([]);
  });

  test("ignores .git directory by default", async () => {
    // Create .git directory
    await fs.promises.mkdir(path.join(tempDir, ".git"), { recursive: true });
    await fs.promises.writeFile(path.join(tempDir, ".git", "config"), "git config");
    await fs.promises.writeFile(path.join(tempDir, "file.txt"), "content");

    const files = await resolver.resolveFiles(tempDir, ["**/*"]);

    expect(files).toEqual(["file.txt"]);
  });

  test("handles multiple patterns", async () => {
    // Create various files
    await fs.promises.writeFile(path.join(tempDir, "script.js"), "js");
    await fs.promises.writeFile(path.join(tempDir, "style.css"), "css");
    await fs.promises.writeFile(path.join(tempDir, "doc.md"), "markdown");

    const files = await resolver.resolveFiles(tempDir, ["*.js", "*.css"]);

    expect(files.sort()).toEqual(["script.js", "style.css"]);
  });

  test("caches gitignore rules", async () => {
    // Create test file and gitignore
    await fs.promises.writeFile(path.join(tempDir, "file.txt"), "content");
    await fs.promises.writeFile(path.join(tempDir, ".gitignore"), "ignore.txt\n");

    // First call
    const files1 = await resolver.resolveFiles(tempDir, ["*.txt"]);
    expect(files1).toEqual(["file.txt"]);

    // Modify gitignore (cached version should still be used)
    await fs.promises.writeFile(path.join(tempDir, ".gitignore"), "*.txt\n");

    // Second call should use cached rules
    const files2 = await resolver.resolveFiles(tempDir, ["*.txt"]);
    expect(files2).toEqual(["file.txt"]);

    // Clear cache and try again
    resolver.clearCache(tempDir);
    const files3 = await resolver.resolveFiles(tempDir, ["*.txt"]);
    expect(files3).toEqual([]);
  });

  test("handles empty patterns", async () => {
    const files = await resolver.resolveFiles(tempDir, []);
    expect(files).toEqual([]);
  });

  test("handles comments in gitignore", async () => {
    await fs.promises.writeFile(path.join(tempDir, "file.txt"), "content");
    await fs.promises.writeFile(path.join(tempDir, "ignore.txt"), "ignored");
    await fs.promises.writeFile(
      path.join(tempDir, ".gitignore"),
      "# This is a comment\nignore.txt\n# Another comment\n",
    );

    const files = await resolver.resolveFiles(tempDir, ["*.txt"]);
    expect(files).toEqual(["file.txt"]);
  });
});
