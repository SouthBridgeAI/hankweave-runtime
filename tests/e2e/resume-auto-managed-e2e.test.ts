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
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerReadyEvent } from "../../server/schemas/event-schemas.js";
import { launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import { generateTestTimestamp, getFreePort, rimrafSimple } from "../utils/test-helpers.js";

const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TEST_AREA = path.join(TEST_ROOT, "tests/test-area");
const MANAGED_EXEC_BASE = path.join(os.homedir(), ".hankweave-executions");
const TEST_PREFIX = "__test-eng198-";

describe("ENG-198: Resume auto-managed executions", () => {
  const managedDirsToCleanup: string[] = [];
  const normalDirsToCleanup: string[] = [];

  // Clean up stale test dirs from previous interrupted runs
  beforeAll(async () => {
    if (!fs.existsSync(MANAGED_EXEC_BASE)) return;
    const entries = await fs.promises.readdir(MANAGED_EXEC_BASE);
    for (const entry of entries) {
      if (entry.startsWith(TEST_PREFIX)) {
        await rimrafSimple(path.join(MANAGED_EXEC_BASE, entry));
      }
    }
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
    // BUG: This test demonstrates ENG-198. The Tier-1 check in execution-setup.ts
    // blocks ALL --execution paths inside ~/.hankweave-executions/, including valid
    // existing executions. The resume hint shown after an interrupted auto-managed
    // run is guaranteed to fail.

    fs.mkdirSync(TEST_AREA, { recursive: true });

    const testTimestamp = generateTestTimestamp();
    const port = await getFreePort();

    // Step 1: Create a valid execution in normal test area
    const normalExecDir = path.join(TEST_AREA, `eng198-source-${testTimestamp}`);
    normalDirsToCleanup.push(normalExecDir);

    const firstServer = await launchHankweave({
      port,
      executionDir: normalExecDir,
    });

    try {
      await firstServer.waitForEvent("server.ready", 30_000);
      // Brief pause to ensure metadata is fully written
      await new Promise((resolve) => setTimeout(resolve, 500));
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
      executionDir: managedExecDir,
      reuseTestDirectory: true,
    });

    try {
      // Assert server.ready event has correct execution path
      const readyEvent = (await resumedServer.waitForEvent(
        "server.ready",
        30_000,
      )) as ServerReadyEvent;
      expect(readyEvent.data.executionPath).toBe(managedExecDir);

      // Assert state shows this is a continuation (genuine resume), not a fresh start
      const state = resumedServer.getState();
      const currentRun = state.runs[0];
      expect(currentRun.startingConditions.type).toBe("continuation");

      // Wait for the full run to complete (all 3 codons with real LLM calls)
      await resumedServer.waitForRunToComplete(300_000);

      // Assert final state: run completed successfully
      const finalState = resumedServer.getState();
      const completedRun = finalState.runs.find((r) => r.status === "completed");
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

    // Step 1: Create a valid execution in normal test area
    const normalExecDir = path.join(TEST_AREA, `eng198-startnew-source-${testTimestamp}`);
    normalDirsToCleanup.push(normalExecDir);

    const firstServer = await launchHankweave({
      port,
      executionDir: normalExecDir,
    });

    try {
      await firstServer.waitForEvent("server.ready", 30_000);
      await new Promise((resolve) => setTimeout(resolve, 500));
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
      executionDir: managedExecDir,
      reuseTestDirectory: true,
      extraArgs: ["--start-new", "--force", "-y"],
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
      }),
    ).rejects.toThrow();
  }, 30_000);
});
