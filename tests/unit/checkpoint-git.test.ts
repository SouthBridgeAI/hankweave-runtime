import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
} from "bun:test";
import { CheckpointGit } from "../../server/checkpoint-git";
import { Logger } from "../../server/utils";
import * as fs from "fs";
import * as path from "path";
import { rmSync } from "fs";

describe("CheckpointGit", () => {
  let tempDir: string;
  let checkpointGit: CheckpointGit;
  let logger: Logger;

  beforeAll(async () => {
    // Check if git is available
    try {
      const proc = Bun.spawn(["git", "--version"]);
      await proc.exited;
    } catch (error) {
      console.error("Git is not available in test environment");
      throw new Error("Git is required for CheckpointGit tests");
    }
  });

  beforeEach(async () => {
    // Create a temporary directory for testing with absolute path
    tempDir = path.resolve(
      "tests",
      "test-area",
      `temp-test-checkpoint-${Date.now()}`
    );
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
    const expectedPath = path.join(tempDir, ".langton", "checkpoints");
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

    // Check that we're back on main branch
    const proc = Bun.spawn(["git", "branch", "--show-current"], {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });
    const currentBranch = await new Response(proc.stdout).text();
    expect(currentBranch.trim()).toBe("main");

    // Check that branch exists
    const proc2 = Bun.spawn(["git", "branch"], {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });
    const branches = await new Response(proc2.stdout).text();
    expect(branches).toContain("test-branch");
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
    await fs.promises.writeFile(
      path.join(tempDir, "src", "components", "Button.tsx"),
      "export {}"
    );
    await fs.promises.writeFile(
      path.join(tempDir, "src", "utils", "helper.ts"),
      "export {}"
    );
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

  test("switchToBranch logs warning for non-existent branch", async () => {
    await checkpointGit.initialize();

    // Try to switch to non-existent branch
    await checkpointGit.switchToBranch("non-existent-branch");

    // Should still be on main branch
    const gitEnv = {
      GIT_DIR: path.join(checkpointGit.getPath(), ".git"),
      GIT_WORK_TREE: tempDir,
    };

    const proc = Bun.spawn(["git", "branch", "--show-current"], {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });
    const currentBranch = await new Response(proc.stdout).text();
    expect(currentBranch.trim()).toBe("main");
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
    const commit2 = await checkpointGit.commit("Second commit");

    // Verify both files exist
    expect(fs.existsSync(file1)).toBe(true);
    expect(fs.existsSync(file2)).toBe(true);

    // Reset to first commit
    await checkpointGit.resetToCheckpoint(commit1!);

    // Verify file2 is gone but file1 remains
    expect(fs.existsSync(file1)).toBe(true);
    expect(fs.existsSync(file2)).toBe(false);
  });

  test("resetToCheckpoint throws for non-existent SHA", async () => {
    await checkpointGit.initialize();

    // Try to reset to non-existent SHA
    await expect(
      checkpointGit.resetToCheckpoint("nonexistent123")
    ).rejects.toThrow("Checkpoint nonexistent123 not found in repository");
  });

  test("resetToCheckpoint throws when not initialized", async () => {
    await expect(checkpointGit.resetToCheckpoint("abc123")).rejects.toThrow(
      "Git repository not initialized"
    );
  });

  test("switchToBranch throws when not initialized", async () => {
    await expect(checkpointGit.switchToBranch("some-branch")).rejects.toThrow(
      "Git repository not initialized"
    );
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
    expect(lastCommit).toContain(firstCommit!.substring(0, 7));
  });
});
