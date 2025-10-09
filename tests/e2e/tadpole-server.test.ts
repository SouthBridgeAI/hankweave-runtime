#!/usr/bin/env bun
import { describe, expect, it } from "bun:test";
import type {
  HistoryBatchEvent,
  PhaseCompletedEvent,
  PhaseStartedEvent,
  RollbackCompletedEvent,
} from "../../server/schemas/event-schemas.js";
import { PhaseId } from "../../server/types/branded-types.js";
import { connectTadpoleClient, launchTadpole } from "../utils/tadpole-server.js";

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

  it("allows a second client to connect and stream event history", async () => {
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
      const totalEvents = clientSetup.handshakeResponse?.data.totalEvents || 0;

      // Verify we received events (should be limited by handshakeHistoryLimit)
      expect(initialEventHistory.length).toBeGreaterThan(0);
      // default handshakeHistoryLimit is 50
      expect(initialEventHistory.length).toBeLessThanOrEqual(50);

      expect(totalEvents).toBeGreaterThan(initialEventHistory.length);

      if (!secondClient) {
        throw new Error("Client not connected");
      }

      const historyStreamPromise = new Promise<{
        batches: Array<HistoryBatchEvent>;
      }>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Timed out waiting for history.batch")),
          10_000,
        );

        if (!secondClient) {
          return reject(new Error("Client not connected"));
        }

        const originalOnMessage = secondClient.onmessage;
        const batches: Array<HistoryBatchEvent> = [];

        secondClient.onmessage = (event) => {
          const data = JSON.parse(event.data.toString());

          if (data.type !== "history.batch") {
            return;
          }

          batches.push(data);

          if (!data.data.hasMore && secondClient) {
            clearTimeout(timeout);
            secondClient.onmessage = originalOnMessage;
            resolve({ batches });
          }
        };
      });

      secondClient.send(
        JSON.stringify({
          id: "history-sync-test",
          type: "history.sync",
        }),
      );

      const { batches } = await historyStreamPromise;
      const finalBatch = batches[batches.length - 1];
      const combined = [...initialEventHistory, ...batches.flatMap((batch) => batch.data.events)];

      expect(batches.length).toBeGreaterThan(0);
      expect(finalBatch.data.hasMore).toBe(false);

      // Verify key events are present in the combined snapshot of events we saw
      expect(combined.find((e) => e.type === "server.ready")).toBeDefined();

      expect(
        combined.find(
          (e) => e.type === "phase.started" && (e as PhaseStartedEvent).data.phaseId === phaseOne,
        ),
      ).toBeDefined();

      expect(
        combined.find(
          (e) =>
            e.type === "phase.completed" && (e as PhaseCompletedEvent).data.phaseId === phaseOne,
        ),
      ).toBeDefined();

      // Verify we have a sizable chunk of ping events (history snapshots only)
      expect(combined.filter((e) => e.type === "pong").length).toBeGreaterThan(0);
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
