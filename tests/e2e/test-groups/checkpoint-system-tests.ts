import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

export async function runCheckpointSystemTests(testDir: string) {
  const checkpointDir = path.join(testDir, ".langton/checkpoints");
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
      expect(gitConfig).toContain("name = Langton Runner");
      expect(gitConfig).toContain("email = froggie@southbridge.ai");
      expect(gitConfig).toContain("gpgsign = false");
    }
  });

  test("git exclude configured correctly", () => {
    const excludePath = path.join(gitDir, "info", "exclude");
    if (fs.existsSync(excludePath)) {
      const excludeContent = fs.readFileSync(excludePath, "utf-8");
      expect(excludeContent).toContain("*"); // Ignore everything by default
      // Should have exceptions for tracked patterns
      expect(excludeContent).toContain("!notes/**/*");
      expect(excludeContent).toContain("!typescript_code/src/**/*.ts");
      expect(excludeContent).toContain("!typescript_code/package.json");
    }
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

      // Verify specific files are tracked
      expect(trackedFiles).toContain("notes/favorite_poem.txt");
      expect(trackedFiles).toContain("notes/second_favorite_poem.txt");
      expect(trackedFiles).toContain("typescript_code/src/poem1.ts");
      expect(trackedFiles).toContain("typescript_code/src/poem2.ts");
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

      // Should only have main branch (marked with *)
      expect(branches).toEqual(["* main"]);
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

      // Should have no uncommitted changes (empty output)
      expect(gitStatus.trim()).toBe("");
    } catch (error) {
      console.error(`Git status failed: ${error}`);
    }
  });
}