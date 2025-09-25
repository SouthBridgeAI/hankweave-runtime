#!/usr/bin/env bun
import { describe, expect, it } from "bun:test";
import { PhaseId } from "../../server/types/branded-types.js";
import { launchBasicServer } from "../utils/server-process-helper.js";

describe("basic server lifecycle", () => {
  it("start the tadpole server and wait for phase 1 to complete", async () => {
    const server = await launchBasicServer();
    const phaseOne = PhaseId("phase-1");

    try {
      await server.waitForEvent("server.ready", 30_000);
      const phase1Started = await server.waitForPhaseStart(phaseOne, 60_000);
      const phase1Completed = await server.waitForPhaseCompletion(
        phaseOne,
        120_000,
        phase1Started.timestamp,
      );

      expect(phase1Completed.data.phaseId).toBe(phaseOne);
    } finally {
      await server.stop();
    }

    expect(server.process.exitCode !== null || server.process.signalCode !== null).toBeTrue();
  }, 120_000);
});
