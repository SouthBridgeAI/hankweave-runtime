import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { UnifiedFileResolver } from "../../server/file-resolver";

describe("UnifiedFileResolver - Edge Cases", () => {
  let tempDir: string;
  let resolver: UnifiedFileResolver;
  let gitRepo: string;

  beforeEach(async () => {
    tempDir = path.resolve("tests", "test-area", `temp-resolver-edge-${Date.now()}`);
    gitRepo = path.join(tempDir, "git-test");
    await fs.promises.mkdir(tempDir, { recursive: true });
    await fs.promises.mkdir(gitRepo, { recursive: true });

    // Initialize git repo for cross-checking
    execSync("git init", { cwd: gitRepo });
    execSync('git config user.name "Test"', { cwd: gitRepo });
    execSync('git config user.email "test@example.com"', { cwd: gitRepo });

    resolver = new UnifiedFileResolver();
  });

  afterEach(async () => {
    resolver.clearCache();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  describe("Complex Negation Patterns", () => {
    test("handles nested negation with directories", async () => {
      // Create structure
      await fs.promises.mkdir(path.join(tempDir, "build/keep"), {
        recursive: true,
      });
      await fs.promises.mkdir(path.join(tempDir, "build/temp"), {
        recursive: true,
      });
      await fs.promises.writeFile(path.join(tempDir, "build/output.js"), "output");
      await fs.promises.writeFile(path.join(tempDir, "build/keep/important.js"), "important");
      await fs.promises.writeFile(path.join(tempDir, "build/temp/temp.js"), "temp");

      // Complex gitignore
      await fs.promises.writeFile(
        path.join(tempDir, ".gitignore"),
        "build/\n!build/keep/\nbuild/keep/temp/\n",
      );

      const files = await resolver.resolveFiles(tempDir, ["**/*.js"]);

      // Git actually ignores ALL files in build/, even with negation
      expect(files.sort()).toEqual([]);
    });

    test("cross-check: negation patterns match git behavior", async () => {
      // Setup in git repo
      await fs.promises.mkdir(path.join(gitRepo, "src"), { recursive: true });
      await fs.promises.writeFile(path.join(gitRepo, "src/main.js"), "main");
      await fs.promises.writeFile(path.join(gitRepo, "src/test.js"), "test");
      await fs.promises.writeFile(path.join(gitRepo, "src/important.js"), "important");

      const gitignoreContent = "src/*.js\n!src/important.js\n";
      await fs.promises.writeFile(path.join(gitRepo, ".gitignore"), gitignoreContent);

      // Our resolver
      const ourFiles = await resolver.resolveFiles(gitRepo, ["**/*.js"]);

      // Git's behavior - check what git would track
      execSync("git add .", { cwd: gitRepo });
      const gitTracked = execSync("git ls-files", {
        cwd: gitRepo,
        encoding: "utf-8",
      })
        .trim()
        .split("\n")
        .filter((f) => f.endsWith(".js"));

      expect(ourFiles.sort()).toEqual(gitTracked.sort());
    });
  });

  describe("Directory Pattern Edge Cases", () => {
    test("distinguishes between dir/, dir, and dir/**", async () => {
      await fs.promises.mkdir(path.join(tempDir, "logs/sub"), {
        recursive: true,
      });
      await fs.promises.writeFile(path.join(tempDir, "logs.txt"), "file");
      await fs.promises.writeFile(path.join(tempDir, "logs/app.log"), "log");
      await fs.promises.writeFile(path.join(tempDir, "logs/sub/debug.log"), "debug");

      // Test different patterns
      const tests = [
        { pattern: "logs", expected: ["logs.txt"] }, // matches file named 'logs'
        { pattern: "logs/", expected: ["logs.txt"] }, // dir pattern, we convert to logs/**
        { pattern: "logs/**", expected: ["logs.txt"] }, // explicit wildcard
      ];

      for (const { pattern, expected } of tests) {
        await fs.promises.writeFile(path.join(tempDir, ".gitignore"), pattern);
        resolver.clearCache(tempDir);
        const files = await resolver.resolveFiles(tempDir, ["**/*"]);
        expect(files.filter((f) => !f.startsWith(".git")).sort()).toEqual(expected.sort());
      }
    });
  });

  describe("Special Characters in Filenames", () => {
    test("handles files with spaces and special characters", async () => {
      const specialFiles = [
        "my file.txt",
        "file[1].txt",
        "file@2.txt",
        "file#3.txt",
        "file$4.txt",
        "file&5.txt",
        "file(6).txt",
        "file{7}.txt",
        "café.txt",
        "文件.txt",
        "🚀.txt",
      ];

      for (const filename of specialFiles) {
        await fs.promises.writeFile(path.join(tempDir, filename), "content");
      }

      const files = await resolver.resolveFiles(tempDir, ["*.txt"]);
      expect(files.sort()).toEqual(specialFiles.sort());
    });

    test("gitignore patterns with special characters", async () => {
      await fs.promises.writeFile(path.join(tempDir, "file[1].txt"), "content");
      await fs.promises.writeFile(path.join(tempDir, "file[2].txt"), "content");
      await fs.promises.writeFile(path.join(tempDir, "file3.txt"), "content");

      // Escape special chars in gitignore
      await fs.promises.writeFile(path.join(tempDir, ".gitignore"), "file\\[1\\].txt\n");

      const files = await resolver.resolveFiles(tempDir, ["*.txt"]);
      expect(files.sort()).toEqual(["file3.txt", "file[2].txt"]);
    });
  });

  describe("Symlink Handling", () => {
    test("ignores symlinked files", async () => {
      await fs.promises.writeFile(path.join(tempDir, "real.txt"), "real");
      await fs.promises.writeFile(path.join(tempDir, "target.txt"), "target");

      // Create symlink
      await fs.promises.symlink(path.join(tempDir, "target.txt"), path.join(tempDir, "link.txt"));

      const files = await resolver.resolveFiles(tempDir, ["*.txt"]);

      // Should include real files but not symlink
      expect(files.sort()).toEqual(["real.txt", "target.txt"]);
    });

    test("ignores symlinked directories", async () => {
      await fs.promises.mkdir(path.join(tempDir, "real-dir"));
      await fs.promises.mkdir(path.join(tempDir, "target-dir"));
      await fs.promises.writeFile(path.join(tempDir, "real-dir/file.txt"), "real");
      await fs.promises.writeFile(path.join(tempDir, "target-dir/file.txt"), "target");

      // Create directory symlink
      await fs.promises.symlink(
        path.join(tempDir, "target-dir"),
        path.join(tempDir, "link-dir"),
        "dir",
      );

      const files = await resolver.resolveFiles(tempDir, ["**/*.txt"]);

      // Should not follow symlinked directory
      expect(files.sort()).toEqual(["real-dir/file.txt", "target-dir/file.txt"]);
    });
  });

  describe("Deeply Nested Structures", () => {
    test("handles 10+ levels of nesting efficiently", async () => {
      // Create deep structure
      let currentPath = tempDir;
      for (let i = 0; i < 12; i++) {
        currentPath = path.join(currentPath, `level${i}`);
        await fs.promises.mkdir(currentPath, { recursive: true });
        await fs.promises.writeFile(path.join(currentPath, `file${i}.txt`), `content${i}`);
      }

      const start = Date.now();
      const files = await resolver.resolveFiles(tempDir, ["**/*.txt"]);
      const duration = Date.now() - start;

      expect(files.length).toBe(12);
      expect(duration).toBeLessThan(1000); // Should complete in under 1 second
    });
  });

  describe("Multiple .gitignore Files", () => {
    test("correctly merges rules from multiple gitignore files", async () => {
      // Create structure with multiple .gitignore files
      await fs.promises.mkdir(path.join(tempDir, "src/components"), {
        recursive: true,
      });
      await fs.promises.mkdir(path.join(tempDir, "src/utils"), {
        recursive: true,
      });

      // Files
      await fs.promises.writeFile(path.join(tempDir, "root.log"), "log");
      await fs.promises.writeFile(path.join(tempDir, "src/debug.log"), "log");
      await fs.promises.writeFile(path.join(tempDir, "src/main.js"), "js");
      await fs.promises.writeFile(path.join(tempDir, "src/components/component.test.js"), "js");
      await fs.promises.writeFile(path.join(tempDir, "src/components/component.tsx"), "tsx");
      await fs.promises.writeFile(path.join(tempDir, "src/utils/helper.js"), "js");
      await fs.promises.writeFile(path.join(tempDir, "src/utils/temp.js"), "js");

      // Root .gitignore
      await fs.promises.writeFile(path.join(tempDir, ".gitignore"), "*.log\n");

      // src/.gitignore
      await fs.promises.writeFile(path.join(tempDir, "src/.gitignore"), "*.test.js\n");

      // src/utils/.gitignore
      await fs.promises.writeFile(path.join(tempDir, "src/utils/.gitignore"), "temp.js\n");

      const files = await resolver.resolveFiles(tempDir, ["**/*"]);
      const jsFiles = files.filter((f) => f.endsWith(".js") || f.endsWith(".tsx"));

      expect(jsFiles.sort()).toEqual([
        "src/components/component.tsx",
        "src/main.js",
        "src/utils/helper.js",
      ]);
    });

    test("cross-check: nested gitignore behavior matches git", async () => {
      // Setup in git repo
      await fs.promises.mkdir(path.join(gitRepo, "src/test"), {
        recursive: true,
      });

      await fs.promises.writeFile(path.join(gitRepo, "app.js"), "app");
      await fs.promises.writeFile(path.join(gitRepo, "src/main.js"), "main");
      await fs.promises.writeFile(path.join(gitRepo, "src/test.js"), "test");
      await fs.promises.writeFile(path.join(gitRepo, "src/test/spec.js"), "spec");

      await fs.promises.writeFile(path.join(gitRepo, ".gitignore"), "*.log\ntemp/\n");
      await fs.promises.writeFile(path.join(gitRepo, "src/.gitignore"), "test.js\n");

      // Our resolver
      const ourFiles = await resolver.resolveFiles(gitRepo, ["**/*.js"]);

      // Git's behavior
      execSync("git add -A", { cwd: gitRepo });
      const gitTracked = execSync("git ls-files", {
        cwd: gitRepo,
        encoding: "utf-8",
      })
        .trim()
        .split("\n")
        .filter((f) => f.endsWith(".js"));

      expect(ourFiles.sort()).toEqual(gitTracked.sort());
    });
  });

  describe("Pattern Escaping", () => {
    test("handles escaped characters in gitignore patterns", async () => {
      await fs.promises.writeFile(path.join(tempDir, "#comment.txt"), "file");
      await fs.promises.writeFile(path.join(tempDir, "!important.txt"), "file");
      await fs.promises.writeFile(path.join(tempDir, "normal.txt"), "file");

      // Escape special characters
      await fs.promises.writeFile(
        path.join(tempDir, ".gitignore"),
        "\\#comment.txt\n\\!important.txt\n",
      );

      const files = await resolver.resolveFiles(tempDir, ["*.txt"]);
      expect(files).toEqual(["normal.txt"]);
    });
  });

  describe("Performance with Large .gitignore", () => {
    test("handles gitignore with 1000+ rules efficiently", async () => {
      // Create many files
      for (let i = 0; i < 100; i++) {
        await fs.promises.writeFile(path.join(tempDir, `file${i}.txt`), `content${i}`);
      }

      // Create large .gitignore
      const rules: string[] = [];
      for (let i = 0; i < 1000; i++) {
        rules.push(`# Rule ${i}`);
        rules.push(`pattern${i}*`);
        rules.push(`!important${i}.txt`);
      }
      await fs.promises.writeFile(path.join(tempDir, ".gitignore"), rules.join("\n"));

      const start = Date.now();
      const files = await resolver.resolveFiles(tempDir, ["*.txt"]);
      const duration = Date.now() - start;

      expect(files.length).toBe(100);
      expect(duration).toBeLessThan(500); // Should handle large gitignore efficiently
    });
  });

  describe("Hidden Files and Directories", () => {
    test("includes hidden files when matched by pattern", async () => {
      await fs.promises.mkdir(path.join(tempDir, ".hidden"), {
        recursive: true,
      });
      await fs.promises.writeFile(path.join(tempDir, ".env"), "env");
      await fs.promises.writeFile(path.join(tempDir, ".hidden/secret.txt"), "secret");
      await fs.promises.writeFile(path.join(tempDir, "visible.txt"), "visible");

      const files = await resolver.resolveFiles(tempDir, ["**/*"]);

      expect(files).toContain(".env");
      expect(files).toContain(".hidden/secret.txt");
      expect(files).toContain("visible.txt");
    });

    test("gitignore rules apply to hidden files", async () => {
      await fs.promises.writeFile(path.join(tempDir, ".env"), "env");
      await fs.promises.writeFile(path.join(tempDir, ".env.local"), "local");
      await fs.promises.writeFile(path.join(tempDir, ".gitignore"), ".env.local\n");

      const files = await resolver.resolveFiles(tempDir, [".*"]);

      expect(files).toContain(".env");
      expect(files).not.toContain(".env.local");
    });
  });

  describe("Cross-platform Path Handling", () => {
    test("normalizes paths consistently across platforms", async () => {
      // Create files with both forward and backslash in names (where allowed)
      await fs.promises.mkdir(path.join(tempDir, "src", "components"), {
        recursive: true,
      });
      await fs.promises.writeFile(path.join(tempDir, "src", "components", "App.tsx"), "app");

      const files = await resolver.resolveFiles(tempDir, ["**/*.tsx"]);

      // Should always use forward slashes
      expect(files[0]).toBe("src/components/App.tsx");
      expect(files[0]).not.toContain("\\");
    });
  });

  describe("Invalid Pattern Handling", () => {
    test("handles malformed patterns gracefully", async () => {
      await fs.promises.writeFile(path.join(tempDir, "file.txt"), "content");

      // Invalid patterns in .gitignore
      await fs.promises.writeFile(path.join(tempDir, ".gitignore"), "[[\n**[[\n\\x\n");

      // Should not throw, should handle gracefully
      const files = await resolver.resolveFiles(tempDir, ["*.txt"]);
      expect(files).toContain("file.txt");
    });
  });
});
