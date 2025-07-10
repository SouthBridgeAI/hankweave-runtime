import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { GitOperations } from "../../server/cleanup/git-operations.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { rmSync } from "node:fs";
import { execSync } from "node:child_process";

describe("GitOperations", () => {
  let tempDir: string;
  let checkpointDir: string;
  let gitOps: GitOperations;

  beforeEach(async () => {
    // Create a temporary directory for testing
    tempDir = path.resolve(
      "tests",
      "test-area",
      `temp-test-git-ops-${Date.now()}`
    );
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Create checkpoint directory
    checkpointDir = path.join(tempDir, ".langton", "checkpoints");
    await fs.promises.mkdir(checkpointDir, { recursive: true });

    // Initialize a git repository in the checkpoint directory
    execSync("git init", {
      cwd: checkpointDir,
      env: {
        ...process.env,
        GIT_DIR: path.join(checkpointDir, ".git"),
        GIT_WORK_TREE: tempDir,
      },
    });

    // Configure git
    execSync('git config user.name "Test User"', {
      cwd: checkpointDir,
      env: {
        ...process.env,
        GIT_DIR: path.join(checkpointDir, ".git"),
        GIT_WORK_TREE: tempDir,
      },
    });
    execSync('git config user.email "test@example.com"', {
      cwd: checkpointDir,
      env: {
        ...process.env,
        GIT_DIR: path.join(checkpointDir, ".git"),
        GIT_WORK_TREE: tempDir,
      },
    });

    // Create GitOperations instance
    gitOps = new GitOperations(tempDir, checkpointDir);
  });

  afterEach(async () => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("isGitRepository", () => {
    test("returns true for initialized git repository", async () => {
      const isRepo = await gitOps.isGitRepository();
      expect(isRepo).toBe(true);
    });

    test("returns false for non-git directory", async () => {
      // Create a new instance pointing to a non-git directory
      const nonGitDir = path.join(tempDir, "not-git");
      await fs.promises.mkdir(nonGitDir, { recursive: true });
      const nonGitOps = new GitOperations(tempDir, nonGitDir);

      const isRepo = await nonGitOps.isGitRepository();
      expect(isRepo).toBe(false);
    });
  });

  describe("getCurrentCommit", () => {
    test("returns undefined when no commits exist", async () => {
      const commit = await gitOps.getCurrentCommit();
      expect(commit).toBeUndefined();
    });

    test("returns commit hash after making a commit", async () => {
      // Create a file and commit it
      await fs.promises.writeFile(
        path.join(tempDir, "test.txt"),
        "test content"
      );

      execSync("git add .", {
        cwd: tempDir,
        env: {
          ...process.env,
          GIT_DIR: path.join(checkpointDir, ".git"),
          GIT_WORK_TREE: tempDir,
        },
      });
      execSync('git commit -m "Initial commit"', {
        cwd: tempDir,
        env: {
          ...process.env,
          GIT_DIR: path.join(checkpointDir, ".git"),
          GIT_WORK_TREE: tempDir,
        },
      });

      const commit = await gitOps.getCurrentCommit();
      expect(commit).toBeDefined();
      expect(commit).toMatch(/^[a-f0-9]{7}$/);
    });
  });

  describe("getInitialCommit", () => {
    test("returns undefined when no commits exist", async () => {
      const commit = await gitOps.getInitialCommit();
      expect(commit).toBeUndefined();
    });

    test("returns first commit hash", async () => {
      // Create first commit
      await fs.promises.writeFile(
        path.join(tempDir, "test.txt"),
        "test content"
      );
      execSync("git add .", {
        cwd: tempDir,
        env: {
          ...process.env,
          GIT_DIR: path.join(checkpointDir, ".git"),
          GIT_WORK_TREE: tempDir,
        },
      });
      execSync('git commit -m "Initial commit"', {
        cwd: tempDir,
        env: {
          ...process.env,
          GIT_DIR: path.join(checkpointDir, ".git"),
          GIT_WORK_TREE: tempDir,
        },
      });

      const firstCommitOutput = execSync("git log --reverse --oneline -1", {
        cwd: tempDir,
        env: {
          ...process.env,
          GIT_DIR: path.join(checkpointDir, ".git"),
          GIT_WORK_TREE: tempDir,
        },
        encoding: "utf-8",
      }).trim();
      const firstCommitHash = firstCommitOutput.split(" ")[0];

      // Create second commit
      await fs.promises.writeFile(
        path.join(tempDir, "test2.txt"),
        "test content 2"
      );
      execSync("git add .", {
        cwd: tempDir,
        env: {
          ...process.env,
          GIT_DIR: path.join(checkpointDir, ".git"),
          GIT_WORK_TREE: tempDir,
        },
      });
      execSync('git commit -m "Second commit"', {
        cwd: tempDir,
        env: {
          ...process.env,
          GIT_DIR: path.join(checkpointDir, ".git"),
          GIT_WORK_TREE: tempDir,
        },
      });

      const initialCommit = await gitOps.getInitialCommit();
      expect(initialCommit).toBe(firstCommitHash);
    });
  });

  describe("resetToInitial", () => {
    test("throws error when no commits exist", async () => {
      await expect(gitOps.resetToInitial()).rejects.toThrow(
        "No initial commit found"
      );
    });

    test("resets to initial commit", async () => {
      // Create initial commit
      await fs.promises.writeFile(
        path.join(tempDir, "test.txt"),
        "initial content"
      );
      execSync("git add .", {
        cwd: tempDir,
        env: {
          ...process.env,
          GIT_DIR: path.join(checkpointDir, ".git"),
          GIT_WORK_TREE: tempDir,
        },
      });
      execSync('git commit -m "Initial commit"', {
        cwd: tempDir,
        env: {
          ...process.env,
          GIT_DIR: path.join(checkpointDir, ".git"),
          GIT_WORK_TREE: tempDir,
        },
      });

      // Create second commit with different content
      await fs.promises.writeFile(
        path.join(tempDir, "test.txt"),
        "modified content"
      );
      await fs.promises.writeFile(path.join(tempDir, "test2.txt"), "new file");
      execSync("git add .", {
        cwd: tempDir,
        env: {
          ...process.env,
          GIT_DIR: path.join(checkpointDir, ".git"),
          GIT_WORK_TREE: tempDir,
        },
      });
      execSync('git commit -m "Second commit"', {
        cwd: tempDir,
        env: {
          ...process.env,
          GIT_DIR: path.join(checkpointDir, ".git"),
          GIT_WORK_TREE: tempDir,
        },
      });

      // Verify we have two commits
      const logBefore = execSync("git log --oneline", {
        cwd: tempDir,
        env: {
          ...process.env,
          GIT_DIR: path.join(checkpointDir, ".git"),
          GIT_WORK_TREE: tempDir,
        },
        encoding: "utf-8",
      });
      expect(logBefore.split("\n").filter((line) => line.trim()).length).toBe(
        2
      );

      // Reset to initial
      await gitOps.resetToInitial();

      // Verify file contents are back to initial state
      const content = await fs.promises.readFile(
        path.join(tempDir, "test.txt"),
        "utf-8"
      );
      expect(content).toBe("initial content");
      expect(fs.existsSync(path.join(tempDir, "test2.txt"))).toBe(false);

      // Verify we're at the initial commit
      const currentCommit = await gitOps.getCurrentCommit();
      const initialCommit = await gitOps.getInitialCommit();
      expect(currentCommit).toBeDefined();
      expect(initialCommit).toBeDefined();
      // Both values are defined at this point, but TypeScript doesn't know that
      if (currentCommit && initialCommit) {
        expect(currentCommit).toBe(initialCommit);
      }
    });

    test("handles complex repository state", async () => {
      // Create multiple commits with various changes
      await fs.promises.writeFile(path.join(tempDir, "file1.txt"), "content1");
      execSync("git add .", {
        cwd: tempDir,
        env: {
          ...process.env,
          GIT_DIR: path.join(checkpointDir, ".git"),
          GIT_WORK_TREE: tempDir,
        },
      });
      execSync('git commit -m "Initial commit"', {
        cwd: tempDir,
        env: {
          ...process.env,
          GIT_DIR: path.join(checkpointDir, ".git"),
          GIT_WORK_TREE: tempDir,
        },
      });

      // Add directory structure
      await fs.promises.mkdir(path.join(tempDir, "src", "components"), {
        recursive: true,
      });
      await fs.promises.writeFile(
        path.join(tempDir, "src", "index.ts"),
        "export {}"
      );
      await fs.promises.writeFile(
        path.join(tempDir, "src", "components", "Button.tsx"),
        "export {}"
      );
      execSync("git add .", {
        cwd: tempDir,
        env: {
          ...process.env,
          GIT_DIR: path.join(checkpointDir, ".git"),
          GIT_WORK_TREE: tempDir,
        },
      });
      execSync('git commit -m "Add source files"', {
        cwd: tempDir,
        env: {
          ...process.env,
          GIT_DIR: path.join(checkpointDir, ".git"),
          GIT_WORK_TREE: tempDir,
        },
      });

      // Add untracked files
      await fs.promises.writeFile(
        path.join(tempDir, "untracked.txt"),
        "untracked content"
      );

      // Reset to initial
      await gitOps.resetToInitial();

      // Verify state
      expect(fs.existsSync(path.join(tempDir, "file1.txt"))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, "src"))).toBe(false);
      expect(fs.existsSync(path.join(tempDir, "untracked.txt"))).toBe(true); // Untracked files should remain
    });
  });

  describe("getTrackedFiles", () => {
    test("returns empty array when no commits", async () => {
      const files = await gitOps.getTrackedFiles();
      expect(files).toEqual([]);
    });

    test("identifies added files", async () => {
      // Create initial commit
      await fs.promises.writeFile(path.join(tempDir, "initial.txt"), "content");
      execSync("git add .", {
        cwd: tempDir,
        env: {
          ...process.env,
          GIT_DIR: path.join(checkpointDir, ".git"),
          GIT_WORK_TREE: tempDir,
        },
      });
      execSync('git commit -m "Initial commit"', {
        cwd: tempDir,
        env: {
          ...process.env,
          GIT_DIR: path.join(checkpointDir, ".git"),
          GIT_WORK_TREE: tempDir,
        },
      });

      // Add new files
      await fs.promises.writeFile(
        path.join(tempDir, "added.txt"),
        "new content"
      );
      execSync("git add .", {
        cwd: tempDir,
        env: {
          ...process.env,
          GIT_DIR: path.join(checkpointDir, ".git"),
          GIT_WORK_TREE: tempDir,
        },
      });
      execSync('git commit -m "Add file"', {
        cwd: tempDir,
        env: {
          ...process.env,
          GIT_DIR: path.join(checkpointDir, ".git"),
          GIT_WORK_TREE: tempDir,
        },
      });

      const files = await gitOps.getTrackedFiles();
      const addedFile = files.find((f) => f.path === "added.txt");
      expect(addedFile).toBeDefined();
      expect(addedFile?.status).toBe("added");
    });

    test("identifies modified files", async () => {
      // Create initial commit
      await fs.promises.writeFile(
        path.join(tempDir, "file.txt"),
        "initial content"
      );
      execSync("git add .", {
        cwd: tempDir,
        env: {
          ...process.env,
          GIT_DIR: path.join(checkpointDir, ".git"),
          GIT_WORK_TREE: tempDir,
        },
      });
      execSync('git commit -m "Initial commit"', {
        cwd: tempDir,
        env: {
          ...process.env,
          GIT_DIR: path.join(checkpointDir, ".git"),
          GIT_WORK_TREE: tempDir,
        },
      });

      // Modify file
      await fs.promises.writeFile(
        path.join(tempDir, "file.txt"),
        "modified content"
      );
      execSync("git add .", {
        cwd: tempDir,
        env: {
          ...process.env,
          GIT_DIR: path.join(checkpointDir, ".git"),
          GIT_WORK_TREE: tempDir,
        },
      });
      execSync('git commit -m "Modify file"', {
        cwd: tempDir,
        env: {
          ...process.env,
          GIT_DIR: path.join(checkpointDir, ".git"),
          GIT_WORK_TREE: tempDir,
        },
      });

      const files = await gitOps.getTrackedFiles();
      const modifiedFile = files.find((f) => f.path === "file.txt");
      expect(modifiedFile).toBeDefined();
      expect(modifiedFile?.status).toBe("modified");
    });
  });

  describe("hasUncommittedChanges", () => {
    test("returns false for clean repository", async () => {
      await fs.promises.writeFile(path.join(tempDir, "file.txt"), "content");
      execSync("git add .", {
        cwd: tempDir,
        env: {
          ...process.env,
          GIT_DIR: path.join(checkpointDir, ".git"),
          GIT_WORK_TREE: tempDir,
        },
      });
      execSync('git commit -m "Initial commit"', {
        cwd: tempDir,
        env: {
          ...process.env,
          GIT_DIR: path.join(checkpointDir, ".git"),
          GIT_WORK_TREE: tempDir,
        },
      });

      const hasChanges = await gitOps.hasUncommittedChanges();
      expect(hasChanges).toBe(false);
    });

    test("returns true for uncommitted changes", async () => {
      await fs.promises.writeFile(path.join(tempDir, "file.txt"), "content");
      execSync("git add .", {
        cwd: tempDir,
        env: {
          ...process.env,
          GIT_DIR: path.join(checkpointDir, ".git"),
          GIT_WORK_TREE: tempDir,
        },
      });
      execSync('git commit -m "Initial commit"', {
        cwd: tempDir,
        env: {
          ...process.env,
          GIT_DIR: path.join(checkpointDir, ".git"),
          GIT_WORK_TREE: tempDir,
        },
      });

      // Make changes
      await fs.promises.writeFile(
        path.join(tempDir, "file.txt"),
        "new content"
      );

      const hasChanges = await gitOps.hasUncommittedChanges();
      expect(hasChanges).toBe(true);
    });
  });
});
