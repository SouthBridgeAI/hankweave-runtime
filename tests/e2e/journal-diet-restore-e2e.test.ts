#!/usr/bin/env bun
/**
 * E2E for the finalize-time journal diet's offline surface (diet P4):
 *
 *  1. `hankweave --diet-journal <exec>` compresses a finished execution's
 *     journal (CLI exit 0, original gone, diet triple present).
 *  2. `hankweave --restore-journal <exec>` rebuilds events.jsonl
 *     byte-for-byte (proven by SHA-256 against the pre-diet original).
 *  3. The runtime AUTO-RESTORES when booting on a dieted directory — the
 *     original journal comes back as a byte prefix of the post-boot journal,
 *     and the stale diet pair is pruned (CAS kept).
 *
 * Keyless and codon-free: --no-autostart everywhere, zero API spend.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import {
  generateTestTimestamp,
  getFreePort,
  rimrafSimple,
  waitForCondition,
  waitForPortFree,
} from "../utils/test-helpers.js";

const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TEST_AREA = path.join(TEST_ROOT, "tests/test-area");
const KEYLESS_CONFIG = path.join(TEST_ROOT, "tests/config/test-codons-keyless.config.json");
const SERVER_ENTRY = path.join(TEST_ROOT, "server/index.ts");

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn("bun", [SERVER_ENTRY, ...args], {
      cwd: TEST_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HANKWEAVE_DISABLE_TELEMETRY: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("journal diet + restore CLI", () => {
  const dirsToCleanup: string[] = [];

  afterEach(async () => {
    for (const dir of dirsToCleanup) {
      await rimrafSimple(dir);
    }
    dirsToCleanup.length = 0;
  });

  test("diet CLI → restore CLI (byte-identical) → boot auto-restores", async () => {
    fs.mkdirSync(TEST_AREA, { recursive: true });
    const execDir = path.join(TEST_AREA, `journal-diet-${generateTestTimestamp()}`);
    dirsToCleanup.push(execDir);
    const journalPath = path.join(execDir, ".hankweave", "events", "events.jsonl");

    // Step 1: scaffold the execution directory with a clean boot (no codons).
    // dietOnFinalize is on by default and even this idle boot's run goes
    // terminal (RunFailed) at SIGINT — disable it so shutdown leaves the raw
    // events.jsonl for the OFFLINE diet CLI this test exists to exercise.
    const port = await getFreePort();
    const firstServer = await launchHankweave({
      port,
      configPath: KEYLESS_CONFIG,
      executionDir: execDir,
      extraArgs: ["--no-autostart"],
      env: { HANKWEAVE_RUNTIME_DIET_ON_FINALIZE: "false" },
    });
    try {
      await firstServer.waitForEvent("server.ready", 30_000);
      await waitForCondition(() => fs.existsSync(journalPath));
    } finally {
      await firstServer.stop();
    }
    await waitForCondition(() => !firstServer.hasLockFile());
    await waitForPortFree(port);

    const originalJournal = fs.readFileSync(journalPath);
    const originalSha = sha256(originalJournal);

    // Step 2a: the diet CLI must refuse while a live pid holds runtime.lock —
    // in the current JSON format AND the legacy bare-pid format (Codex round
    // 2: the legacy format previously slipped through and could lose events
    // appended after the unlink). This test's own pid is conveniently alive.
    const lockPath = path.join(execDir, ".hankweave", "runtime.lock");
    for (const liveLock of [
      JSON.stringify({ pid: process.pid, lastHeartbeat: new Date().toISOString() }),
      String(process.pid),
    ]) {
      fs.writeFileSync(lockPath, liveLock);
      const refused = await runCli(["--diet-journal", execDir]);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("not dieting");
      expect(fs.existsSync(journalPath)).toBe(true);
    }
    // An unparseable lock fails closed too — including one that merely
    // STARTS with digits ("123-corrupt" is not a legacy bare-pid lock).
    for (const garbage of ["@@@ not a lock @@@", "123-corrupt"]) {
      fs.writeFileSync(lockPath, garbage);
      const refusedGarbage = await runCli(["--diet-journal", execDir]);
      expect(refusedGarbage.code).not.toBe(0);
      expect(refusedGarbage.stderr).toContain("could not be parsed");
    }
    fs.unlinkSync(lockPath);

    // Step 2: diet via the CLI.
    const diet = await runCli(["--diet-journal", execDir]);
    expect(diet.stderr).toBe("");
    expect(diet.code).toBe(0);
    expect(diet.stdout).toContain("Journal dieted");
    expect(fs.existsSync(journalPath)).toBe(false);
    expect(fs.existsSync(path.join(execDir, ".hankweave", "events", "events.jsonl.zst"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(execDir, ".hankweave", "events", "journal.meta.json"))).toBe(
      true,
    );

    // Step 3: restore via the CLI; byte identity is the whole point.
    const restore = await runCli(["--restore-journal", execDir]);
    expect(restore.stderr).toBe("");
    expect(restore.code).toBe(0);
    expect(restore.stdout).toContain("Journal restored");
    expect(sha256(fs.readFileSync(journalPath))).toBe(originalSha);

    // Restore twice: second run verifies and exits 0.
    const restoreAgain = await runCli(["--restore-journal", execDir]);
    expect(restoreAgain.code).toBe(0);
    expect(restoreAgain.stdout).toContain("already restored");

    // Step 4: diet again so the boot below starts from a dieted directory.
    const redietRun = await runCli(["--diet-journal", execDir]);
    expect(redietRun.code).toBe(0);
    expect(fs.existsSync(journalPath)).toBe(false);

    // Step 5: booting on the dieted directory AUTO-RESTORES the journal in
    // place and proceeds — resume just works. Diet-at-finalize is disabled
    // for this server so the raw journal survives its shutdown for the
    // assertions below.
    const secondServer = await launchHankweave({
      port,
      configPath: KEYLESS_CONFIG,
      executionDir: execDir,
      reuseTestDirectory: true,
      extraArgs: ["--no-autostart"],
      env: { HANKWEAVE_RUNTIME_DIET_ON_FINALIZE: "false" },
    });
    try {
      await secondServer.waitForEvent("server.ready", 30_000);
    } finally {
      await secondServer.stop();
    }

    // The restored original is a strict byte prefix of the journal (the boot
    // appended its own events after it), and the stale diet pair is pruned
    // while the CAS is kept for the next diet's dedup.
    const afterBoot = fs.readFileSync(journalPath);
    expect(afterBoot.length).toBeGreaterThan(originalJournal.length);
    expect(afterBoot.subarray(0, originalJournal.length).equals(originalJournal)).toBe(true);
    expect(fs.existsSync(path.join(execDir, ".hankweave", "events", "events.jsonl.zst"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(execDir, ".hankweave", "events", "journal.meta.json"))).toBe(
      false,
    );
    // (No CAS assertion: this scaffold journal has no body >= 4 KB, so the
    // diet never created one. CAS retention is covered by the unit tests.)
  }, 120_000);
});
