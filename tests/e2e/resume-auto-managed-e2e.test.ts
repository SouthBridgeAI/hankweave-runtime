#!/usr/bin/env bun
/**
 * ENG-198: Resume of auto-managed executions
 *
 *
 * Demonstrates the bug where the Tier-1 safety check in execution-setup.ts
 * unconditionally blocks all --execution paths inside ~/.hankweave-executions/,
 * even for existing executions with valid metadata. This makes the resume hint
 * shown by the TUI guaranteed to fail.
 *
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerReadyEvent } from "../../server/schemas/event-schemas.js";
import { launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import {
  generateTestTimestamp,
  getFreePort,
  rimrafSimple,
  waitForCondition,
} from "../utils/test-helpers.js";

const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TEST_AREA = path.join(TEST_ROOT, "tests/test-area");
// Fake managed executions root (set in beforeAll). The suite tests managed-space
// guard rails, which need *a* managed root — not the developer's real
// ~/.hankweave-executions. Every launched server gets the same root via
// HANKWEAVE_RUNTIME_EXECUTION_BASE_DIR in its env.
let MANAGED_EXEC_BASE: string;
const TEST_PREFIX = "__test-eng198-";

describe("ENG-198: Resume auto-managed executions", () => {
  const managedDirsToCleanup: string[] = [];
  const normalDirsToCleanup: string[] = [];

  beforeAll(async () => {
    // Fresh fake root per run — nothing stale to clean, nothing real to touch.
    MANAGED_EXEC_BASE = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "hankweave-eng198-managed-"),
    );
  });

  afterAll(async () => {
    if (MANAGED_EXEC_BASE) await rimrafSimple(MANAGED_EXEC_BASE);
  });

  afterEach(async () => {
    for (const dir of managedDirsToCleanup) {
      await rimrafSimple(dir);
    }
    managedDirsToCleanup.length = 0;
    for (const dir of normalDirsToCleanup) {
      await rimrafSimple(dir);
    }
    normalDirsToCleanup.length = 0;
  });

  test("should resume an existing execution copied into managed space", async () => {
    // ENG-198: The Tier-1 check in execution-setup.ts used to block ALL --execution
    // paths inside ~/.hankweave-executions/, including valid existing executions.
    // This test verifies the fix: resuming from managed space should work.
    //
    // Note: The first server is stopped before any codon completes, so the resumed
    // server starts a fresh run (no checkpoints to continue from). This is correct
    // behavior — the key assertion is that the Tier-1 check doesn't block it.

    fs.mkdirSync(TEST_AREA, { recursive: true });

    const testTimestamp = generateTestTimestamp();
    const port = await getFreePort();
    // Use single-codon haiku config to avoid flaky Gemini failures
    const configPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../config/test-resume-after-kill.config.json",
    );

    // Step 1: Create a valid execution in normal test area
    const normalExecDir = path.join(TEST_AREA, `eng198-source-${testTimestamp}`);
    normalDirsToCleanup.push(normalExecDir);

    const firstServer = await launchHankweave({
      port,
      configPath,
      executionDir: normalExecDir,
      env: { HANKWEAVE_RUNTIME_EXECUTION_BASE_DIR: MANAGED_EXEC_BASE },
    });

    try {
      await firstServer.waitForEvent("server.ready", 30_000);
      // The copy below is only a valid execution once metadata is on disk, so
      // wait for the file the next step asserts on.
      await waitForCondition(() =>
        fs.existsSync(path.join(normalExecDir, ".hankweave", "execution-meta.json")),
      );
    } finally {
      await firstServer.stop();
    }

    // Step 2: Verify the execution has valid metadata
    const sourceMetaPath = path.join(normalExecDir, ".hankweave", "execution-meta.json");
    expect(fs.existsSync(sourceMetaPath)).toBe(true);

    // Step 3: Copy execution into managed space (simulates auto-created run)
    const managedExecDir = path.join(MANAGED_EXEC_BASE, `${TEST_PREFIX}resume-${testTimestamp}`);
    managedDirsToCleanup.push(managedExecDir);
    fs.cpSync(normalExecDir, managedExecDir, { recursive: true });

    // Remove stale lock file from copy (simulates clean stop)
    const lockPath = path.join(managedExecDir, ".hankweave", "runtime.lock");
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);

    // Verify meta exists at destination
    const destMetaPath = path.join(managedExecDir, ".hankweave", "execution-meta.json");
    expect(fs.existsSync(destMetaPath)).toBe(true);

    // Step 4: Resume from managed space
    // This is the exact scenario a user faces: they have an auto-managed execution
    // and try to resume it using the --execution flag as the TUI suggests.
    const resumedServer = await launchHankweave({
      port,
      configPath,
      executionDir: managedExecDir,
      reuseTestDirectory: true,
      env: { HANKWEAVE_RUNTIME_EXECUTION_BASE_DIR: MANAGED_EXEC_BASE },
    });

    try {
      // Assert server.ready event has correct execution path
      const readyEvent = (await resumedServer.waitForEvent(
        "server.ready",
        30_000,
      )) as ServerReadyEvent;
      expect(readyEvent.data.executionPath).toBe(managedExecDir);

      // Wait for the full run to complete
      await resumedServer.waitForRunToComplete(300_000);

      // Assert final state: run completed successfully
      const finalState = resumedServer.getState();
      const completedRun = finalState.runs.find(
        (r: { status: string }) => r.status === "completed",
      );
      expect(completedRun).toBeDefined();
    } finally {
      await resumedServer.stop();
    }
  }, 360_000);

  test("should block creating a new execution in managed space (no metadata)", async () => {
    // Safety check: creating a NEW execution inside ~/.hankweave-executions/
    // via --execution should still be blocked. This directory has no
    // .hankweave/execution-meta.json, so the Tier-1 check should fire.

    const port = await getFreePort();
    const newExecDir = path.join(
      MANAGED_EXEC_BASE,
      `${TEST_PREFIX}new-blocked-${generateTestTimestamp()}`,
    );
    managedDirsToCleanup.push(newExecDir);

    // The directory does not exist and has no execution-meta.json.
    // Tier-1 should block it.
    await expect(
      launchHankweave({
        port,
        executionDir: newExecDir,
        reuseTestDirectory: true,
        env: { HANKWEAVE_RUNTIME_EXECUTION_BASE_DIR: MANAGED_EXEC_BASE },
      }),
    ).rejects.toThrow();
  }, 30_000);

  test("should allow --start-new --force in managed space (backup + fresh)", async () => {
    // Edge case: user wants to start fresh in an existing managed execution dir.
    // --start-new --force should pass Tier-1 (meta exists), then backup .hankweave/
    // and create a fresh execution in the same directory.

    fs.mkdirSync(TEST_AREA, { recursive: true });

    const testTimestamp = generateTestTimestamp();
    const port = await getFreePort();
    // Use single-codon haiku config, like the resume test above — the default
    // config's codon-3 is gemini, and this suite declares only ANTHROPIC_API_KEY
    // (under key enforcement the default config cannot even pass the startup
    // self-test here).
    const configPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../config/test-resume-after-kill.config.json",
    );

    // Step 1: Create a valid execution in normal test area
    const normalExecDir = path.join(TEST_AREA, `eng198-startnew-source-${testTimestamp}`);
    normalDirsToCleanup.push(normalExecDir);

    const firstServer = await launchHankweave({
      port,
      configPath,
      executionDir: normalExecDir,
      env: { HANKWEAVE_RUNTIME_EXECUTION_BASE_DIR: MANAGED_EXEC_BASE },
    });

    try {
      await firstServer.waitForEvent("server.ready", 30_000);
      // The managed-space copy below needs the execution metadata on disk.
      await waitForCondition(() =>
        fs.existsSync(path.join(normalExecDir, ".hankweave", "execution-meta.json")),
      );
    } finally {
      await firstServer.stop();
    }

    // Step 2: Copy into managed space
    const managedExecDir = path.join(MANAGED_EXEC_BASE, `${TEST_PREFIX}startnew-${testTimestamp}`);
    managedDirsToCleanup.push(managedExecDir);
    fs.cpSync(normalExecDir, managedExecDir, { recursive: true });

    const lockPath = path.join(managedExecDir, ".hankweave", "runtime.lock");
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);

    // Step 3: Launch with --start-new --force in managed space
    const freshServer = await launchHankweave({
      port,
      configPath,
      executionDir: managedExecDir,
      reuseTestDirectory: true,
      extraArgs: ["--start-new", "--force", "-y"],
      env: { HANKWEAVE_RUNTIME_EXECUTION_BASE_DIR: MANAGED_EXEC_BASE },
    });

    try {
      await freshServer.waitForEvent("server.ready", 30_000);

      // Verify .hankweave.backup-* exists (old state was backed up)
      const entries = fs.readdirSync(managedExecDir);
      const backupDir = entries.find((e) => e.startsWith(".hankweave.backup-"));
      expect(backupDir).toBeTruthy();
    } finally {
      await freshServer.stop();
    }
  }, 120_000);

  test("should block using the managed root directory itself", async () => {
    // Even after the fix, pointing --execution at ~/.hankweave-executions/ itself
    // (the root) should fail because there is no execution-meta.json at root level.

    const port = await getFreePort();

    // Ensure the managed root exists
    fs.mkdirSync(MANAGED_EXEC_BASE, { recursive: true });

    await expect(
      launchHankweave({
        port,
        executionDir: MANAGED_EXEC_BASE,
        reuseTestDirectory: true,
        env: { HANKWEAVE_RUNTIME_EXECUTION_BASE_DIR: MANAGED_EXEC_BASE },
      }),
    ).rejects.toThrow();
  }, 30_000);
});
