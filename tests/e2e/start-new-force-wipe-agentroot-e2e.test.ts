#!/usr/bin/env bun
/**
 * BUG: `--start-new --force` does NOT wipe `agentRoot/`.
 *
 * When `--start-new --force` reuses an existing execution directory, the
 * `.hankweave/` metadata is backed up but the `agentRoot/` workspace was left
 * in place. Stale outputs from a prior run therefore leaked into the "fresh"
 * execution and could make checks pass against old files.
 *
 * This test plants a sentinel file in `agentRoot/` from a first run, then
 * relaunches the same directory with `--start-new --force`. The sentinel must
 * be gone — `--start-new` promises a clean workspace — while the prior
 * `.hankweave/` is preserved as a `.hankweave.backup-*`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import { generateTestTimestamp, getFreePort, rimrafSimple } from "../utils/test-helpers.js";

const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TEST_AREA = path.join(TEST_ROOT, "tests/test-area");

describe("--start-new --force wipes agentRoot/", () => {
  const dirsToCleanup: string[] = [];

  afterEach(async () => {
    for (const dir of dirsToCleanup) {
      await rimrafSimple(dir);
    }
    dirsToCleanup.length = 0;
  });

  test("removes stale outputs from agentRoot/ on a forced fresh start", async () => {
    fs.mkdirSync(TEST_AREA, { recursive: true });

    const testTimestamp = generateTestTimestamp();
    const port = await getFreePort();
    const execDir = path.join(TEST_AREA, `startnew-force-agentroot-${testTimestamp}`);
    dirsToCleanup.push(execDir);

    // Step 1: First run — creates .hankweave/ and agentRoot/ in execDir.
    // --no-autostart keeps the run from starting codons (we only need the
    // execution directory scaffolding), which keeps the log clean and avoids a
    // start-then-immediately-stop race.
    const firstServer = await launchHankweave({
      port,
      executionDir: execDir,
      extraArgs: ["--no-autostart"],
    });
    try {
      await firstServer.waitForEvent("server.ready", 30_000);
      // Brief pause so metadata + agentRoot are fully written.
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      await firstServer.stop();
    }

    const agentRoot = path.join(execDir, "agentRoot");
    expect(fs.existsSync(agentRoot)).toBe(true);

    // Step 2: Plant a stale output that a fresh run must NOT see.
    const staleOutput = path.join(agentRoot, "STALE_LEAK.txt");
    fs.writeFileSync(staleOutput, "stale output from a prior run");
    const staleNested = path.join(agentRoot, "stale-subdir", "old-result.json");
    fs.mkdirSync(path.dirname(staleNested), { recursive: true });
    fs.writeFileSync(staleNested, '{"passed": true}');

    // Step 3: Relaunch the same directory with --start-new --force.
    const freshServer = await launchHankweave({
      port,
      executionDir: execDir,
      reuseTestDirectory: true,
      extraArgs: ["--start-new", "--force", "-y", "--no-autostart"],
    });
    try {
      await freshServer.waitForEvent("server.ready", 30_000);
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      await freshServer.stop();
    }

    // Step 4: The stale outputs must be gone — agentRoot/ should be clean.
    expect(fs.existsSync(staleOutput)).toBe(false);
    expect(fs.existsSync(staleNested)).toBe(false);

    // The prior .hankweave/ is preserved as a backup (not destroyed).
    const backupDir = fs.readdirSync(execDir).find((e) => e.startsWith(".hankweave.backup-"));
    if (!backupDir) throw new Error("expected a .hankweave.backup-* directory to be created");

    // Step 5: The fresh checkpoint git store must be in good shape — a valid
    // repo whose work tree (agentRoot) is the wiped one, so no stale output is
    // tracked, committed, or lingering as untracked cruft.
    const checkpointGitDir = path.join(
      execDir,
      ".hankweave",
      "checkpoints",
      ".hankweavecheckpoints",
    );
    expect(fs.existsSync(checkpointGitDir)).toBe(true);

    const git = (gitDir: string, workTree: string, gitArgs: string[]): string =>
      execFileSync("git", gitArgs, {
        env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: workTree },
        encoding: "utf8",
      }).trim();

    // The repo is valid and HEAD resolves (the fresh "Initial checkpoint setup").
    expect(() => git(checkpointGitDir, agentRoot, ["rev-parse", "HEAD"])).not.toThrow();

    // No stale path is tracked in the index/HEAD of the fresh store...
    const tracked = git(checkpointGitDir, agentRoot, ["ls-files"]).split("\n").filter(Boolean);
    expect(tracked).not.toContain("STALE_LEAK.txt");
    expect(tracked.some((f) => f.startsWith("stale-subdir/"))).toBe(false);

    // ...and no commit anywhere in history ever referenced them.
    const everCommitted = git(checkpointGitDir, agentRoot, [
      "log",
      "--all",
      "--name-only",
      "--pretty=format:",
    ]);
    expect(everCommitted).not.toContain("STALE_LEAK.txt");
    expect(everCommitted).not.toContain("old-result.json");

    // git status carries no leftover stale files (tracked-deleted or untracked).
    const status = git(checkpointGitDir, agentRoot, ["status", "--porcelain"]);
    expect(status).not.toContain("STALE_LEAK.txt");
    expect(status).not.toContain("stale-subdir");

    // The prior run's checkpoint history is preserved in the backup — a separate,
    // valid repo, so the fresh store is genuinely new rather than the old one.
    const backupGitDir = path.join(execDir, backupDir, "checkpoints", ".hankweavecheckpoints");
    expect(fs.existsSync(backupGitDir)).toBe(true);
    expect(() =>
      git(backupGitDir, path.join(execDir, "agentRoot"), ["rev-parse", "HEAD"]),
    ).not.toThrow();
  }, 120_000);

  test("--no-wipe preserves agentRoot/ on a forced fresh start", async () => {
    fs.mkdirSync(TEST_AREA, { recursive: true });

    const testTimestamp = generateTestTimestamp();
    const port = await getFreePort();
    const execDir = path.join(TEST_AREA, `startnew-force-agentroot-nowipe-${testTimestamp}`);
    dirsToCleanup.push(execDir);

    // Step 1: First run — creates .hankweave/ and agentRoot/ in execDir.
    const firstServer = await launchHankweave({
      port,
      executionDir: execDir,
      extraArgs: ["--no-autostart"],
    });
    try {
      await firstServer.waitForEvent("server.ready", 30_000);
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      await firstServer.stop();
    }

    const agentRoot = path.join(execDir, "agentRoot");
    expect(fs.existsSync(agentRoot)).toBe(true);

    // Step 2: Inject a file directly into agentRoot/ (the out-of-band workflow
    // --no-wipe exists to support — material that never went through data/).
    const injected = path.join(agentRoot, "INJECTED.txt");
    fs.writeFileSync(injected, "injected directly into agentRoot");
    const injectedNested = path.join(agentRoot, "injected-subdir", "context.json");
    fs.mkdirSync(path.dirname(injectedNested), { recursive: true });
    fs.writeFileSync(injectedNested, '{"keep": true}');

    // Step 3: Relaunch with --start-new --force --no-wipe.
    const freshServer = await launchHankweave({
      port,
      executionDir: execDir,
      reuseTestDirectory: true,
      extraArgs: ["--start-new", "--force", "--no-wipe", "-y", "--no-autostart"],
    });
    try {
      await freshServer.waitForEvent("server.ready", 30_000);
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      await freshServer.stop();
    }

    // Step 4: The injected files must survive — --no-wipe keeps agentRoot/.
    expect(fs.existsSync(injected)).toBe(true);
    expect(fs.readFileSync(injected, "utf8")).toBe("injected directly into agentRoot");
    expect(fs.existsSync(injectedNested)).toBe(true);

    // The prior .hankweave/ is still backed up (force semantics are unchanged).
    const backupDir = fs.readdirSync(execDir).find((e) => e.startsWith(".hankweave.backup-"));
    if (!backupDir) throw new Error("expected a .hankweave.backup-* directory to be created");

    // Step 5: The fresh checkpoint store is a valid repo whose work tree is the
    // preserved agentRoot. The initial checkpoint commit is empty, so the
    // injected files show up as untracked in the work tree — present and ready
    // to be captured on the first codon checkpoint, not lost.
    const checkpointGitDir = path.join(
      execDir,
      ".hankweave",
      "checkpoints",
      ".hankweavecheckpoints",
    );
    expect(fs.existsSync(checkpointGitDir)).toBe(true);

    const git = (gitDir: string, workTree: string, gitArgs: string[]): string =>
      execFileSync("git", gitArgs, {
        env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: workTree },
        encoding: "utf8",
      }).trim();

    expect(() => git(checkpointGitDir, agentRoot, ["rev-parse", "HEAD"])).not.toThrow();

    const status = git(checkpointGitDir, agentRoot, ["status", "--porcelain"]);
    expect(status).toContain("INJECTED.txt");
    expect(status).toContain("injected-subdir/");
  }, 120_000);
});
