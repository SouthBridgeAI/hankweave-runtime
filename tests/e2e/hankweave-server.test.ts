#!/usr/bin/env bun
import { describe, expect, it } from "bun:test";
import { CodonId } from "../../server/types/branded-types.js";
import type {
  CodonCompletedEvent,
  CodonStartedEvent,
  HistoryBatchEvent,
  RollbackCompletedEvent,
} from "../../server/types/types.js";
import { connectHankweaveClient, launchHankweave } from "../utils/hankweave-server-test-helpers.js";

describe("hankweave server", () => {
  it("starts and stops when asked to", async () => {
    console.log("DEBUG: Launching with port 9001");
    const hankweave = await launchHankweave({ port: 9001 });

    expect(hankweave.hasLockFile()).toBeTrue();

    const codonOne = CodonId("codon-1");

    try {
      await hankweave.waitForEvent("server.ready");
      const codon1Started = (await hankweave.waitForCodonStart(codonOne)) as CodonStartedEvent;
      const codon1Completed = (await hankweave.waitForCodonCompletion(
        codonOne,
        codon1Started.timestamp,
      )) as CodonCompletedEvent;

      expect(codon1Completed.data.codonId).toBe(codonOne);
    } finally {
      await hankweave.stop();
    }

    expect(hankweave.process.exitCode !== null || hankweave.process.signalCode !== null).toBeTrue();
  }, 120_000);

  it("recovers from server STOP and resumes from where it stopped", async () => {
    // testing a case of "gracious" interruption
    const hankweave = await launchHankweave({ port: 9003 });
    const codonOne = CodonId("codon-1");
    const codonTwo = CodonId("codon-2");
    const execDir = hankweave.executionDir; // Save execution directory for reuse

    let secondServer = null;

    try {
      // Wait for hankweave to be ready
      await hankweave.waitForEvent("server.ready");

      // Wait for codon 1 to start
      const codon1Started = (await hankweave.waitForCodonStart(codonOne)) as CodonStartedEvent;
      expect(codon1Started.data.codonId).toBe(codonOne);

      // Wait for codon 2 to start
      const codon2Started = (await hankweave.waitForCodonStart(
        codonTwo,
        codon1Started.timestamp,
        90_000,
      )) as CodonStartedEvent;
      expect(codon2Started.data.codonId).toBe(codonTwo);

      // stop the server
      await hankweave.stop();
      // Small delay before reconnecting
      await new Promise((resolve) => setTimeout(resolve, 3000));

      expect(hankweave.hasLockFile()).toBeFalse();

      // relaunch the server and request previous events to capture rollback
      secondServer = await launchHankweave({
        port: 9003,
        executionDir: execDir,
        reuseTestDirectory: true,
        sendPreviousEvents: true,
      });

      // Wait for rollback to complete and verify it restored to codon 2
      const rollbackCompleted = (await secondServer.waitForEvent(
        "rollback.completed",
      )) as RollbackCompletedEvent;

      expect(rollbackCompleted.data.codonId).toBe(codonOne);

      // Wait for the run to complete successfully after rollback
      // This will throw if the run doesn't complete successfully
      // Use a longer timeout since Codon 3 still needs to complete after all the
      // stop/restart overhead (Codons 1-2 + restart take ~80s, leaving time for Codon 3)
      await secondServer.waitForRunToComplete(150_000);
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
      if (hankweave.process.exitCode === null && hankweave.process.signalCode === null) {
        await hankweave.stop();
      }
    }
  }, 300_000); // 5 minute timeout to accommodate LLM call variability

  it("recovers from server KILL and resumes from where it stopped", async () => {
    // testing a case of "ungracious" interruption (crash/SIGKILL)
    let hankweave = await launchHankweave({ port: 9005 });
    const codonOne = CodonId("codon-1");
    const codonTwo = CodonId("codon-2");
    const execDir = hankweave.executionDir; // Save execution directory for reuse

    try {
      // Wait for hankweave to be ready
      await hankweave.waitForEvent("server.ready");

      // Wait for codon 1 to start
      const codon1Started = (await hankweave.waitForCodonStart(codonOne)) as CodonStartedEvent;
      expect(codon1Started.data.codonId).toBe(codonOne);

      // Wait for codon 2 to start
      const codon2Started = (await hankweave.waitForCodonStart(
        codonTwo,
        codon1Started.timestamp,
        90_000,
      )) as CodonStartedEvent;
      expect(codon2Started.data.codonId).toBe(codonTwo);

      // kill the hankweave (SIGKILL - simulates crash)
      await hankweave.kill(5_000);

      // Verify hankweave exited
      expect(
        hankweave.process.exitCode !== null || hankweave.process.signalCode !== null,
      ).toBeTrue();

      // Small delay before reconnecting
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // lock file should be lingering after crash
      expect(hankweave.hasLockFile()).toBeTrue();

      // relaunch the server and request previous events to capture rollback
      hankweave = await launchHankweave({
        port: 9005,
        executionDir: execDir,
        reuseTestDirectory: true,
        sendPreviousEvents: true,
      });

      // Wait for rollback to complete and verify it restored to codon 2
      const rollbackCompleted = (await hankweave.waitForEvent(
        "rollback.completed",
      )) as RollbackCompletedEvent;

      expect(rollbackCompleted.data.codonId).toBe(codonOne);

      // Wait for the run to complete successfully after rollback
      // This will throw if the run doesn't complete successfully
      // Use a longer timeout since Codon 3 still needs to complete after all the
      // kill/restart overhead (Codons 1-2 + restart take ~80s, leaving time for Codon 3)
      await hankweave.waitForRunToComplete(150_000);
    } finally {
      // Clean up the second server if it's running
      if (
        hankweave &&
        hankweave.process.exitCode === null &&
        hankweave.process.signalCode === null
      ) {
        await hankweave.stop();
      }
    }
  }, 300_000); // 5 minute timeout to accommodate LLM call variability

  it("allows a second client to connect and stream event history", async () => {
    // Launch hankweave with ping event generation
    // Note: ping commands generate pong events, which are connection-state events
    // and are NOT journaled. Only server-state events from codon execution are journaled.
    const hankweave = await launchHankweave({
      port: 9007,
      generatePingEvents: 150,
    });
    const codonOne = CodonId("codon-1");
    let secondClient: WebSocket | null = null;

    try {
      // Wait for hankweave to be ready
      await hankweave.waitForEvent("server.ready");

      // Wait for codon 1 to complete
      const codon1Started = (await hankweave.waitForCodonStart(codonOne)) as CodonStartedEvent;
      const codon1Completed = (await hankweave.waitForCodonCompletion(
        codonOne,
        codon1Started.timestamp,
      )) as CodonCompletedEvent;

      expect(codon1Completed.data.codonId).toBe(codonOne);

      // Connect a second client and request event history
      const clientSetup = await connectHankweaveClient(hankweave.websocketServerUrl, {
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

      // totalEvents should equal or exceed initialEventHistory.length
      // (they'll be equal if all events fit within the handshake limit)
      expect(totalEvents).toBeGreaterThanOrEqual(initialEventHistory.length);

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
          const data = JSON.parse(event.data);

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

      // Verify key server-state events are present in the combined journal history
      // Note: server.ready and pong are connection-state events and are NOT journaled

      expect(
        combined.find(
          (e) => e.type === "codon.started" && (e as CodonStartedEvent).data.codonId === codonOne,
        ),
      ).toBeDefined();

      expect(
        combined.find(
          (e) =>
            e.type === "codon.completed" && (e as CodonCompletedEvent).data.codonId === codonOne,
        ),
      ).toBeDefined();
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
      if (hankweave.process.exitCode === null && hankweave.process.signalCode === null) {
        await hankweave.stop();
      }
    }
  }, 180_000);
});
