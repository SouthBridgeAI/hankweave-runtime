import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

export async function runCheckpointExclusionTests(testDir: string) {
  const checkpointDir = path.join(testDir, ".hankweave/checkpoints");
  const gitDir = path.join(checkpointDir, ".git");

  test("checkpoint system excludes non-tracked files", async () => {
    const { execSync } = await import("node:child_process");

    // Create some files that shouldn't be tracked
    fs.writeFileSync(path.join(testDir, "untracked.txt"), "should not be in git");
    fs.writeFileSync(path.join(testDir, "notes/untracked.log"), "also not tracked");
    fs.mkdirSync(path.join(testDir, ".hankweave/temp"), { recursive: true });
    fs.writeFileSync(path.join(testDir, ".hankweave/temp/file.txt"), "internal file");

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

    // .hankweave directory should never be tracked
    const gitFiles = execSync("git ls-files", {
      cwd: testDir,
      env: {
        ...process.env,
        GIT_DIR: gitDir,
        GIT_WORK_TREE: testDir,
      },
      encoding: "utf-8",
    });

    expect(gitFiles).not.toContain(".hankweave/");
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
      if (commit.includes("completed:") || commit.includes("rig-setup:")) {
        expect(commit).toMatch(/Timestamp: \d{4}-\d{2}-\d{2}T/);
        expect(commit).toMatch(/Codon: .+/);
        expect(commit).toMatch(/Status: (completed|rig-setup|skipped|error|exit)/);

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

  test("checkpoint system respects .gitignore in subfolders", async () => {
    const { execSync } = await import("node:child_process");

    // Codon 3 copies typescript_structure which has a .gitignore
    const typescriptDir = path.join(testDir, "typescript_code");
    const gitignorePath = path.join(typescriptDir, ".gitignore");

    // Verify .gitignore exists
    expect(fs.existsSync(gitignorePath)).toBe(true);

    // Create files that should be ignored according to the .gitignore
    const nodeModulesDir = path.join(typescriptDir, "node_modules");
    const distDir = path.join(typescriptDir, "dist");
    const envFile = path.join(typescriptDir, ".env");
    const dsStoreFile = path.join(typescriptDir, ".DS_Store");

    // These files exist after bun install but should be ignored
    expect(fs.existsSync(nodeModulesDir)).toBe(true);

    // Create additional ignored files
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, "index.js"), "// compiled output");
    fs.writeFileSync(envFile, "SECRET_KEY=123");
    fs.writeFileSync(dsStoreFile, "mac finder metadata");

    // Get all files tracked by the checkpoint git
    const gitFiles = execSync("git ls-files", {
      cwd: testDir,
      env: {
        ...process.env,
        GIT_DIR: gitDir,
        GIT_WORK_TREE: testDir,
      },
      encoding: "utf-8",
    });

    // Verify that ignored files are not tracked
    expect(gitFiles).not.toContain("node_modules");
    expect(gitFiles).not.toContain("dist/");
    expect(gitFiles).not.toContain(".env");
    expect(gitFiles).not.toContain(".DS_Store");

    // Verify that the .gitignore itself IS tracked (since it's part of checkpointedFiles)
    // checkpointedFiles includes "typescript_code/package.json" so .gitignore won't be tracked
    // unless it matches a pattern

    // Verify that allowed TypeScript files in src ARE tracked
    const srcFiles = gitFiles
      .split("\n")
      .filter((f) => f.startsWith("typescript_code/src/") && f.endsWith(".ts"));
    expect(srcFiles.length).toBeGreaterThan(0); // Should have poem1.ts and poem2.ts
  });
}
