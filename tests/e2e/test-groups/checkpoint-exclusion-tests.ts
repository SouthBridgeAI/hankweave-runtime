import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

export async function runCheckpointExclusionTests(testDir: string) {
  const checkpointDir = path.join(testDir, ".langton/checkpoints");
  const gitDir = path.join(checkpointDir, ".git");

  test("checkpoint system excludes non-tracked files", async () => {
    const { execSync } = await import("node:child_process");

    // Create some files that shouldn't be tracked
    fs.writeFileSync(path.join(testDir, "untracked.txt"), "should not be in git");
    fs.writeFileSync(path.join(testDir, "notes/untracked.log"), "also not tracked");
    fs.mkdirSync(path.join(testDir, ".langton/temp"), { recursive: true });
    fs.writeFileSync(path.join(testDir, ".langton/temp/file.txt"), "internal file");

    // Check git status shows them as untracked
    const gitStatus = execSync("git status --porcelain", {
      cwd: testDir,
      env: {
        ...process.env,
        GIT_DIR: gitDir,
        GIT_WORK_TREE: testDir,
      },
      encoding: "utf-8",
    });

    // Only files not covered by exclude rules show as untracked
    // untracked.txt is excluded by default "*" rule, so won't show
    // notes/untracked.log is UN-excluded by "!notes/**/*" but not added to git yet
    expect(gitStatus).toContain("?? notes/untracked.log");

    // .langton directory should never be tracked
    const gitFiles = execSync("git ls-files", {
      cwd: testDir,
      env: {
        ...process.env,
        GIT_DIR: gitDir,
        GIT_WORK_TREE: testDir,
      },
      encoding: "utf-8",
    });

    expect(gitFiles).not.toContain(".langton/");
  });

  test("checkpoint commits include proper metadata", async () => {
    const { execSync } = await import("node:child_process");

    const gitLog = execSync("git log --pretty=format:%B%n---", {
      cwd: testDir,
      env: {
        ...process.env,
        GIT_DIR: gitDir,
        GIT_WORK_TREE: testDir,
      },
      encoding: "utf-8",
    });

    const commits = gitLog.split("\n---\n").filter((c) => c.trim());

    commits.forEach((commit) => {
      if (commit.includes("completed:") || commit.includes("workspace-setup:")) {
        expect(commit).toMatch(/Timestamp: \d{4}-\d{2}-\d{2}T/);
        expect(commit).toMatch(/Phase: .+/);
        expect(commit).toMatch(/Status: (completed|workspace-setup|skipped|error|exit)/);

        if (commit.includes("completed:")) {
          expect(commit).toMatch(/Duration: \d+ms/);
        }
      }
    });
  });

  test("checkpoint commits happen at correct times", async () => {
    const { execSync } = await import("node:child_process");

    // Get commit times
    const gitLog = execSync("git log --pretty=format:'%H|%ct|%s'", {
      cwd: testDir,
      env: {
        ...process.env,
        GIT_DIR: gitDir,
        GIT_WORK_TREE: testDir,
      },
      encoding: "utf-8",
    });

    const commits = gitLog
      .trim()
      .split("\n")
      .map((line) => {
        const [hash, timestamp, message] = line.split("|");
        return { hash, timestamp: parseInt(timestamp) * 1000, message };
      });

    // Verify commits are in chronological order
    for (let i = 1; i < commits.length; i++) {
      expect(commits[i].timestamp).toBeLessThanOrEqual(commits[i - 1].timestamp);
    }
  });
}
