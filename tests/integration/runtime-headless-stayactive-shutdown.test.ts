/**
 * Regression for the headless "stay-active" hang.
 *
 * Symptom (observed in the 0e6b87 bench run, nested failure-analysis hank):
 * a loop codon with the default onFailure:"abort" hit a RETRIABLE failure (idle
 * timeout). resolveFailureAction maps abort+retriable -> "stay-active", whose
 * intent is to park the server so an INTERACTIVE client can issue a manual
 * retry. Under --headless there is no such client, so the server parked forever
 * holding runtime.lock, and the parent process waiting on it hung too.
 *
 * Fix: in headless mode "stay-active" must fail the run and shut down (the
 * shutdown watchdog then guarantees the process exits) instead of parking.
 *
 * This drives the real handleCodonComplete -> resolveFailurePolicy -> switch and
 * asserts the headless branch shuts down (and fails the run) while the
 * interactive branch still parks.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { HankweaveRuntime } from "../../server/hankweave-runtime.js";
import { CodonId, RunId } from "../../server/types/branded-types.js";
import type { FailureReason } from "../../server/types/types.js";
import { createTestCodon } from "../utils/test-codon-factory.js";

describe("Runtime: headless stay-active must shut down, not hang", () => {
  let execDir: string;
  let runtime: HankweaveRuntime | undefined;

  const makeRuntime = (headless: boolean): HankweaveRuntime =>
    new HankweaveRuntime({
      autostart: false,
      headless,
      port: 0,
      cwd: execDir,
      executionPath: execDir,
      agentRootPath: execDir,
      rigArchivePath: path.join(execDir, "rigArchive"),
      dataPathInExecutionDir: execDir,
      readOnlySourceDataPath: execDir,
      dataHash: "test-hash",
      isNewExecution: true,
      isResuming: false,
      linkType: "symlink",
      codons: [],
      socketLogFile: path.join(execDir, ".hankweave/logs/socket.jsonl"),
      serverLogFile: path.join(execDir, ".hankweave/logs/server.log"),
      outputDirectory: execDir,
      sentinel: {
        enablePersistence: false,
        healthCheckGracePeriodMs: 0,
        waitForAllHealthChecks: false,
      },
      logParsingInterval: 5,
      dataHashTimeLimit: 5000,
      toolResultTruncateLength: 2500,
      withoutProxy: true,
      handshakeHistoryLimit: 50,
      version: "1.0.0",
      lockFile: path.join(execDir, ".hankweave/runtime.lock"),
    });

  beforeEach(() => {
    fs.mkdirSync(path.resolve("tests", "test-area"), { recursive: true });
    execDir = fs.mkdtempSync(
      path.resolve("tests", "test-area", "rt-headless-stayactive-"),
    );
    fs.mkdirSync(path.join(execDir, ".hankweave", "logs"), { recursive: true });
    fs.mkdirSync(path.join(execDir, ".hankweave", "events"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(execDir, ".hankweave", "state.json"),
      JSON.stringify({ runs: [], currentRunId: null, executionPlan: [] }),
    );
  });

  afterEach(async () => {
    try {
      await runtime?.shutdown("test cleanup", false);
    } catch {
      // never started a server; best-effort cleanup
    }
    runtime = undefined;
    fs.rmSync(execDir, { recursive: true, force: true });
  });

  // Drive a retriable failure under onFailure:"abort" (-> "stay-active") and
  // return what the switch tail did: whether shutdown was called and which
  // state transitions fired. shutdown is spied so it never calls process.exit.
  const driveRetriableAbortFailure = async (
    rt: HankweaveRuntime,
  ): Promise<{
    shutdownReasons: string[];
    transitionTypes: string[];
    completedSuccess: boolean | undefined;
  }> => {
    const codonId = CodonId("analyze-failure");
    const codon = createTestCodon({
      id: "analyze-failure",
      name: "Analyze failure",
      model: "sonnet",
      continuationMode: "fresh",
      promptText: "Test prompt",
    });
    // Default policy in production; set explicitly so the test is self-contained.
    (codon as unknown as { onFailure: string }).onFailure = "abort";

    const internals = rt as unknown as Record<string, unknown> & {
      handleCodonComplete: (
        exitCode: number,
        isContextExceeded: boolean,
        extensionCount: number,
      ) => Promise<void>;
    };

    internals.currentCodon = {
      status: "running",
      codonId,
      codon,
      startTime: new Date(),
    };
    internals.currentRunId = RunId("run-1");
    internals.checkpointingEnabled = false;
    internals.budget = null;
    internals.currentCodonSentinels = new Set();

    // The idle-timeout path classifies the failure as RETRIABLE; mirror that so
    // resolveFailureAction(abort, retriable) -> "stay-active".
    const retriableReason: FailureReason = {
      type: "timeout",
      retriable: true,
      message: "Idle timeout: no events received for 180000ms",
    };
    internals.codonFailureReason = retriableReason;
    internals.codonFailureError = new Error(retriableReason.message);

    const transitionTypes: string[] = [];
    const codonRecord = {
      status: "running",
      startTime: new Date().toISOString(),
      finalCost: 0,
      partialCost: 0,
    };
    internals.stateManager = {
      getCodonInCurrentRun: () => codonRecord,
      transition: (t: { type: string }) => {
        transitionTypes.push(t.type);
      },
      waitForPendingTransitions: async () => {},
      isContextExceededAcceptable: () => false,
      getState: () => ({ executionPlan: [] }),
    };
    internals.codonRunners = new Map();
    internals.sendStateSnapshot = async () => {};
    internals.cleanupCurrentCodon = () => {};

    // Spy on shutdown so the real switch tail runs but the process never exits.
    const shutdownReasons: string[] = [];
    internals.shutdown = async (reason: string) => {
      shutdownReasons.push(reason);
    };

    let completedSuccess: boolean | undefined;
    rt.on("event", (e: { type: string; data: unknown }) => {
      if (e.type === "codon.completed") {
        completedSuccess = (e.data as { success?: boolean }).success;
      }
    });

    await internals.handleCodonComplete(1, false, 0);

    return { shutdownReasons, transitionTypes, completedSuccess };
  };

  test("headless: retriable abort failure fails the run and shuts down (no hang)", async () => {
    runtime = makeRuntime(true);
    const { shutdownReasons, transitionTypes, completedSuccess } =
      await driveRetriableAbortFailure(runtime);

    expect(completedSuccess).toBe(false);
    // Must shut down rather than park, and must mark the run failed.
    expect(shutdownReasons.length).toBe(1);
    expect(shutdownReasons[0]).toContain("headless");
    expect(transitionTypes).toContain("RunFailed");
  });

  test("interactive: retriable abort failure stays active (server not shut down)", async () => {
    runtime = makeRuntime(false);
    const { shutdownReasons, transitionTypes, completedSuccess } =
      await driveRetriableAbortFailure(runtime);

    expect(completedSuccess).toBe(false);
    // Original behavior preserved: park for a client-driven manual retry.
    expect(shutdownReasons.length).toBe(0);
    expect(transitionTypes).not.toContain("RunFailed");
  });
});
