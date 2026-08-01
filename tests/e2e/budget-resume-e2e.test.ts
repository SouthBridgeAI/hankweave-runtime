#!/usr/bin/env bun
/**
 * Budget spending carries over when a run is resumed.
 *
 * Split out of `budget.test.ts`, which is otherwise entirely replay-driven and
 * therefore free. This one test cannot be: it needs the first codon to actually
 * overspend its share against a real provider, so that the continuation run has
 * genuine prior spending to account for. Leaving it in the offline suite made
 * that suite quietly cost ~$0.15 a run and require an `ANTHROPIC_API_KEY` that
 * the offline tier does not declare — so in CI it would have failed rather than
 * skipped.
 */
import { describe, expect, it } from "bun:test";
import type { CodonCompletedEvent, ServerReadyEvent } from "../../server/schemas/event-schemas.js";
import { launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import { getFreePort, waitForPortFree } from "../utils/test-helpers.js";

describe("Budget carry-over across resume", () => {
  it("should carry over budget spending from previous run on resume", async () => {
    const port = await getFreePort();

    // Global maxDollars=$0.002, 2 codons with shared allocation (default).
    // First codon (file creation) costs ~$0.003–0.005, exceeding its uniform share of $0.001.
    // After stop and resume, the continuation run's Budget should account for
    // Run 1's spending when computing the remaining pool for followup-codon.
    //
    // Correct behavior: alreadySpent=$0.003+, globalRemaining=max(0,$0.002-$0.003)=$0,
    //   followup-codon gets $0 → immediately exceeds budget.
    // Bug behavior: Budget starts fresh on resume (alreadySpent=0),
    //   followup-codon gets full $0.002 → completes normally without budget exceeded.
    const hankweave = await launchHankweave({
      configPath: "tests/config/test-budget-resume.config.json",
      port,
      logPrefix: "[budget-resume-test]",
    });

    let execDir = "";

    try {
      const readyEvent = (await hankweave.waitForEvent("server.ready")) as ServerReadyEvent;
      expect(readyEvent.data.executionPath).toBeDefined();
      execDir = hankweave.executionDir;

      // --- Run 1: budget-codon should exceed its uniform share ---

      await hankweave.waitForCodonStart("budget-codon", undefined, 120_000);

      const budgetCompleted = (await hankweave.waitForCodonCompletion(
        "budget-codon",
        undefined,
        300_000,
      )) as CodonCompletedEvent;

      expect(budgetCompleted.data.success).toBe(true);
      expect(budgetCompleted.data.budgetExceeded).toBeDefined();
      expect(budgetCompleted.data.budgetExceeded?.currency).toBe("cost");

      // Record how much the first codon actually spent
      const firstCodonCost = budgetCompleted.data.budgetExceeded?.used ?? 0;
      expect(firstCodonCost).toBeGreaterThan(0.001); // Should exceed the $0.001 uniform share

      // Stop the server (graceful SIGINT) before followup-codon finishes
      await hankweave.stop();
    } finally {
      if (hankweave.process.exitCode === null && hankweave.process.signalCode === null) {
        await hankweave.stop();
      }
    }

    // `stop()` above awaits the child's exit, but the OS can hold the socket
    // briefly past process death — drain it explicitly before rebinding the
    // same number (same discipline as e2e-data-mismatch).
    expect(await waitForPortFree(port)).toBe(true);

    const resumedServer = await launchHankweave({
      configPath: "tests/config/test-budget-resume.config.json",
      port,
      executionDir: execDir,
      reuseTestDirectory: true,
      sendPreviousEvents: true,
      logPrefix: "[budget-resume-resumed]",
    });

    try {
      // Wait for server ready
      await resumedServer.waitForEvent("server.ready", 60_000);

      // followup-codon runs in the continuation run
      await resumedServer.waitForCodonStart("followup-codon", undefined, 120_000);

      const followupCompleted = (await resumedServer.waitForCodonCompletion(
        "followup-codon",
        undefined,
        300_000,
      )) as CodonCompletedEvent;

      expect(followupCompleted.data.success).toBe(true);

      // KEY ASSERTION: If budget carry-over works correctly, the global pool ($0.002)
      // is already exhausted by budget-codon's spending ($0.003+) from Run 1.
      // The followup-codon should get maxDollars=$0 and immediately exceed.
      expect(followupCompleted.data.budgetExceeded).toBeDefined();
      expect(followupCompleted.data.budgetExceeded?.currency).toBe("cost");

      await resumedServer.waitForRunToComplete(60_000);
      await resumedServer.waitForConnectionClose(60_000);
    } finally {
      if (resumedServer.process.exitCode === null && resumedServer.process.signalCode === null) {
        await resumedServer.stop();
      }
    }
  }, 600_000);
});
