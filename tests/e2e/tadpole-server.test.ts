#!/usr/bin/env bun
import { describe, expect, it } from "bun:test";
import type {
  PhaseCompletedEvent,
  PhaseStartedEvent,
  RollbackCompletedEvent,
} from "../../server/schemas/event-schemas.js";
import { PhaseId } from "../../server/types/branded-types.js";
import { connectTadpoleClient, launchTadpole, syncHistory } from "../utils/tadpole-server.js";

describe("tadpole server", () => {
  it("starts and stops when asked to", async () => {
    const tadpole = await launchTadpole();

    expect(tadpole.hasLockFile()).toBeTrue();

    const phaseOne = PhaseId("phase-1");

    try {
      await tadpole.waitForEvent("server.ready");
      const phase1Started = (await tadpole.waitForPhaseStart(phaseOne)) as PhaseStartedEvent;
      const phase1Completed = (await tadpole.waitForPhaseCompletion(
        phaseOne,
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
      const phase1Started = (await tadpole.waitForPhaseStart(phaseOne)) as PhaseStartedEvent;
      expect(phase1Started.data.phaseId).toBe(phaseOne);

      // Wait for phase 2 to start
      const phase2Started = (await tadpole.waitForPhaseStart(
        phaseTwo,
        phase1Started.timestamp,
      )) as PhaseStartedEvent;
      expect(phase2Started.data.phaseId).toBe(phaseTwo);

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
      const resumedPhase = (await secondServer.waitForPhaseStart(phaseTwo)) as PhaseStartedEvent;

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
        phase1Started.timestamp,
      )) as PhaseStartedEvent;
      expect(phase2Started.data.phaseId).toBe(phaseTwo);

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
      const resumedPhase = (await tadpole.waitForPhaseStart(phaseTwo)) as PhaseStartedEvent;

      expect(resumedPhase.data.phaseId).toBe(phaseTwo);
    } finally {
      // Clean up the second server if it's running
      if (tadpole && tadpole.process.exitCode === null && tadpole.process.signalCode === null) {
        await tadpole.stop();
      }
    }
  }, 180_000);

  it("allows a second client to connect and retrieve event history via pagination", async () => {
    // Launch tadpole with ping event generation
    const tadpole = await launchTadpole({
      generatePingEvents: 150,
    });
    const phaseOne = PhaseId("phase-1");
    let secondClient: WebSocket | null = null;

    try {
      // Wait for tadpole to be ready
      await tadpole.waitForEvent("server.ready");

      // Wait for phase 1 to complete
      const phase1Started = (await tadpole.waitForPhaseStart(phaseOne)) as PhaseStartedEvent;
      const phase1Completed = (await tadpole.waitForPhaseCompletion(
        phaseOne,
        phase1Started.timestamp,
      )) as PhaseCompletedEvent;

      expect(phase1Completed.data.phaseId).toBe(phaseOne);

      // Connect a second client and request event history
      const clientSetup = await connectTadpoleClient(tadpole.websocketServerUrl, {
        performHandshake: true,
        sendPreviousEvents: true,
      });
      secondClient = clientSetup.client;

      // Verify handshake response contains event history
      expect(clientSetup.handshakeResponse).toBeDefined();
      expect(clientSetup.handshakeResponse?.data.eventHistory).toBeDefined();

      const initialEventHistory = clientSetup.handshakeResponse?.data.eventHistory || [];
      const cursor = clientSetup.handshakeResponse?.data.cursor;
      const totalEvents = clientSetup.handshakeResponse?.data.totalEvents || 0;

      // Verify we received events (should be limited by handshakeHistoryLimit)
      expect(initialEventHistory.length).toBeGreaterThan(0);
      // default handshakeHistoryLimit is 50
      expect(initialEventHistory.length).toBeLessThanOrEqual(50);

      // We should have a cursor since we generated 150+ events
      expect(cursor).toBeDefined();
      expect(totalEvents).toBeGreaterThan(initialEventHistory.length);

      // Collect remaining events via pagination using syncHistory
      const remainingEvents = await syncHistory(secondClient, {
        cursor,
        limit: 50,
        direction: "backward",
      });

      // Combine initial and remaining events
      const allEvents = [...initialEventHistory, ...remainingEvents];

      // Verify we collected all events (or very close - allow for minor timing differences)
      // The key is that we got all the events via pagination
      expect(allEvents.length).toBeGreaterThanOrEqual(totalEvents - 5); // Allow small margin
      expect(allEvents.length).toBeLessThanOrEqual(totalEvents + 5);

      // Verify key events are present in the collected events
      expect(allEvents.find((e) => e.type === "server.ready")).toBeDefined();

      expect(
        allEvents.find(
          (e) => e.type === "phase.started" && (e as PhaseStartedEvent).data.phaseId === phaseOne,
        ),
      ).toBeDefined();

      expect(
        allEvents.find(
          (e) =>
            e.type === "phase.completed" && (e as PhaseCompletedEvent).data.phaseId === phaseOne,
        ),
      ).toBeDefined();

      // Verify we have most/all ping events (allow small margin for timing)
      expect(allEvents.filter((e) => e.type === "pong").length).toBeGreaterThanOrEqual(145);
    } finally {
      // Clean up second client
      if (
        secondClient &&
        (secondClient.readyState === WebSocket.OPEN ||
          secondClient.readyState === WebSocket.CONNECTING)
      ) {
        secondClient.close();
      }

      // Clean up server
      if (tadpole.process.exitCode === null && tadpole.process.signalCode === null) {
        await tadpole.stop();
      }
    }
  }, 180_000);
});
