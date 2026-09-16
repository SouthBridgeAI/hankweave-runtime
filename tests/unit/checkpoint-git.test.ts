import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CheckpointGit,
  CheckpointNotFoundError,
  CheckpointStorageError,
} from "../../server/checkpoint-git";
import { Logger } from "../../server/utils";

describe("CheckpointGit", () => {
  let tempDir: string;
  let checkpointGit: CheckpointGit;
  let logger: Logger;

  beforeAll(async () => {
    // Check if git is available
    try {
      const proc = Bun.spawn(["git", "--version"]);
      await proc.exited;
    } catch (_error) {
      console.error("Git is not available in test environment");
      throw new Error("Git is required for CheckpointGit tests");
    }
  });

  beforeEach(async () => {
    // Real git repos in the OS tmpdir, NOT tests/test-area: this repo lives
    // in a Dropbox-synced tree, and the sync daemon touching .git internals
    // mid-commit made commit() return null across 25 tests in one parallel
    // sweep. os.tmpdir() is never synced. (test-area also carries a
    // com.dropbox.ignored xattr now, but tmpdir makes these tests safe on
    // any synced checkout, not just this machine.)
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hankweave-checkpoint-test-"));

    // Create a mock logger
    const logPath = path.join(tempDir, "test.log");
    logger = new Logger(logPath);

    // Initialize CheckpointGit (for tests, use same dir for execution and agent root)
    checkpointGit = new CheckpointGit(tempDir, tempDir, logger);
  });

  afterEach(async () => {
    // Clean up
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("isInitialized returns false before initialization", () => {
    expect(checkpointGit.isInitialized()).toBe(false);
  });

  test("isInitialized returns true after initialization", async () => {
    await checkpointGit.initialize();
    expect(checkpointGit.isInitialized()).toBe(true);
  });

  test("getPath returns correct checkpoint repository path", () => {
    const expectedPath = path.join(tempDir, ".hankweave", "checkpoints");
    expect(checkpointGit.getPath()).toBe(expectedPath);
  });

  test("initialize creates git repository", async () => {
    await checkpointGit.initialize();

    const gitDir = path.join(checkpointGit.getPath(), ".hankweavecheckpoints");
    expect(fs.existsSync(gitDir)).toBe(true);
  });

  test("addPatterns stores patterns for later use", async () => {
    await checkpointGit.initialize();

    const patterns = ["*.log", "*.tmp"];
    await checkpointGit.addPatterns(patterns);

    // Create test files matching the patterns
    await fs.promises.writeFile(path.join(tempDir, "test.log"), "log content");
    await fs.promises.writeFile(path.join(tempDir, "test.tmp"), "tmp content");
    await fs.promises.writeFile(path.join(tempDir, "test.txt"), "txt content");

    // Commit should only add files matching the patterns
    const commitHash = await checkpointGit.commit("Test commit");
    expect(commitHash).not.toBeNull();

    // Verify only pattern-matching files were tracked
    const gitEnv = {
      GIT_DIR: path.join(checkpointGit.getPath(), ".hankweavecheckpoints"),
      GIT_WORK_TREE: tempDir,
    };

    const proc = Bun.spawn(["git", "ls-tree", "-r", "HEAD", "--name-only"], {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });
    const checkpointedFiles = await new Response(proc.stdout).text();

    expect(checkpointedFiles).toContain("test.log");
    expect(checkpointedFiles).toContain("test.tmp");
    expect(checkpointedFiles).not.toContain("test.txt");
  });

  test("commit creates a commit with message", async () => {
    await checkpointGit.initialize();

    // Create a test file
    const testFile = path.join(tempDir, "test.txt");
    await fs.promises.writeFile(testFile, "test content");

    // Add pattern and create commit
    await checkpointGit.addPatterns(["*.txt"]);
    const commitHash = await checkpointGit.commit("Test commit");

    expect(commitHash).not.toBeNull();
    expect(commitHash).toMatch(/^[a-f0-9]{7,}$/);
  });

  test("commit creates empty commit when no changes", async () => {
    await checkpointGit.initialize();

    // Add patterns first, but don't create any files
    await checkpointGit.addPatterns(["*.txt"]);

    // Get current HEAD before commit
    const gitEnv = {
      GIT_DIR: path.join(checkpointGit.getPath(), ".hankweavecheckpoints"),
      GIT_WORK_TREE: tempDir,
    };

    const proc1 = Bun.spawn(["git", "rev-parse", "HEAD"], {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });
    const headBefore = await new Response(proc1.stdout).text();

    // Create empty commit - should create a new commit even with no changes
    const commitHash = await checkpointGit.commit("Empty commit");

    expect(commitHash).not.toBeNull();
    expect(commitHash).toMatch(/^[a-f0-9]{7,}$/);

    // Verify it's different from the previous HEAD (new commit created)
    expect(commitHash).not.toBe(headBefore.trim());

    // Verify it's now the current HEAD
    const proc2 = Bun.spawn(["git", "rev-parse", "HEAD"], {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });
    const headAfter = await new Response(proc2.stdout).text();
    expect(commitHash).toBe(headAfter.trim());
  });

  test("commit on branch creates and switches branch", async () => {
    await checkpointGit.initialize();

    // Create a test file
    const testFile = path.join(tempDir, "test.txt");
    await fs.promises.writeFile(testFile, "test content");

    // Add pattern and create commit on branch
    await checkpointGit.addPatterns(["*.txt"]);
    const commitHash = await checkpointGit.commit("Branch commit", {
      branch: "test-branch",
    });

    expect(commitHash).not.toBeNull();

    // To check git state, we need to use the same env vars that CheckpointGit uses
    const gitEnv = {
      GIT_DIR: path.join(checkpointGit.getPath(), ".hankweavecheckpoints"),
      GIT_WORK_TREE: tempDir,
    };

    // Check that branch exists
    const proc2 = Bun.spawn(["git", "branch"], {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });
    const branches = await new Response(proc2.stdout).text();
    expect(branches).toContain("test-branch");
  });

  test("commit with branch option restores original branch", async () => {
    await checkpointGit.initialize();

    // Determine original branch (should be main on fresh repo)
    const originalBranch = await checkpointGit.getCurrentBranch();
    expect(originalBranch).toBe("main");

    // Make a change and commit on a feature branch
    await fs.promises.writeFile(path.join(tempDir, "b.txt"), "b1");
    await checkpointGit.addPatterns(["*.txt"]);
    const sha = await checkpointGit.commit("feature commit", {
      branch: "feature-x",
    });
    expect(sha).toBeTruthy();

    const currentAfter = await checkpointGit.getCurrentBranch();
    // Should restore original branch after commit with branch option
    expect(currentAfter).toBe("main");
  });

  test("handles complex patterns correctly", async () => {
    await checkpointGit.initialize();

    // Create nested directory structure
    await fs.promises.mkdir(path.join(tempDir, "src", "components"), {
      recursive: true,
    });
    await fs.promises.mkdir(path.join(tempDir, "src", "utils"), {
      recursive: true,
    });
    await fs.promises.writeFile(path.join(tempDir, "src", "components", "Button.tsx"), "export {}");
    await fs.promises.writeFile(path.join(tempDir, "src", "utils", "helper.ts"), "export {}");
    await fs.promises.writeFile(path.join(tempDir, "README.md"), "# Test");

    // Add patterns
    await checkpointGit.addPatterns(["src/**/*.tsx", "src/**/*.ts", "*.md"]);

    // Create commit
    const commitHash = await checkpointGit.commit("Add files");
    expect(commitHash).not.toBeNull();

    // Verify files were tracked
    const gitEnv = {
      GIT_DIR: path.join(checkpointGit.getPath(), ".hankweavecheckpoints"),
      GIT_WORK_TREE: tempDir,
    };

    const proc = Bun.spawn(["git", "ls-tree", "-r", "HEAD", "--name-only"], {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });
    const checkpointedFiles = await new Response(proc.stdout).text();

    expect(checkpointedFiles).toContain("src/components/Button.tsx");
    expect(checkpointedFiles).toContain("src/utils/helper.ts");
    expect(checkpointedFiles).toContain("README.md");
  });

  test("switchToBranch switches to existing branch", async () => {
    await checkpointGit.initialize();

    // Create a test file and commit on a new branch
    const testFile = path.join(tempDir, "test.txt");
    await fs.promises.writeFile(testFile, "test content");
    await checkpointGit.addPatterns(["*.txt"]);

    // Create commit on new branch
    await checkpointGit.commit("Branch commit", { branch: "test-branch" });

    // Switch to test-branch
    await checkpointGit.switchToBranch("test-branch");

    // Verify we're on test-branch
    const gitEnv = {
      GIT_DIR: path.join(checkpointGit.getPath(), ".hankweavecheckpoints"),
      GIT_WORK_TREE: tempDir,
    };

    const proc = Bun.spawn(["git", "branch", "--show-current"], {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });
    const currentBranch = await new Response(proc.stdout).text();
    expect(currentBranch.trim()).toBe("test-branch");
  });

  test("switchToBranch creates new branch if it doesn't exist", async () => {
    await checkpointGit.initialize();

    // Try to switch to non-existent branch - should create it
    await checkpointGit.switchToBranch("new-feature-branch");

    // Should now be on the new branch
    const gitEnv = {
      GIT_DIR: path.join(checkpointGit.getPath(), ".hankweavecheckpoints"),
      GIT_WORK_TREE: tempDir,
    };

    const proc = Bun.spawn(["git", "branch", "--show-current"], {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });
    const currentBranch = await new Response(proc.stdout).text();
    expect(currentBranch.trim()).toBe("new-feature-branch");

    // Verify the branch exists in the list
    const proc2 = Bun.spawn(["git", "branch"], {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });
    const branches = await new Response(proc2.stdout).text();
    expect(branches).toContain("new-feature-branch");
  });

  test("resetToCheckpoint resets to specific commit", async () => {
    await checkpointGit.initialize();

    // Create first commit
    const file1 = path.join(tempDir, "file1.txt");
    await fs.promises.writeFile(file1, "content 1");
    await checkpointGit.addPatterns(["*.txt"]);
    const commit1 = await checkpointGit.commit("First commit");

    // Create second commit
    const file2 = path.join(tempDir, "file2.txt");
    await fs.promises.writeFile(file2, "content 2");
    await checkpointGit.commit("Second commit");

    // Verify both files exist
    expect(fs.existsSync(file1)).toBe(true);
    expect(fs.existsSync(file2)).toBe(true);

    // Reset to first commit
    expect(commit1).not.toBeNull();
    if (commit1) {
      await checkpointGit.resetToCheckpoint(commit1);
    }

    // Verify file2 is gone but file1 remains
    expect(fs.existsSync(file1)).toBe(true);
    expect(fs.existsSync(file2)).toBe(false);
  });

  test("resetToCheckpoint throws for non-existent SHA", async () => {
    await checkpointGit.initialize();

    // Try to reset to non-existent SHA
    await expect(checkpointGit.resetToCheckpoint("nonexistent123")).rejects.toThrow(
      "Checkpoint nonexistent123 not found in repository",
    );
  });

  test("resetToCheckpoint throws when not initialized", async () => {
    await expect(checkpointGit.resetToCheckpoint("abc123")).rejects.toThrow(
      "Git repository not initialized",
    );
  });

  test("getAllCheckpoints returns full history across branches", async () => {
    await checkpointGit.initialize();

    // Track txt files
    await checkpointGit.addPatterns(["*.txt"]);

    // Two commits on main
    const mainFile = path.join(tempDir, "main.txt");
    await fs.promises.writeFile(mainFile, "one");
    const c1 = await checkpointGit.commit("main: first");

    await fs.promises.writeFile(mainFile, "two");
    const c2 = await checkpointGit.commit("main: second");

    // Two commits on run branch
    const featureFile1 = path.join(tempDir, "feature1.txt");
    await fs.promises.writeFile(featureFile1, "f1");
    const f1 = await checkpointGit.commit("feature: first", {
      branch: "run-1757489464604-eicnq",
    });

    const featureFile2 = path.join(tempDir, "feature2.txt");
    await fs.promises.writeFile(featureFile2, "f2");
    const f2 = await checkpointGit.commit("feature: second", {
      branch: "run-1757489464604-eicnq",
    });

    // Sanity: hashes should exist
    expect(c1).toBeTruthy();
    expect(c2).toBeTruthy();
    expect(f1).toBeTruthy();
    expect(f2).toBeTruthy();

    // Now fetch all checkpoints
    const checkpoints = await checkpointGit.getAllCheckpoints();

    // Expect initial empty commit + 4 real commits = 5 total
    expect(checkpoints.length).toBe(5);

    const entries = checkpoints.map((checkpoint) => ({
      message: checkpoint.message,
      branch: checkpoint.branch,
    }));

    expect(entries).toContainEqual({
      message: "feature: second",
      branch: "run-1757489464604-eicnq",
    });
    expect(entries).toContainEqual({
      message: "feature: first",
      branch: "run-1757489464604-eicnq",
    });
    expect(entries).toContainEqual({
      message: "main: second",
      branch: "main",
    });
    expect(entries).toContainEqual({
      message: "main: first",
      branch: "main",
    });
    expect(entries).toContainEqual({
      message: "Initial checkpoint setup",
      branch: "main",
    });
  }, 15000);

  test("switchToBranch throws when not initialized", async () => {
    await expect(checkpointGit.switchToBranch("some-branch")).rejects.toThrow(
      "Git repository not initialized",
    );
  });

  test("switchToBranch can switch back and forth between branches", async () => {
    await checkpointGit.initialize();

    // Create and switch to a new branch
    await checkpointGit.switchToBranch("feature-x");
    let currentBranch = await checkpointGit.getCurrentBranch();
    expect(currentBranch).toBe("feature-x");

    // Switch back to main
    await checkpointGit.switchToBranch("main");
    currentBranch = await checkpointGit.getCurrentBranch();
    expect(currentBranch).toBe("main");

    // Switch back to feature-x (existing branch)
    await checkpointGit.switchToBranch("feature-x");
    currentBranch = await checkpointGit.getCurrentBranch();
    expect(currentBranch).toBe("feature-x");
  });

  test("getAllCheckpointShas returns SHAs across branches", async () => {
    await checkpointGit.initialize();

    // Track txt files
    await checkpointGit.addPatterns(["*.txt"]);

    // Two commits on main
    await fs.promises.writeFile(path.join(tempDir, "m.txt"), "m1");
    const m1 = await checkpointGit.commit("m1");
    await fs.promises.writeFile(path.join(tempDir, "m.txt"), "m2");
    const m2 = await checkpointGit.commit("m2");

    // Two commits on feature branch
    await fs.promises.writeFile(path.join(tempDir, "f1.txt"), "f1");
    const f1 = await checkpointGit.commit("f1", { branch: "feat-a" });
    await fs.promises.writeFile(path.join(tempDir, "f2.txt"), "f2");
    const f2 = await checkpointGit.commit("f2", { branch: "feat-a" });

    // Sanity
    expect(m1 && m2 && f1 && f2).toBeTruthy();

    // Collect SHAs via API
    const shas = await checkpointGit.getAllCheckpointShas();

    // Should include initial + all four commits
    // We don't assert exact size as there is an initial empty commit; just inclusion
    expect(m1 && shas.has(m1)).toBe(true);
    expect(m2 && shas.has(m2)).toBe(true);
    expect(f1 && shas.has(f1)).toBe(true);
    expect(f2 && shas.has(f2)).toBe(true);
  });

  test("initialize detects and reuses existing repository", async () => {
    // First initialization
    await checkpointGit.initialize();

    // Create a commit to mark the repository
    await fs.promises.writeFile(path.join(tempDir, "marker.txt"), "test");
    await checkpointGit.addPatterns(["*.txt"]);
    const firstCommit = await checkpointGit.commit("Marker commit");

    // Create a new CheckpointGit instance for the same directory
    const checkpointGit2 = new CheckpointGit(tempDir, tempDir, logger);
    await checkpointGit2.initialize();

    // Verify it can see the existing commit
    const gitEnv = {
      GIT_DIR: path.join(checkpointGit2.getPath(), ".hankweavecheckpoints"),
      GIT_WORK_TREE: tempDir,
    };

    const proc = Bun.spawn(["git", "log", "--oneline", "-1"], {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });
    const lastCommit = await new Response(proc.stdout).text();

    expect(lastCommit).toContain("Marker commit");
    if (firstCommit) {
      expect(lastCommit).toContain(firstCommit.substring(0, 7));
    }
  });

  test("handles concurrent git operations gracefully", async () => {
    await checkpointGit.initialize();
    await checkpointGit.addPatterns(["*.txt"]);

    // Run multiple commit operations in parallel to trigger race condition
    // This simulates what happens during abrupt termination where git operations overlap
    const parallelCommits = [];
    for (let i = 0; i < 5; i++) {
      // Modify files and commit in parallel without waiting
      const commitOp = (async () => {
        // Each operation modifies a file and tries to commit
        await fs.promises.writeFile(
          path.join(tempDir, `test${i}.txt`),
          `modified content ${i} - ${Date.now()}`,
        );
        return checkpointGit.commit(`Parallel commit ${i}`);
      })();
      parallelCommits.push(commitOp);
    }

    // Wait for all operations to complete
    const results = await Promise.allSettled(parallelCommits);

    // Count successes and failures
    let failureCount = 0;
    let indexLockErrors = 0;

    results.forEach((result) => {
      if (result.status === "rejected") {
        failureCount++;
        const errorMessage = result.reason?.message || String(result.reason);
        if (errorMessage.includes("index.lock")) {
          indexLockErrors++;
        }
      }
    });

    // All operations should succeed with serialization
    expect(failureCount).toBe(0);
    expect(indexLockErrors).toBe(0);
  });

  test("initialize migrates legacy .git directory to .hankweavecheckpoints", async () => {
    // tmpdir, not test-area — see the beforeEach note on synced folders.
    const migrationTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hankweave-migration-test-"));
    const checkpointPath = path.join(migrationTempDir, ".hankweave", "checkpoints");

    try {
      // Create legacy structure with a real git repo
      await fs.promises.mkdir(checkpointPath, { recursive: true });

      // Initialize a git repo at the legacy location
      const legacyGitDir = path.join(checkpointPath, ".git");
      await Bun.spawn(["git", "init", "--bare", legacyGitDir]).exited;

      // Verify legacy exists
      expect(fs.existsSync(legacyGitDir)).toBe(true);
      expect(fs.existsSync(path.join(checkpointPath, ".hankweavecheckpoints"))).toBe(false);

      // Initialize CheckpointGit - should trigger migration
      const logPath = path.join(migrationTempDir, "test.log");
      const migrationLogger = new Logger(logPath);
      // For migration test, use migrationTempDir as both executionPath and agentRootPath
      const migrationCheckpointGit = new CheckpointGit(
        migrationTempDir,
        migrationTempDir,
        migrationLogger,
      );
      await migrationCheckpointGit.initialize();

      // Verify migration happened
      expect(fs.existsSync(legacyGitDir)).toBe(false);
      expect(fs.existsSync(path.join(checkpointPath, ".hankweavecheckpoints"))).toBe(true);
    } finally {
      rmSync(migrationTempDir, { recursive: true, force: true });
    }
  });

  describe("rollback reachability helpers (issue #228)", () => {
    test("getHeadSha returns the current HEAD SHA", async () => {
      await checkpointGit.initialize();
      await checkpointGit.addPatterns(["*.txt"]);
      await fs.promises.writeFile(path.join(tempDir, "h.txt"), "h");
      const sha = await checkpointGit.commit("head commit");
      expect(await checkpointGit.getHeadSha()).toBe(sha);
    });

    test("shasBetween returns commits strictly after target on a linear history", async () => {
      await checkpointGit.initialize();
      await checkpointGit.addPatterns(["*.txt"]);

      await fs.promises.writeFile(path.join(tempDir, "l.txt"), "1");
      const c1 = await checkpointGit.commit("c1");
      await fs.promises.writeFile(path.join(tempDir, "l.txt"), "2");
      const c2 = await checkpointGit.commit("c2");
      await fs.promises.writeFile(path.join(tempDir, "l.txt"), "3");
      const c3 = await checkpointGit.commit("c3");
      if (!c1 || !c2 || !c3) throw new Error("commit failed");

      const between = await checkpointGit.shasBetween(c1, c3);
      expect(between.has(c1)).toBe(false); // target itself excluded
      expect(between.has(c2)).toBe(true);
      expect(between.has(c3)).toBe(true);
    });

    test("shasBetween excludes sibling-branch (foreign timeline) commits", async () => {
      await checkpointGit.initialize();
      await checkpointGit.addPatterns(["*.txt"]);

      await fs.promises.writeFile(path.join(tempDir, "s.txt"), "base");
      const base = await checkpointGit.commit("base");

      // Sibling branch off base
      await fs.promises.writeFile(path.join(tempDir, "s.txt"), "feature");
      const feature = await checkpointGit.commit("feature", { branch: "feat-a" });

      // Continue on main (commit() restored the original branch)
      await fs.promises.writeFile(path.join(tempDir, "s.txt"), "main-after");
      const mainAfter = await checkpointGit.commit("main after");
      if (!base || !feature || !mainAfter) throw new Error("commit failed");

      const between = await checkpointGit.shasBetween(base, mainAfter);
      expect(between.has(mainAfter)).toBe(true);
      expect(between.has(feature)).toBe(false); // foreign timeline stays out
      expect(between.has(base)).toBe(false);
    });

    test("shasBetween returns an empty set when target equals origin", async () => {
      await checkpointGit.initialize();
      await checkpointGit.addPatterns(["*.txt"]);
      await fs.promises.writeFile(path.join(tempDir, "e.txt"), "e");
      const sha = await checkpointGit.commit("only");
      if (!sha) throw new Error("commit failed");

      const between = await checkpointGit.shasBetween(sha, sha);
      expect(between.size).toBe(0);
    });

    test("shasBetween throws CheckpointStorageError for unknown SHAs", async () => {
      await checkpointGit.initialize();
      await expect(
        checkpointGit.shasBetween("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "HEAD"),
      ).rejects.toBeInstanceOf(CheckpointStorageError);
    });
  });

  test("checkpoint directory is not detected as git submodule when committed", async () => {
    const submoduleTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hankweave-submodule-test-"));

    try {
      await fs.promises.mkdir(submoduleTempDir, { recursive: true });

      // Initialize a parent git repo
      await Bun.spawn(["git", "init"], { cwd: submoduleTempDir }).exited;
      await Bun.spawn(["git", "config", "user.email", "test@test.com"], {
        cwd: submoduleTempDir,
      }).exited;
      await Bun.spawn(["git", "config", "user.name", "Test"], {
        cwd: submoduleTempDir,
      }).exited;

      // Create checkpoint structure with .hankweavecheckpoints
      const checkpointPath = path.join(submoduleTempDir, ".hankweave", "checkpoints");
      const hwgitPath = path.join(checkpointPath, ".hankweavecheckpoints");
      await fs.promises.mkdir(hwgitPath, { recursive: true });
      await fs.promises.writeFile(path.join(hwgitPath, "HEAD"), "ref: refs/heads/main");

      // Stage the .hankweave directory
      await Bun.spawn(["git", "add", ".hankweave"], { cwd: submoduleTempDir }).exited;

      // Check for submodule mode (160000)
      const proc = Bun.spawn(["git", "ls-files", "--stage"], {
        cwd: submoduleTempDir,
      });
      const output = await new Response(proc.stdout).text();

      // Should NOT contain mode 160000 (submodule)
      expect(output).not.toContain("160000");

      // Should contain the .hankweavecheckpoints files as regular files
      expect(output).toContain(".hankweave/checkpoints/.hankweavecheckpoints/HEAD");
    } finally {
      rmSync(submoduleTempDir, { recursive: true, force: true });
    }
  });
});

/**
 * Crash-safe initialization and the three-way resolver
 * (intermediates/66-crash-safe-checkpoints). Fixtures reproduce the on-disk
 * footprint of a SIGKILL at each point of the build, using the production
 * layout: a bare-style git dir at .hankweave/checkpoints/.hankweavecheckpoints
 * addressed via GIT_DIR — never a nested .git.
 */
describe("CheckpointGit crash-safe initialization", () => {
  let tempDir: string;
  let logger: Logger;
  let logPath: string;

  const gitDirOf = (root: string) =>
    path.join(root, ".hankweave", "checkpoints", ".hankweavecheckpoints");

  async function git(root: string, args: string[]): Promise<{ code: number; out: string }> {
    const proc = Bun.spawn(["git", ...args], {
      cwd: root,
      env: { ...process.env, GIT_DIR: gitDirOf(root), GIT_WORK_TREE: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return { code, out: out.trim() };
  }

  /** A repo folder exactly as a kill between `git init` and the first commit leaves it. */
  async function makeUnbornRepo(root: string): Promise<void> {
    fs.mkdirSync(path.dirname(gitDirOf(root)), { recursive: true });
    const r = await git(root, ["init", "--initial-branch=main"]);
    expect(r.code).toBe(0);
    expect((await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"])).code).not.toBe(0);
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hankweave-crashsafe-test-"));
    logPath = path.join(tempDir, "test.log");
    logger = new Logger(logPath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const readLog = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "");
  const siblingsOfRepo = () =>
    fs.readdirSync(path.join(tempDir, ".hankweave", "checkpoints")).sort();

  test("a fresh build leaves no temp folder behind", async () => {
    const cg = new CheckpointGit(tempDir, tempDir, logger);
    const sha = await cg.initialize();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(siblingsOfRepo()).toEqual([".gitconfig", ".hankweavecheckpoints"]);
    expect((await git(tempDir, ["rev-parse", "HEAD"])).out).toBe(sha);
  });

  test("an unborn repo (killed between init and first commit) is rebuilt", async () => {
    await makeUnbornRepo(tempDir);
    // Locks the killed builder may have left behind go with the folder.
    fs.writeFileSync(path.join(gitDirOf(tempDir), "index.lock"), "");
    fs.writeFileSync(path.join(gitDirOf(tempDir), "config.lock"), "");

    const cg = new CheckpointGit(tempDir, tempDir, logger);
    const sha = await cg.initialize();

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect((await git(tempDir, ["rev-parse", "HEAD"])).out).toBe(sha);
    expect(readLog()).toContain("has no resolvable HEAD; removing it and building a fresh one");
    expect(siblingsOfRepo()).toEqual([".gitconfig", ".hankweavecheckpoints"]);
    expect(fs.existsSync(path.join(gitDirOf(tempDir), "index.lock"))).toBe(false);
    expect((await git(tempDir, ["config", "user.name"])).out).toBe("Hankweave Runtime");

    // The rebuilt repo is fully usable: checkpoints commit and resolve.
    await fs.promises.writeFile(path.join(tempDir, "a.txt"), "a");
    await cg.addPatterns(["*.txt"]);
    const commit = await cg.commit("after rebuild");
    expect(commit).not.toBeNull();
    await expect(cg.requireCheckpoint(commit as string)).resolves.toBe(commit as string);
  });

  test("a second boot over a rebuilt repo reuses it", async () => {
    await makeUnbornRepo(tempDir);
    const first = new CheckpointGit(tempDir, tempDir, logger);
    const built = await first.initialize();
    const second = new CheckpointGit(tempDir, tempDir, logger);
    const sha = await second.initialize();
    expect(sha).toBe(built);
    expect(readLog()).toContain(`Using existing shadow git repository with HEAD: ${built}`);
  });

  test("a temp build folder from a dead builder (kill before rename) is swept", async () => {
    const checkpointsDir = path.dirname(gitDirOf(tempDir));
    fs.mkdirSync(checkpointsDir, { recursive: true });
    const stale = path.join(checkpointsDir, ".hankweavecheckpoints.tmp-999999-1");
    fs.mkdirSync(stale);
    fs.writeFileSync(path.join(stale, "HEAD"), "ref: refs/heads/main\n");

    const cg = new CheckpointGit(tempDir, tempDir, logger);
    await cg.initialize();

    expect(fs.existsSync(stale)).toBe(false);
    expect(readLog()).toContain("Removing stale checkpoint build folder");
  });

  test("a repo with objects but no resolvable HEAD is rebuilt from scratch", async () => {
    const seed = new CheckpointGit(tempDir, tempDir, logger);
    await seed.initialize();
    await fs.promises.writeFile(path.join(tempDir, "keep.txt"), "history");
    await seed.addPatterns(["*.txt"]);
    const kept = await seed.commit("history behind a lost ref");
    expect(kept).not.toBeNull();

    // Lose the refs but keep the objects: HEAD now points at a branch that is gone.
    const gitDir = gitDirOf(tempDir);
    rmSync(path.join(gitDir, "refs", "heads"), { recursive: true, force: true });
    fs.mkdirSync(path.join(gitDir, "refs", "heads"));
    rmSync(path.join(gitDir, "packed-refs"), { force: true });
    expect((await git(tempDir, ["rev-parse", "--verify", "--quiet", "HEAD"])).code).not.toBe(0);

    const cg = new CheckpointGit(tempDir, tempDir, logger);
    const sha = await cg.initialize();

    // Nothing is kept aside: the folder was replaced, and the old SHA is gone.
    expect(siblingsOfRepo()).toEqual([".gitconfig", ".hankweavecheckpoints"]);
    expect((await git(tempDir, ["rev-parse", "HEAD"])).out).toBe(sha);
    await expect(cg.requireCheckpoint(kept as string)).rejects.toBeInstanceOf(
      CheckpointNotFoundError,
    );
    expect(readLog()).toContain("has no resolvable HEAD; removing it and building a fresh one");
  });

  describe("requireCheckpoint", () => {
    test("full SHA and unambiguous prefix resolve; unknown and empty references are not found", async () => {
      const cg = new CheckpointGit(tempDir, tempDir, logger);
      await cg.initialize();
      await fs.promises.writeFile(path.join(tempDir, "x.txt"), "x");
      await cg.addPatterns(["*.txt"]);
      const sha = await cg.commit("populate");
      expect(sha).not.toBeNull();

      await expect(cg.requireCheckpoint(sha as string)).resolves.toBe(sha as string);
      await expect(cg.requireCheckpoint((sha as string).slice(0, 8))).resolves.toBe(sha as string);
      for (const missing of ["0123456789abcdef0123456789abcdef01234567", "", "abc"]) {
        await expect(cg.requireCheckpoint(missing)).rejects.toBeInstanceOf(CheckpointNotFoundError);
      }
    });

    test("before initialization the failure is storage trouble, never 'not found'", async () => {
      const cg = new CheckpointGit(tempDir, tempDir, logger);
      await expect(
        cg.requireCheckpoint("0123456789abcdef0123456789abcdef01234567"),
      ).rejects.toBeInstanceOf(CheckpointStorageError);
    });
  });

  test("resetToCheckpoint refuses an empty reference on a populated repo", async () => {
    const cg = new CheckpointGit(tempDir, tempDir, logger);
    await cg.initialize();
    await fs.promises.writeFile(path.join(tempDir, "x.txt"), "x");
    await cg.addPatterns(["*.txt"]);
    await cg.commit("populate");

    await expect(cg.resetToCheckpoint("")).rejects.toBeInstanceOf(CheckpointNotFoundError);
    await expect(cg.resetToCheckpoint("abc")).rejects.toBeInstanceOf(CheckpointNotFoundError);
  });

  test("stale git locks in a healthy repo are cleared at boot so recovery can check out", async () => {
    // A kill during an ordinary checkpoint leaves index.lock (and, inside a
    // branch update, a ref lock). HEAD resolves, so the repo is "healthy" —
    // but `checkout --force` would fail on the lock every boot.
    const first = new CheckpointGit(tempDir, tempDir, logger);
    await first.initialize();
    await fs.promises.writeFile(path.join(tempDir, "a.txt"), "a");
    await first.addPatterns(["*.txt"]);
    const sha = await first.commit("checkpoint");
    fs.writeFileSync(path.join(gitDirOf(tempDir), "index.lock"), "");
    fs.writeFileSync(path.join(gitDirOf(tempDir), "refs", "heads", "main.lock"), "");

    const cg = new CheckpointGit(tempDir, tempDir, logger);
    expect(await cg.initialize()).toBe(sha as string);

    expect(fs.existsSync(path.join(gitDirOf(tempDir), "index.lock"))).toBe(false);
    expect(fs.existsSync(path.join(gitDirOf(tempDir), "refs", "heads", "main.lock"))).toBe(false);
    expect(readLog()).toContain("Removing stale git lock index.lock");
    await expect(cg.resetToCheckpoint(sha as string)).resolves.toBeUndefined();
  });

  test("a truncated HEAD stops the boot with the folder intact; it is not a torn build", async () => {
    // Same empty footprint as an unborn repo, but HEAD itself is empty. Git
    // writes HEAD through HEAD.lock + rename, so a kill cannot leave this;
    // it is disk trouble, and rev-parse exits 128 ("not a git repository")
    // rather than 1. Rebuilding here would be the same rm -rf that an
    // unreadable HEAD on a populated repo gets, so stop instead.
    await makeUnbornRepo(tempDir);
    fs.writeFileSync(path.join(gitDirOf(tempDir), "HEAD"), "");

    const cg = new CheckpointGit(tempDir, tempDir, logger);
    await expect(cg.initialize()).rejects.toThrow(CheckpointStorageError);

    expect(readLog()).not.toContain("has no resolvable HEAD; removing it and building a fresh one");
    expect(siblingsOfRepo()).toEqual([".hankweavecheckpoints"]);
    expect(fs.readFileSync(path.join(gitDirOf(tempDir), "HEAD"), "utf-8")).toBe("");
  });

  // Root ignores mode bits, so the unreadable-HEAD fixture cannot be built there.
  const notRoot = typeof process.getuid === "function" && process.getuid() !== 0;
  test.skipIf(!notRoot)(
    "a repo git cannot read (rev-parse exit 128) stops the boot and keeps every checkpoint",
    async () => {
      // A healthy repo: one checkpoint, one recovery snapshot.
      const first = new CheckpointGit(tempDir, tempDir, logger);
      await first.initialize();
      fs.writeFileSync(path.join(tempDir, "work.txt"), "checkpointed work");
      await first.addPatterns(["*.txt"]);
      const checkpoint = (await first.commit("completed:one")) as string;
      const snapshot = await first.snapshotForRecovery("probe");
      expect(checkpoint).toMatch(/^[0-9a-f]{40}$/);
      expect(snapshot.recoveryBranch).toMatch(/^recovery\//);

      // One file becomes unreadable: a permission glitch, not a torn build.
      // Before PR #242 review finding 2, this rebuilt the repo and deleted
      // every run-* branch and recovery/* snapshot.
      const headPath = path.join(gitDirOf(tempDir), "HEAD");
      fs.chmodSync(headPath, 0o000);
      try {
        await expect(new CheckpointGit(tempDir, tempDir, logger).initialize()).rejects.toThrow(
          CheckpointStorageError,
        );
      } finally {
        fs.chmodSync(headPath, 0o644);
      }

      expect(readLog()).not.toContain(
        "has no resolvable HEAD; removing it and building a fresh one",
      );
      const again = new CheckpointGit(tempDir, tempDir, logger);
      await again.initialize();
      await again.requireCheckpoint(checkpoint);
      expect(fs.readdirSync(path.join(gitDirOf(tempDir), "refs", "heads"))).toContain("recovery");
    },
  );

  test("an existing SHA-256 repository checkpoints and resolves end to end", async () => {
    // GIT_DEFAULT_HASH=sha256 (or init.defaultObjectFormat) makes `git init`
    // build such a repo; ids are 64 hex chars and simple-git's commit output
    // (core.abbrev=40) truncates them. The stored reference must still match
    // what enumeration returns.
    fs.mkdirSync(path.dirname(gitDirOf(tempDir)), { recursive: true });
    const init = await git(tempDir, ["init", "--object-format=sha256", "--initial-branch=main"]);
    expect(init.code).toBe(0);
    // CheckpointGit points HOME at the checkpoint folder, so the only identity
    // its commits can see is the repo's own config — which a repo it built
    // carries, and which this hand-built fixture must carry too. Without it
    // git falls back to auto-detection, which fails on CI runners whose
    // account has no display name (Linux) or no domain (Windows).
    expect((await git(tempDir, ["config", "user.name", "t"])).code).toBe(0);
    expect((await git(tempDir, ["config", "user.email", "t@t"])).code).toBe(0);
    expect((await git(tempDir, ["commit", "-q", "--allow-empty", "-m", "root"])).code).toBe(0);

    const cg = new CheckpointGit(tempDir, tempDir, logger);
    await cg.initialize();
    expect(readLog()).toContain("Using existing shadow git repository with HEAD");

    await fs.promises.writeFile(path.join(tempDir, "a.txt"), "a");
    await cg.addPatterns(["*.txt"]);
    const sha = await cg.commit("sha256 checkpoint");
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    await expect(cg.requireCheckpoint(sha as string)).resolves.toBe(sha as string);
    expect((await cg.getAllCheckpointShas()).has(sha as string)).toBe(true);
    expect((await cg.getAllCheckpoints()).some((c) => c.sha === sha)).toBe(true);
    await expect(cg.resetToCheckpoint(sha as string)).resolves.toBeUndefined();
  });

  test("getAllCheckpoints reports unreadable storage instead of answering 'no checkpoints'", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores modes
    if (process.platform === "win32") return; // chmod is a no-op on Windows; the dir stays readable
    const cg = new CheckpointGit(tempDir, tempDir, logger);
    await cg.initialize();
    await fs.promises.writeFile(path.join(tempDir, "x.txt"), "x");
    await cg.addPatterns(["*.txt"]);
    const sha = await cg.commit("populate");
    expect((await cg.getAllCheckpoints()).some((c) => c.sha === sha)).toBe(true);

    // Storage that git cannot read must surface as an error, never as [].
    // (A dangling ref is not enough: `git branch -v` silently drops it.)
    const objects = path.join(gitDirOf(tempDir), "objects");
    fs.chmodSync(objects, 0o000);
    try {
      await expect(cg.getAllCheckpoints()).rejects.toBeInstanceOf(CheckpointStorageError);
    } finally {
      fs.chmodSync(objects, 0o755);
    }
  });

  describe("snapshotWorkTree", () => {
    test("keeps the current contents of a tracked file that .gitignore now matches", async () => {
      const cg = new CheckpointGit(tempDir, tempDir, logger);
      await cg.initialize();
      await fs.promises.writeFile(path.join(tempDir, "notes.txt"), "v1");
      await cg.addPatterns(["*.txt"]);
      const head = await cg.commit("track notes");
      expect(head).not.toBeNull();

      // Later the file is modified AND ignored — the empty-index footgun.
      await fs.promises.writeFile(path.join(tempDir, "notes.txt"), "v2");
      await fs.promises.appendFile(path.join(tempDir, ".gitignore"), "notes.txt\n");

      const sha = await cg.snapshotWorkTree("recovery/test", "snap");
      expect((await git(tempDir, ["show", `${sha}:notes.txt`])).out).toBe("v2");
      // HEAD, the real index and the work tree are untouched.
      expect((await git(tempDir, ["rev-parse", "HEAD"])).out).toBe(head as string);
      expect(fs.readFileSync(path.join(tempDir, "notes.txt"), "utf-8")).toBe("v2");
    });

    test("drops a read_only_data_source that HEAD already tracks", async () => {
      // HEAD can be an older snapshot (or a hand-made commit) that carries the
      // data tree; seeding the index from it must not carry the tree forward.
      const cg = new CheckpointGit(tempDir, tempDir, logger);
      await cg.initialize();
      fs.mkdirSync(path.join(tempDir, "read_only_data_source"), { recursive: true });
      await fs.promises.writeFile(path.join(tempDir, "read_only_data_source", "d.bin"), "data");
      expect((await git(tempDir, ["add", "-f", "read_only_data_source/d.bin"])).code).toBe(0);
      expect((await git(tempDir, ["commit", "-q", "-m", "tracks data"])).code).toBe(0);
      expect((await git(tempDir, ["ls-tree", "-r", "--name-only", "HEAD"])).out).toContain(
        "read_only_data_source/d.bin",
      );

      const sha = await cg.snapshotWorkTree("recovery/test", "snap");
      const files = (await git(tempDir, ["ls-tree", "-r", "--name-only", sha])).out;
      expect(files).not.toContain("read_only_data_source");
    });

    test("excludes a copied read_only_data_source like every normal checkpoint", async () => {
      const cg = new CheckpointGit(tempDir, tempDir, logger);
      await cg.initialize();
      fs.mkdirSync(path.join(tempDir, "read_only_data_source", "deep"), { recursive: true });
      await fs.promises.writeFile(
        path.join(tempDir, "read_only_data_source", "deep", "big.bin"),
        "dataset",
      );
      await fs.promises.writeFile(path.join(tempDir, "work.txt"), "w");

      const sha = await cg.snapshotWorkTree("recovery/test", "snap");
      const files = (await git(tempDir, ["ls-tree", "-r", "--name-only", sha])).out.split("\n");
      expect(files).toContain("work.txt");
      expect(files.some((f) => f.startsWith("read_only_data_source"))).toBe(false);
    });
  });
});
