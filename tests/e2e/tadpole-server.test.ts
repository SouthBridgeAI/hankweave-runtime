#!/usr/bin/env bun
import { describe, expect, it } from "bun:test";
import type {
  PhaseCompletedEvent,
  PhaseStartedEvent,
  RollbackCompletedEvent,
} from "../../server/schemas/event-schemas.js";
import { PhaseId } from "../../server/types/branded-types.js";
import { launchTadpole } from "../utils/tadpole-server.js";

describe("tadpole server", () => {
  it("starts and stops when asked to", async () => {
    const tadpole = await launchTadpole();

    expect(tadpole.hasLockFile()).toBeTrue();

    const phaseOne = PhaseId("phase-1");

    try {
      await tadpole.waitForEvent("server.ready");
      const phase1Started = (await tadpole.waitForPhaseStart(
        phaseOne,
        60_000,
      )) as PhaseStartedEvent;
      const phase1Completed = (await tadpole.waitForPhaseCompletion(
        phaseOne,
        120_000,
        phase1Started.timestamp,
      )) as PhaseCompletedEvent;

      expect(phase1Completed.data.phaseId).toBe(phaseOne);
    } finally {
      await tadpole.stop();
    }

    expect(tadpole.process.exitCode !== null || tadpole.process.signalCode !== null).toBeTrue();
  }, 120_000);

  it("recovers from server STOP and resumes from where it stopped", async () => {
    // testing a case of "gracious" interruption
    const tadpole = await launchTadpole();
    const phaseOne = PhaseId("phase-1");
    const phaseTwo = PhaseId("phase-2");

    let secondServer = null;

    try {
      // Wait for tadpole to be ready
      await tadpole.waitForEvent("server.ready");

      // Wait for phase 1 to start
      const phase1Started = (await tadpole.waitForPhaseStart(
        phaseOne,
        60_000,
      )) as PhaseStartedEvent;
      expect(phase1Started.data.phaseId).toBe(phaseOne);

      // Wait for phase 2 to start
      const phase2Started = (await tadpole.waitForPhaseStart(
        phaseTwo,
        120_000,
        phase1Started.timestamp,
      )) as PhaseStartedEvent;
      expect(phase2Started.data.phaseId).toBe(phaseTwo);

      // Give server a moment to persist state
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // stop the server
      await tadpole.stop(5_000);

      // Verify server exited
      expect(tadpole.process.exitCode !== null || tadpole.process.signalCode !== null).toBeTrue();

      // Small delay before reconnecting
      await new Promise((resolve) => setTimeout(resolve, 1000));

      expect(tadpole.hasLockFile()).toBeFalse();

      // relaunch the server and request previous events to capture rollback
      secondServer = await launchTadpole({
        reuseTestDirectory: true,
        sendPreviousEvents: true,
      });

      // Wait for rollback to complete and verify it restored to phase 2
      const rollbackCompleted = (await secondServer.waitForEvent(
        "rollback.completed",
      )) as RollbackCompletedEvent;

      expect(rollbackCompleted.data.phaseId).toBe(phaseOne);

      // Verify phase 2 resumes without replaying phase 1
      const resumedPhase = (await secondServer.waitForPhaseStart(
        phaseTwo,
        60_000,
      )) as PhaseStartedEvent;

      expect(resumedPhase.data.phaseId).toBe(phaseTwo);
    } finally {
      // Clean up the second server if it's running
      if (
        secondServer &&
        secondServer.process.exitCode === null &&
        secondServer.process.signalCode === null
      ) {
        await secondServer.stop();
      }

      // Clean up the first server if somehow still running
      if (tadpole.process.exitCode === null && tadpole.process.signalCode === null) {
        await tadpole.stop();
      }
    }
  }, 180_000);

  it("recovers from server KILL and resumes from where it stopped", async () => {
    // testing a case of "ungracious" interruption (crash/SIGKILL)
    let tadpole = await launchTadpole();
    const phaseOne = PhaseId("phase-1");
    const phaseTwo = PhaseId("phase-2");

    try {
      // Wait for tadpole to be ready
      await tadpole.waitForEvent("server.ready");

      // Wait for phase 1 to start
      const phase1Started = (await tadpole.waitForPhaseStart(phaseOne)) as PhaseStartedEvent;
      expect(phase1Started.data.phaseId).toBe(phaseOne);

      // Wait for phase 2 to start
      const phase2Started = (await tadpole.waitForPhaseStart(
        phaseTwo,
        120_000,
        phase1Started.timestamp,
      )) as PhaseStartedEvent;
      expect(phase2Started.data.phaseId).toBe(phaseTwo);

      // Give server a moment to persist state
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // kill the tadpole (SIGKILL - simulates crash)
      await tadpole.kill(5_000);

      // Verify tadpole exited
      expect(tadpole.process.exitCode !== null || tadpole.process.signalCode !== null).toBeTrue();

      // Small delay before reconnecting
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // lock file should be lingering after crash
      expect(tadpole.hasLockFile()).toBeTrue();

      // relaunch the server and request previous events to capture rollback
      tadpole = await launchTadpole({
        reuseTestDirectory: true,
        sendPreviousEvents: true,
      });

      // Wait for rollback to complete and verify it restored to phase 2
      const rollbackCompleted = (await tadpole.waitForEvent(
        "rollback.completed",
      )) as RollbackCompletedEvent;

      expect(rollbackCompleted.data.phaseId).toBe(phaseOne);

      // Verify phase 2 resumes without replaying phase 1
      const resumedPhase = (await tadpole.waitForPhaseStart(phaseTwo, 60_000)) as PhaseStartedEvent;

      expect(resumedPhase.data.phaseId).toBe(phaseTwo);
    } finally {
      // Clean up the second server if it's running
      if (tadpole && tadpole.process.exitCode === null && tadpole.process.signalCode === null) {
        await tadpole.stop();
      }
    }
  }, 180_000);
});
