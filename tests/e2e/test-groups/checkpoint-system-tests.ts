import { expect, test } from "bun:test";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Checkpoint system tests.
 * @param executionPath - Where .hankweave/checkpoints lives
 * @param agentRootPath - Where agent files live (git work tree)
 */
export async function runCheckpointSystemTests(executionPath: string, agentRootPath: string) {
  const checkpointDir = path.join(executionPath, ".hankweave/checkpoints");
  const gitDir = path.join(checkpointDir, ".hankweavecheckpoints");

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
      expect(gitConfig).toContain("name = Hankweave Runtime");
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

  test("git commits created for each codon", () => {
    // No try/catch here: the checkpoint repo is created by the server via git,
    // so a git failure at this point is a real test failure, not a skip.
    const gitLog = execSync("git log --oneline", {
      cwd: agentRootPath,
      env: {
        ...process.env,
        GIT_DIR: gitDir,
        GIT_WORK_TREE: agentRootPath,
      },
      encoding: "utf-8",
    });

    const commits = gitLog.trim().split("\n");

    // Should have at least:
    // - Initial commit
    // - Codon 1 completion (rig setup has no files to commit)
    // - Codon 2 completion (no rig setup)
    // - Codon 3 rig setup (after copying files)
    // - Codon 3 completion
    expect(commits.length).toBeGreaterThanOrEqual(5);
  });

  test("commit messages follow expected format", () => {
    const gitLog = execSync("git log --pretty=format:%s", {
      cwd: agentRootPath,
      env: {
        ...process.env,
        GIT_DIR: gitDir,
        GIT_WORK_TREE: agentRootPath,
      },
      encoding: "utf-8",
    });

    const commitMessages = gitLog.trim().split("\n");

    // Check for rig setup commits
    const rigSetupCommits = commitMessages.filter((msg) => msg.startsWith("rig-setup:"));
    expect(rigSetupCommits.length).toBeGreaterThanOrEqual(1); // Only Codon 3 (Codon 1 has no files to commit)

    // Check for completion commits.
    // Exactly one "completed:" commit per codon is a real contract:
    // createCheckpoint fires once per codon completion (retries produce
    // "error:" commits, never extra "completed:" ones), and commits use
    // --allow-empty so none are skipped when there are no file changes.
    const completedCommits = commitMessages.filter((msg) => msg.startsWith("completed:"));
    expect(completedCommits.length).toBe(3); // All 3 codons

    // Verify format: status:codon-id [run:runId] codon-name
    const formatRegex = /^(rig-setup|completed|error|exit|skipped):codon-\d+ \[run:[^\]]+\] .+$/;
    const invalidCommits = commitMessages.filter(
      (msg) => msg !== "Initial checkpoint setup" && !formatRegex.test(msg),
    );
    expect(invalidCommits).toEqual([]);
  });

  test("only tracked files are in git", () => {
    const gitFiles = execSync("git ls-files", {
      cwd: agentRootPath,
      env: {
        ...process.env,
        GIT_DIR: gitDir,
        GIT_WORK_TREE: agentRootPath,
      },
      encoding: "utf-8",
    });

    const checkpointedFiles = gitFiles.trim()
      ? gitFiles
          .trim()
          .split("\n")
          .filter((f) => f)
      : [];

    // All tracked files should match our checkpoint patterns
    for (const file of checkpointedFiles) {
      const matchesPattern =
        file.startsWith("notes/") ||
        file.endsWith(".md") ||
        (file.startsWith("typescript_code/src/") && file.endsWith(".ts")) ||
        file === "typescript_code/package.json";

      expect(matchesPattern).toBe(true);
    }

    // Verify specific files that should be tracked based on what Claude created
    // Note: Some files might not exist if Claude didn't create them
    if (fs.existsSync(path.join(agentRootPath, "notes/favorite_poem.txt"))) {
      expect(checkpointedFiles).toContain("notes/favorite_poem.txt");
    }
    expect(checkpointedFiles).toContain("notes/second_favorite_poem.txt");
    expect(checkpointedFiles).toContain("typescript_code/src/poem1.ts");
    // poem2.ts might not always be created by Claude
    if (fs.existsSync(path.join(agentRootPath, "typescript_code/src/poem2.ts"))) {
      expect(checkpointedFiles).toContain("typescript_code/src/poem2.ts");
    }
  });

  test("all commits on main branch (no error branches)", () => {
    const gitBranches = execSync("git branch", {
      cwd: agentRootPath,
      env: {
        ...process.env,
        GIT_DIR: gitDir,
        GIT_WORK_TREE: agentRootPath,
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
  });

  test("git status shows clean working directory", () => {
    const gitStatus = execSync("git status --porcelain", {
      cwd: agentRootPath,
      env: {
        ...process.env,
        GIT_DIR: gitDir,
        GIT_WORK_TREE: agentRootPath,
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
  });
}
