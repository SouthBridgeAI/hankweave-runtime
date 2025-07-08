import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  PhaseCompletedEvent,
  ServerEvent,
  StateSnapshotEvent,
} from "../../../server/types.js";
import { parseJSONL } from "../../utils/test-data-helpers.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
  events: ServerEvent[];
}

export function runCostTrackingTests(testState: TestState, testDir: string) {
  test("total cost is tracked", () => {
    const finalStateSnapshot = [...testState.events]
      .reverse()
      .find((e) => e.type === "state.snapshot");
    expect((finalStateSnapshot as StateSnapshotEvent)?.data?.totalCost).toBeGreaterThan(0);
  });

  test("all 3 phases marked as completed", () => {
    const finalStateSnapshot = [...testState.events]
      .reverse()
      .find((e) => e.type === "state.snapshot");
    expect((finalStateSnapshot as StateSnapshotEvent)?.data?.completedPhases?.length).toBe(3);
  });

  test("costs match between WebSocket and logs", () => {
    // Calculate costs from JSONL logs using result messages
    let logTotalCost = 0;
    const phaseLogCosts: Record<string, number> = {};

    for (const phaseId of ["phase-1", "phase-2", "phase-3"]) {
      const logPath = path.join(testDir, `.langton/logs/log-${phaseId}.jsonl`);
      if (fs.existsSync(logPath)) {
        const logContent = fs.readFileSync(logPath, "utf-8");
        const logEntries = parseJSONL(logContent);

        // Find the result message which has the final cost
        const resultMessage = logEntries.find(
          (e) => e.type === "result" && e.subtype === "success",
        );

        if (resultMessage?.total_cost_usd) {
          phaseLogCosts[phaseId] = resultMessage.total_cost_usd;
          logTotalCost += resultMessage.total_cost_usd;
        }
      }
    }

    // Compare with WebSocket reported costs
    const phaseCompletedEvents = testState.client?.getEventsByType("phase.completed") || [];
    let wsReportedCost = 0;

    for (const event of phaseCompletedEvents) {
      const completedEvent = event as PhaseCompletedEvent;
      if (completedEvent.data?.success) {
        wsReportedCost += completedEvent.data?.cost || 0;
      }
    }

    expect(wsReportedCost).toBeCloseTo(logTotalCost, 1);
  });

  test("individual phase costs match", () => {
    const phaseLogCosts: Record<string, number> = {};

    // Calculate from logs using result messages
    for (const phaseId of ["phase-1", "phase-2", "phase-3"]) {
      const logPath = path.join(testDir, `.langton/logs/log-${phaseId}.jsonl`);
      if (fs.existsSync(logPath)) {
        const logContent = fs.readFileSync(logPath, "utf-8");
        const logEntries = parseJSONL(logContent);
        const resultMessage = logEntries.find(
          (e) => e.type === "result" && e.subtype === "success",
        );
        if (resultMessage?.total_cost_usd) {
          phaseLogCosts[phaseId] = resultMessage.total_cost_usd;
        }
      }
    }

    // Compare with events
    const phaseCompletedEvents = testState.client?.getEventsByType("phase.completed") || [];
    for (const event of phaseCompletedEvents) {
      const completedEvent = event as PhaseCompletedEvent;
      if (completedEvent.data?.success) {
        const logCost = phaseLogCosts[completedEvent.data?.phaseId || ""] || 0;
        expect(completedEvent.data?.cost || 0).toBeCloseTo(logCost, 1);
      }
    }
  });
}
