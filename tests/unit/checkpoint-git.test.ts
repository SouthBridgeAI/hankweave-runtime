import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { rmSync } from "node:fs";
import * as path from "node:path";
import { CheckpointGit } from "../../server/checkpoint-git";
import { Logger } from "../../server/utils";
import { sleep } from "../utils/test-helpers";

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
    // Create a temporary directory for testing with absolute path
    tempDir = path.resolve("tests", "test-area", `temp-test-checkpoint-${Date.now()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Create a mock logger
    const logPath = path.join(tempDir, "test.log");
    logger = new Logger(logPath);

    // Initialize CheckpointGit
    checkpointGit = new CheckpointGit(tempDir, logger);
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
    const expectedPath = path.join(tempDir, ".strandweave", "checkpoints");
    expect(checkpointGit.getPath()).toBe(expectedPath);
  });

  test("initialize creates git repository", async () => {
    await checkpointGit.initialize();

    const gitDir = path.join(checkpointGit.getPath(), ".git");
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
      GIT_DIR: path.join(checkpointGit.getPath(), ".git"),
      GIT_WORK_TREE: tempDir,
    };

    const proc = Bun.spawn(["git", "ls-tree", "-r", "HEAD", "--name-only"], {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });
    const trackedFiles = await new Response(proc.stdout).text();

    expect(trackedFiles).toContain("test.log");
    expect(trackedFiles).toContain("test.tmp");
    expect(trackedFiles).not.toContain("test.txt");
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
      GIT_DIR: path.join(checkpointGit.getPath(), ".git"),
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
      GIT_DIR: path.join(checkpointGit.getPath(), ".git"),
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
      GIT_DIR: path.join(checkpointGit.getPath(), ".git"),
      GIT_WORK_TREE: tempDir,
    };

    const proc = Bun.spawn(["git", "ls-tree", "-r", "HEAD", "--name-only"], {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });
    const trackedFiles = await new Response(proc.stdout).text();

    expect(trackedFiles).toContain("src/components/Button.tsx");
    expect(trackedFiles).toContain("src/utils/helper.ts");
    expect(trackedFiles).toContain("README.md");
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
      GIT_DIR: path.join(checkpointGit.getPath(), ".git"),
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
      GIT_DIR: path.join(checkpointGit.getPath(), ".git"),
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

    // sleep a bit to get nicer timestamps
    await sleep(1000);

    await fs.promises.writeFile(mainFile, "two");
    const c2 = await checkpointGit.commit("main: second");

    await sleep(1000);

    // Two commits on run branch
    const featureFile1 = path.join(tempDir, "feature1.txt");
    await fs.promises.writeFile(featureFile1, "f1");
    const f1 = await checkpointGit.commit("feature: first", {
      branch: "run-1757489464604-eicnq",
    });

    await sleep(1000);

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

    // Most recent commits first, check branches too
    expect(checkpoints[0].message).toBe("feature: second");
    expect(checkpoints[0].branch).toBe("run-1757489464604-eicnq");
    expect(checkpoints[1].message).toBe("feature: first");
    expect(checkpoints[1].branch).toBe("run-1757489464604-eicnq");
    expect(checkpoints[2].message).toBe("main: second");
    expect(checkpoints[2].branch).toBe("main");
    expect(checkpoints[3].message).toBe("main: first");
    expect(checkpoints[3].branch).toBe("main");
    expect(checkpoints[4].message).toBe("Initial checkpoint setup");
    expect(checkpoints[4].branch).toBe("main");
  });

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
    const checkpointGit2 = new CheckpointGit(tempDir, logger);
    await checkpointGit2.initialize();

    // Verify it can see the existing commit
    const gitEnv = {
      GIT_DIR: path.join(checkpointGit2.getPath(), ".git"),
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
});
