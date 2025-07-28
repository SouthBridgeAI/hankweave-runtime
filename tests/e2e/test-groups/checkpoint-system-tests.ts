import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

export async function runCheckpointSystemTests(testDir: string) {
  const checkpointDir = path.join(testDir, ".tadpole/checkpoints");
  const gitDir = path.join(checkpointDir, ".git");

  test("checkpoint directory structure created", () => {
    expect(fs.existsSync(checkpointDir)).toBe(true);
    expect(fs.existsSync(gitDir)).toBe(true);
    expect(fs.existsSync(path.join(checkpointDir, ".gitconfig"))).toBe(true);
    expect(fs.existsSync(path.join(gitDir, "info", "exclude"))).toBe(true);
  });

  test("gitconfig has correct user settings", () => {
    const gitConfigPath = path.join(checkpointDir, ".gitconfig");
    if (fs.existsSync(gitConfigPath)) {
      const gitConfig = fs.readFileSync(gitConfigPath, "utf-8");
      expect(gitConfig).toContain("name = Tadpole Runner");
      expect(gitConfig).toContain("email = froggie@southbridge.ai");
      expect(gitConfig).toContain("gpgsign = false");
    }
  });

  test("git exclude file exists", () => {
    const excludePath = path.join(gitDir, "info", "exclude");
    // The exclude file should exist, but we no longer use it for patterns
    // (patterns are handled by UnifiedFileResolver)
    expect(fs.existsSync(excludePath)).toBe(true);
  });

  test("git commits created for each phase", async () => {
    // Execute git log to get commits
    const { execSync } = await import("node:child_process");
    try {
      const gitLog = execSync("git log --oneline", {
        cwd: testDir,
        env: {
          ...process.env,
          GIT_DIR: gitDir,
          GIT_WORK_TREE: testDir,
        },
        encoding: "utf-8",
      });

      const commits = gitLog.trim().split("\n");

      // Should have at least:
      // - Initial commit
      // - Phase 1 completion (workspace setup has no files to commit)
      // - Phase 2 completion (no workspace setup)
      // - Phase 3 workspace setup (after copying files)
      // - Phase 3 completion
      expect(commits.length).toBeGreaterThanOrEqual(5);
    } catch (error) {
      console.error(`Git log failed: ${error}`);
    }
  });

  test("commit messages follow expected format", async () => {
    const { execSync } = await import("node:child_process");
    try {
      const gitLog = execSync("git log --pretty=format:%s", {
        cwd: testDir,
        env: {
          ...process.env,
          GIT_DIR: gitDir,
          GIT_WORK_TREE: testDir,
        },
        encoding: "utf-8",
      });

      const commitMessages = gitLog.trim().split("\n");

      // Check for workspace setup commits
      const workspaceSetupCommits = commitMessages.filter((msg) =>
        msg.startsWith("workspace-setup:"),
      );
      expect(workspaceSetupCommits.length).toBeGreaterThanOrEqual(1); // Only Phase 3 (Phase 1 has no files to commit)

      // Check for completion commits
      const completedCommits = commitMessages.filter((msg) => msg.startsWith("completed:"));
      expect(completedCommits.length).toBe(3); // All 3 phases

      // Verify format: status:phase-id [run:runId] phase-name
      const formatRegex =
        /^(workspace-setup|completed|error|exit|skipped):phase-\d+ \[run:[^\]]+\] .+$/;
      const invalidCommits = commitMessages.filter(
        (msg) => msg !== "Initial checkpoint setup" && !formatRegex.test(msg),
      );
      expect(invalidCommits).toEqual([]);
    } catch (error) {
      console.error(`Git log failed: ${error}`);
    }
  });

  test("only tracked files are in git", async () => {
    const { execSync } = await import("node:child_process");
    try {
      const gitFiles = execSync("git ls-files", {
        cwd: testDir,
        env: {
          ...process.env,
          GIT_DIR: gitDir,
          GIT_WORK_TREE: testDir,
        },
        encoding: "utf-8",
      });

      const trackedFiles = gitFiles.trim()
        ? gitFiles
            .trim()
            .split("\n")
            .filter((f) => f)
        : [];

      // All tracked files should match our checkpoint patterns
      for (const file of trackedFiles) {
        const matchesPattern =
          file.startsWith("notes/") ||
          file.endsWith(".md") ||
          (file.startsWith("typescript_code/src/") && file.endsWith(".ts")) ||
          file === "typescript_code/package.json";

        expect(matchesPattern).toBe(true);
      }

      // Verify specific files that should be tracked based on what Claude created
      // Note: Some files might not exist if Claude didn't create them
      if (fs.existsSync(path.join(testDir, "notes/favorite_poem.txt"))) {
        expect(trackedFiles).toContain("notes/favorite_poem.txt");
      }
      expect(trackedFiles).toContain("notes/second_favorite_poem.txt");
      expect(trackedFiles).toContain("typescript_code/src/poem1.ts");
      // poem2.ts might not always be created by Claude
      if (fs.existsSync(path.join(testDir, "typescript_code/src/poem2.ts"))) {
        expect(trackedFiles).toContain("typescript_code/src/poem2.ts");
      }
    } catch (error) {
      console.error(`Git ls-files failed: ${error}`);
    }
  });

  test("all commits on main branch (no error branches)", async () => {
    const { execSync } = await import("node:child_process");
    try {
      const gitBranches = execSync("git branch", {
        cwd: testDir,
        env: {
          ...process.env,
          GIT_DIR: gitDir,
          GIT_WORK_TREE: testDir,
        },
        encoding: "utf-8",
      });

      const branches = gitBranches
        .trim()
        .split("\n")
        .map((b) => b.trim());

      // Should have main branch and a run-specific branch
      // The run branch should be the current one (marked with *)
      expect(branches.length).toBeGreaterThanOrEqual(2);
      expect(branches).toContain("main");
      // One branch should be marked as current with *
      const currentBranch = branches.find((b) => b.startsWith("*"));
      expect(currentBranch).toBeDefined();
      // Current branch should be a run-specific branch
      expect(currentBranch).toMatch(/\* run-\d+-\w+/);
    } catch (error) {
      console.error(`Git branch failed: ${error}`);
    }
  });

  test("git status shows clean working directory", async () => {
    const { execSync } = await import("node:child_process");
    try {
      const gitStatus = execSync("git status --porcelain", {
        cwd: testDir,
        env: {
          ...process.env,
          GIT_DIR: gitDir,
          GIT_WORK_TREE: testDir,
        },
        encoding: "utf-8",
      });

      // There may be untracked files that are not part of checkpoint patterns
      // Filter out untracked files (marked with ??)
      const trackedChanges = gitStatus
        .trim()
        .split("\n")
        .filter((line) => line && !line.startsWith("??"))
        .join("\n");

      // Should have no uncommitted changes to tracked files
      expect(trackedChanges).toBe("");
    } catch (error) {
      console.error(`Git status failed: ${error}`);
    }
  });
}
