#!/usr/bin/env bun
import { describe, expect, it } from "bun:test";
import { CodonId } from "../../server/types/branded-types.js";
import type { CodonStartedEvent, RollbackCompletedEvent } from "../../server/types/types.js";
import { launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import { getFreePort, waitForCondition, waitForPortFree } from "../utils/test-helpers.js";

const traceEnv = {
  HANKWEAVE_TRACE_LANGFUSE: "1",
  HANKWEAVE_TRACE_BRAINTRUST: "", // explicitly clear in case test runner env has it
};

describe("hw-trace kill/resume lifecycle", () => {
  it("uploads trace on SIGTERM interrupt and again when resumed run completes", async () => {
    const port = await getFreePort();
    const codonOne = CodonId("codon-1");
    const codonTwo = CodonId("codon-2");

    let hankweave = await launchHankweave({
      port,
      env: traceEnv,
      logPrefix: "[hw-trace-resume]",
    });

    const execDir = hankweave.executionDir;
    // Upload logs go to stdout after ownership release, never back into the execution.
    let uploadOutput = "";
    const captureUploadOutput = () =>
      hankweave.process.stdout?.on("data", (chunk) => {
        uploadOutput += chunk.toString();
      });
    captureUploadOutput();
    const traceUploadCount = () => uploadOutput.split("> Uploading trace:").length - 1;

    try {
      await hankweave.waitForEvent("server.ready");

      // Wait for codon-1 to fully complete so its checkpoint is on disk
      const codon1Started = (await hankweave.waitForCodonStart(codonOne)) as CodonStartedEvent;
      await hankweave.waitForCodonCompletion(codonOne, codon1Started.timestamp, 120_000);

      // Wait for codon-2 to start, then interrupt via SIGTERM
      // SIGTERM → shutdown() → uploadTrace() → process.exit()
      await hankweave.waitForCodonStart(codonTwo, codon1Started.timestamp, 90_000);
      await hankweave.kill(60_000, "SIGTERM");

      // SIGTERM shuts down gracefully: the lock file is cleared and the trace is
      // uploaded on the way out. Wait for both, then for the port to be free so
      // the resume below can rebind it.
      await waitForCondition(() => !hankweave.hasLockFile() && traceUploadCount() >= 1, 30_000);
      await waitForPortFree(port);

      // Graceful shutdown cleans up the lock file
      expect(hankweave.hasLockFile()).toBeFalse();

      const firstLogs = hankweave.serverLogFile() + uploadOutput;
      expect(firstLogs).toContain("--- hankweave-trace config ---");
      // SIGTERM goes through shutdown() which calls uploadTrace() before exiting
      expect(firstLogs).toContain("> Uploading trace:");
      expect(firstLogs).toContain("--langfuse");
      expect(firstLogs).not.toContain("--braintrust");

      // Resume from the same execution directory
      hankweave = await launchHankweave({
        port,
        executionDir: execDir,
        reuseTestDirectory: true,
        sendPreviousEvents: true,
        env: traceEnv,
        logPrefix: "[hw-trace-resume-2]",
      });

      captureUploadOutput();

      // Codon-2 was mid-run when interrupted — rollback to codon-1 checkpoint
      const rollback = (await hankweave.waitForEvent(
        "rollback.completed",
      )) as RollbackCompletedEvent;
      expect(rollback.data.codonId).toBe(codonOne);

      // Run through codon-2 and codon-3 to completion
      await hankweave.waitForRunToComplete(150_000);

      // Graceful stop: shutdown() calls uploadTrace() before process.exit()
      await hankweave.stop(60_000);

      // The resumed run's shutdown uploads a second trace into the same log.
      await waitForCondition(() => traceUploadCount() >= 2, 30_000);

      const secondLogs = hankweave.serverLogFile() + uploadOutput;
      expect(secondLogs).toContain("--- hankweave-trace config ---");
      expect(secondLogs).toContain("> Uploading trace:");
      expect(secondLogs).toContain("--langfuse");
      expect(secondLogs).not.toContain("--braintrust");
    } finally {
      if (hankweave.process.exitCode === null && hankweave.process.signalCode === null) {
        await hankweave.stop(60_000);
      }
    }
  }, 300_000);
});
