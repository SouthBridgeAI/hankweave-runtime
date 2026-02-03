import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { CheckpointGit } from "../../server/checkpoint-git.js";
import { Logger } from "../../server/utils.js";

// Test directory setup
const _TEST_DIR = path.join(__dirname, "test-checkpoint-files");

// Mock logger
class MockLogger extends Logger {
  logs: Array<{ message: string; level: string }> = [];

  log(message: string, level: "info" | "error" | "debug" = "info"): void {
    this.logs.push({ message, level });
  }

  logSocketTraffic(_socketLogFile: string, _direction: "in" | "out", _data: unknown): void {
    // Mock implementation
  }
}

describe("Checkpoint File Resolution", () => {
  let tempDir: string;
  let checkpointGit: CheckpointGit;
  let mockLogger: MockLogger;

  beforeEach(async () => {
    // Create a temporary directory for testing
    tempDir = path.resolve("tests", "test-area", `temp-file-resolution-${Date.now()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Create mock logger
    mockLogger = new MockLogger("");

    // Initialize CheckpointGit (for tests, use same dir for execution and agent root)
    checkpointGit = new CheckpointGit(tempDir, tempDir, mockLogger);
    await checkpointGit.initialize();
  });

  afterEach(async () => {
    // Clean up
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore errors
    }
  });

  test("should find no files when patterns match nothing", async () => {
    // Add patterns that don't match any files
    await checkpointGit.addPatterns(["*.nonexistent", "missing/**/*"]);

    // Try to commit - should return current HEAD since no files match
    const commitHash = await checkpointGit.commit("Empty commit");
    expect(commitHash).not.toBeNull();

    // Verify no files were added to the commit
    const gitEnv = {
      GIT_DIR: path.join(checkpointGit.getPath(), ".hankweavecheckpoints"),
      GIT_WORK_TREE: tempDir,
    };

    const proc = Bun.spawn(["git", "ls-tree", "-r", "HEAD", "--name-only"], {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });
    const checkpointedFiles = await new Response(proc.stdout).text();
    expect(checkpointedFiles.trim()).toBe("");
  });

  test("should find files matching accumulated patterns", async () => {
    // Create test files
    await fs.promises.mkdir(path.join(tempDir, "src"), { recursive: true });
    await fs.promises.mkdir(path.join(tempDir, "docs"), { recursive: true });

    await fs.promises.writeFile(path.join(tempDir, "src", "main.ts"), "export {}");
    await fs.promises.writeFile(path.join(tempDir, "src", "utils.js"), "module.exports = {}");
    await fs.promises.writeFile(path.join(tempDir, "docs", "README.md"), "# Docs");
    await fs.promises.writeFile(path.join(tempDir, "package.json"), "{}");

    // Add patterns incrementally (simulating multiple codons)
    await checkpointGit.addPatterns(["src/**/*.ts"]);
    await checkpointGit.addPatterns(["*.md", "docs/**/*"]);
    await checkpointGit.addPatterns(["package.json"]);

    // Commit should include files matching all patterns
    const commitHash = await checkpointGit.commit("Test commit");
    expect(commitHash).not.toBeNull();

    // Verify correct files were tracked
    const gitEnv = {
      GIT_DIR: path.join(checkpointGit.getPath(), ".hankweavecheckpoints"),
      GIT_WORK_TREE: tempDir,
    };

    const proc = Bun.spawn(["git", "ls-tree", "-r", "HEAD", "--name-only"], {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });
    const checkpointedFiles = await new Response(proc.stdout).text();

    expect(checkpointedFiles).toContain("src/main.ts");
    expect(checkpointedFiles).toContain("docs/README.md");
    expect(checkpointedFiles).toContain("package.json");
    expect(checkpointedFiles).not.toContain("src/utils.js"); // .js not in patterns
  });

  test("should respect gitignore rules", async () => {
    // Create .gitignore
    await fs.promises.writeFile(path.join(tempDir, ".gitignore"), "node_modules/\n*.log\n.env\n");

    // Create files that should be ignored
    await fs.promises.mkdir(path.join(tempDir, "node_modules"), {
      recursive: true,
    });
    await fs.promises.writeFile(path.join(tempDir, "node_modules", "package.json"), "{}");
    await fs.promises.writeFile(path.join(tempDir, "debug.log"), "log content");
    await fs.promises.writeFile(path.join(tempDir, ".env"), "SECRET=value");

    // Create files that should be tracked
    await fs.promises.writeFile(path.join(tempDir, "src.js"), "code");
    await fs.promises.writeFile(path.join(tempDir, "README.md"), "# Project");

    // Add broad patterns
    await checkpointGit.addPatterns(["**/*"]);

    const commitHash = await checkpointGit.commit("Test gitignore");
    expect(commitHash).not.toBeNull();

    // Verify gitignored files are not tracked
    const gitEnv = {
      GIT_DIR: path.join(checkpointGit.getPath(), ".hankweavecheckpoints"),
      GIT_WORK_TREE: tempDir,
    };

    const proc = Bun.spawn(["git", "ls-tree", "-r", "HEAD", "--name-only"], {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });
    const checkpointedFiles = await new Response(proc.stdout).text();

    expect(checkpointedFiles).toContain("src.js");
    expect(checkpointedFiles).toContain("README.md");
    expect(checkpointedFiles).toContain(".gitignore");
    expect(checkpointedFiles).not.toContain("node_modules/package.json");
    expect(checkpointedFiles).not.toContain("debug.log");
    expect(checkpointedFiles).not.toContain(".env");
  });

  test("should handle pattern overlaps correctly", async () => {
    // Create test files
    await fs.promises.mkdir(path.join(tempDir, "src"), { recursive: true });
    await fs.promises.writeFile(path.join(tempDir, "src", "main.ts"), "export {}");
    await fs.promises.writeFile(path.join(tempDir, "src", "utils.ts"), "export {}");
    await fs.promises.writeFile(path.join(tempDir, "test.ts"), "test");

    // Add overlapping patterns
    await checkpointGit.addPatterns(["src/**/*.ts"]);
    await checkpointGit.addPatterns(["**/*.ts"]); // Overlaps with first pattern
    await checkpointGit.addPatterns(["src/main.ts"]); // Specific file already covered

    const commitHash = await checkpointGit.commit("Test overlaps");
    expect(commitHash).not.toBeNull();

    // Verify all TypeScript files are tracked (no duplicates in git)
    const gitEnv = {
      GIT_DIR: path.join(checkpointGit.getPath(), ".hankweavecheckpoints"),
      GIT_WORK_TREE: tempDir,
    };

    const proc = Bun.spawn(["git", "ls-tree", "-r", "HEAD", "--name-only"], {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });
    const checkpointedFiles = await new Response(proc.stdout).text();

    expect(checkpointedFiles).toContain("src/main.ts");
    expect(checkpointedFiles).toContain("src/utils.ts");
    expect(checkpointedFiles).toContain("test.ts");

    // Count occurrences to ensure no duplicates
    const lines = checkpointedFiles
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
    const uniqueFiles = new Set(lines);
    expect(lines.length).toBe(uniqueFiles.size);
  });

  test("should only stage new/changed files", async () => {
    // Create initial files
    await fs.promises.writeFile(path.join(tempDir, "file1.txt"), "content 1");
    await fs.promises.writeFile(path.join(tempDir, "file2.txt"), "content 2");

    await checkpointGit.addPatterns(["*.txt"]);

    // First commit
    const commit1 = await checkpointGit.commit("First commit");
    expect(commit1).not.toBeNull();

    // Verify both files are in first commit
    const gitEnv = {
      GIT_DIR: path.join(checkpointGit.getPath(), ".hankweavecheckpoints"),
      GIT_WORK_TREE: tempDir,
    };

    let proc = Bun.spawn(["git", "ls-tree", "-r", "HEAD", "--name-only"], {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });
    const checkpointedFiles = await new Response(proc.stdout).text();
    expect(checkpointedFiles).toContain("file1.txt");
    expect(checkpointedFiles).toContain("file2.txt");

    // Add a new file and modify existing
    await fs.promises.writeFile(path.join(tempDir, "file3.txt"), "content 3");
    await fs.promises.writeFile(path.join(tempDir, "file1.txt"), "modified content 1");

    // Second commit should only include new/changed files
    const commit2 = await checkpointGit.commit("Second commit");
    expect(commit2).not.toBeNull();
    expect(commit2).not.toBe(commit1);

    // Check what changed in the second commit
    proc = Bun.spawn(["git", "diff", "--name-only", `${commit1}..${commit2}`], {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });
    const changedFiles = await new Response(proc.stdout).text();
    expect(changedFiles).toContain("file1.txt"); // Modified
    expect(changedFiles).toContain("file3.txt"); // New
    expect(changedFiles).not.toContain("file2.txt"); // Unchanged
  });

  test("should handle nested directory patterns", async () => {
    // Create complex directory structure
    await fs.promises.mkdir(path.join(tempDir, "src", "components", "ui"), {
      recursive: true,
    });
    await fs.promises.mkdir(path.join(tempDir, "src", "utils", "helpers"), {
      recursive: true,
    });
    await fs.promises.mkdir(path.join(tempDir, "tests", "unit"), {
      recursive: true,
    });
    await fs.promises.mkdir(path.join(tempDir, "docs", "api"), {
      recursive: true,
    });

    // Create files at various levels
    await fs.promises.writeFile(path.join(tempDir, "src", "index.ts"), "export {}");
    await fs.promises.writeFile(path.join(tempDir, "src", "components", "Button.tsx"), "export {}");
    await fs.promises.writeFile(
      path.join(tempDir, "src", "components", "ui", "Modal.tsx"),
      "export {}",
    );
    await fs.promises.writeFile(
      path.join(tempDir, "src", "utils", "helpers", "format.ts"),
      "export {}",
    );
    await fs.promises.writeFile(path.join(tempDir, "tests", "unit", "test.spec.ts"), "test");
    await fs.promises.writeFile(path.join(tempDir, "docs", "api", "README.md"), "# API");
    await fs.promises.writeFile(path.join(tempDir, "package.json"), "{}");

    // Add nested patterns
    await checkpointGit.addPatterns([
      "src/**/*.ts",
      "src/**/*.tsx",
      "tests/**/*.spec.ts",
      "docs/**/*.md",
      "*.json",
    ]);

    const commitHash = await checkpointGit.commit("Nested structure");
    expect(commitHash).not.toBeNull();

    // Verify all expected files are tracked
    const gitEnv = {
      GIT_DIR: path.join(checkpointGit.getPath(), ".hankweavecheckpoints"),
      GIT_WORK_TREE: tempDir,
    };

    const proc = Bun.spawn(["git", "ls-tree", "-r", "HEAD", "--name-only"], {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });
    const checkpointedFiles = await new Response(proc.stdout).text();

    expect(checkpointedFiles).toContain("src/index.ts");
    expect(checkpointedFiles).toContain("src/components/Button.tsx");
    expect(checkpointedFiles).toContain("src/components/ui/Modal.tsx");
    expect(checkpointedFiles).toContain("src/utils/helpers/format.ts");
    expect(checkpointedFiles).toContain("tests/unit/test.spec.ts");
    expect(checkpointedFiles).toContain("docs/api/README.md");
    expect(checkpointedFiles).toContain("package.json");
  });

  test("should handle empty directories gracefully", async () => {
    // Create empty directories
    await fs.promises.mkdir(path.join(tempDir, "empty1"), { recursive: true });
    await fs.promises.mkdir(path.join(tempDir, "empty2", "nested"), {
      recursive: true,
    });

    // Add patterns that would match files in these directories
    await checkpointGit.addPatterns(["empty1/**/*", "empty2/**/*"]);

    // Should return current HEAD since no files match
    const commitHash = await checkpointGit.commit("Empty directories");
    expect(commitHash).not.toBeNull();

    // Verify no files were added
    const gitEnv = {
      GIT_DIR: path.join(checkpointGit.getPath(), ".hankweavecheckpoints"),
      GIT_WORK_TREE: tempDir,
    };

    const proc = Bun.spawn(["git", "ls-tree", "-r", "HEAD", "--name-only"], {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });
    const checkpointedFiles = await new Response(proc.stdout).text();
    expect(checkpointedFiles.trim()).toBe("");
  });

  test("should handle special characters in filenames", async () => {
    // Create files with special characters
    await fs.promises.writeFile(path.join(tempDir, "file with spaces.txt"), "content");
    await fs.promises.writeFile(path.join(tempDir, "file-with-dashes.txt"), "content");
    await fs.promises.writeFile(path.join(tempDir, "file_with_underscores.txt"), "content");
    await fs.promises.writeFile(path.join(tempDir, "file.with.dots.txt"), "content");

    await checkpointGit.addPatterns(["*.txt"]);

    const commitHash = await checkpointGit.commit("Special characters");
    expect(commitHash).not.toBeNull();

    // Verify all files with special characters are tracked
    const gitEnv = {
      GIT_DIR: path.join(checkpointGit.getPath(), ".hankweavecheckpoints"),
      GIT_WORK_TREE: tempDir,
    };

    const proc = Bun.spawn(["git", "ls-tree", "-r", "HEAD", "--name-only"], {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });
    const checkpointedFiles = await new Response(proc.stdout).text();

    expect(checkpointedFiles).toContain("file with spaces.txt");
    expect(checkpointedFiles).toContain("file-with-dashes.txt");
    expect(checkpointedFiles).toContain("file_with_underscores.txt");
    expect(checkpointedFiles).toContain("file.with.dots.txt");
  });

  test("should clear patterns correctly", async () => {
    // Add some patterns
    await checkpointGit.addPatterns(["*.ts", "*.js"]);

    // Create files
    await fs.promises.writeFile(path.join(tempDir, "test.ts"), "typescript");
    await fs.promises.writeFile(path.join(tempDir, "test.js"), "javascript");
    await fs.promises.writeFile(path.join(tempDir, "test.py"), "python");

    // First commit should include .ts and .js files
    const commit1 = await checkpointGit.commit("First commit");
    expect(commit1).not.toBeNull();

    // Clear patterns and add new ones
    checkpointGit.clearPatterns();
    await checkpointGit.addPatterns(["*.py"]);

    // Create new Python file
    await fs.promises.writeFile(path.join(tempDir, "new.py"), "new python");

    // Second commit should only include .py files
    const commit2 = await checkpointGit.commit("Second commit");
    expect(commit2).not.toBeNull();

    // Check what changed in the second commit
    const gitEnv = {
      GIT_DIR: path.join(checkpointGit.getPath(), ".hankweavecheckpoints"),
      GIT_WORK_TREE: tempDir,
    };

    const proc = Bun.spawn(["git", "diff", "--name-only", `${commit1}..${commit2}`], {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });
    const changedFiles = await new Response(proc.stdout).text();
    expect(changedFiles).toContain("new.py");
    expect(changedFiles).not.toContain("test.ts");
    expect(changedFiles).not.toContain("test.js");
  });
});
