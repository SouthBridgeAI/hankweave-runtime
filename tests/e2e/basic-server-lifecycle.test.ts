#!/usr/bin/env bun
import { describe, expect, it } from "bun:test";
import type {
  PhaseCompletedEvent,
  PhaseStartedEvent,
  RollbackCompletedEvent,
} from "../../server/schemas/event-schemas.js";
import { PhaseId } from "../../server/types/branded-types.js";
import { launchBasicServer } from "../utils/server-process-helper.js";

describe("basic server lifecycle", () => {
  it("start the tadpole server and wait for phase 1 to complete", async () => {
    const server = await launchBasicServer();

    expect(server.hasLockFile()).toBeTrue();

    const phaseOne = PhaseId("phase-1");

    try {
      await server.waitForEvent("server.ready", 30_000);
      const phase1Started = (await server.waitForPhaseStart(phaseOne, 60_000)) as PhaseStartedEvent;
      const phase1Completed = (await server.waitForPhaseCompletion(
        phaseOne,
        120_000,
        phase1Started.timestamp,
      )) as PhaseCompletedEvent;

      expect(phase1Completed.data.phaseId).toBe(phaseOne);
    } finally {
      await server.stop();
    }

    expect(server.process.exitCode !== null || server.process.signalCode !== null).toBeTrue();
  }, 120_000);

  it("should recover from server STOP and resume from phase 2 without replaying phase 1", async () => {
    // testing a case of "gracious" interruption
    const server = await launchBasicServer();
    const phaseOne = PhaseId("phase-1");
    const phaseTwo = PhaseId("phase-2");

    let secondServer = null;

    try {
      // Wait for server to be ready
      await server.waitForEvent("server.ready", 30_000);

      // Wait for phase 1 to start
      const phase1Started = (await server.waitForPhaseStart(phaseOne, 60_000)) as PhaseStartedEvent;
      expect(phase1Started.data.phaseId).toBe(phaseOne);

      // Wait for phase 2 to start
      const phase2Started = (await server.waitForPhaseStart(
        phaseTwo,
        120_000,
        phase1Started.timestamp,
      )) as PhaseStartedEvent;
      expect(phase2Started.data.phaseId).toBe(phaseTwo);

      // Give server a moment to persist state
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // stop the server
      await server.stop(5_000);

      // Verify server exited
      expect(server.process.exitCode !== null || server.process.signalCode !== null).toBeTrue();

      // Small delay before reconnecting
      await new Promise((resolve) => setTimeout(resolve, 1000));

      expect(server.hasLockFile()).toBeFalse();

      // relaunch the server and request previous events to capture rollback
      secondServer = await launchBasicServer({
        reuseTestDirectory: true,
        sendPreviousEvents: true,
      });

      // Wait for rollback to complete and verify it restored to phase 2
      const rollbackCompleted = (await secondServer.waitForEvent(
        "rollback.completed",
        30_000,
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
      if (server.process.exitCode === null && server.process.signalCode === null) {
        await server.stop();
      }
    }
  }, 180_000);

  it("should recover from server KILL and resume from phase 2 without replaying phase 1", async () => {
    // testing a case of "ungracious" interruption (crash/SIGKILL)
    const server = await launchBasicServer();
    const phaseOne = PhaseId("phase-1");
    const phaseTwo = PhaseId("phase-2");

    let secondServer = null;

    try {
      // Wait for server to be ready
      await server.waitForEvent("server.ready", 30_000);

      // Wait for phase 1 to start
      const phase1Started = (await server.waitForPhaseStart(phaseOne, 60_000)) as PhaseStartedEvent;
      expect(phase1Started.data.phaseId).toBe(phaseOne);

      // Wait for phase 2 to start
      const phase2Started = (await server.waitForPhaseStart(
        phaseTwo,
        120_000,
        phase1Started.timestamp,
      )) as PhaseStartedEvent;
      expect(phase2Started.data.phaseId).toBe(phaseTwo);

      // Give server a moment to persist state
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // kill the server (SIGKILL - simulates crash)
      await server.kill(5_000);

      // Verify server exited
      expect(server.process.exitCode !== null || server.process.signalCode !== null).toBeTrue();

      // Small delay before reconnecting
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // lock file should be lingering after crash
      expect(server.hasLockFile()).toBeTrue();

      // relaunch the server and request previous events to capture rollback
      secondServer = await launchBasicServer({
        reuseTestDirectory: true,
        sendPreviousEvents: true,
      });

      // Wait for rollback to complete and verify it restored to phase 2
      const rollbackCompleted = (await secondServer.waitForEvent(
        "rollback.completed",
        30_000,
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
      if (server.process.exitCode === null && server.process.signalCode === null) {
        await server.stop();
      }
    }
  }, 180_000);
});
