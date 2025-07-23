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
  // State-based fields
  completedPhases: Array<{
    phaseId: string;
    cost: number;
    sessionId: string;
  }>;
  totalCost: number;
}

export function runCostTrackingTests(testState: TestState, testDir: string) {
  test("total cost is tracked", () => {
    // Use state-based total cost instead of event
    expect(testState.totalCost).toBeGreaterThan(0);
  });

  test("all 3 phases marked as completed", () => {
    // Use state-based completed phases instead of event
    expect(testState.completedPhases.length).toBe(3);
  });

  test("completed phases have costs", () => {
    // Verify each completed phase has a cost
    for (const phase of testState.completedPhases) {
      expect(phase.cost).toBeGreaterThan(0);
    }
  });

  test("state.json costs match WebSocket events", () => {
    // The state.snapshot event should reflect the same total as state.json
    const finalStateSnapshot = [...testState.events]
      .reverse()
      .find((e) => e.type === "state.snapshot");

    if (finalStateSnapshot) {
      expect((finalStateSnapshot as StateSnapshotEvent)?.data?.totalCost).toBeCloseTo(
        testState.totalCost,
        6,
      );
    }
  });

  test("costs match between WebSocket and logs", () => {
    // Calculate costs from JSONL logs using result messages
    let logTotalCost = 0;
    const phaseLogCosts: Record<string, number> = {};

    // Find the run folder
    const runsDir = path.join(testDir, ".langton/runs");
    let runFolder = "";
    if (fs.existsSync(runsDir)) {
      const runFolders = fs.readdirSync(runsDir);
      if (runFolders.length > 0) {
        runFolder = path.join(runsDir, runFolders[0]);
      }
    }

    for (const phaseId of ["phase-1", "phase-2", "phase-3"]) {
      const logPath = path.join(runFolder, `${phaseId}-claude.log`); // Corrected path
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

    expect(wsReportedCost).toBeCloseTo(logTotalCost, 4); // Increased precision
  });

  test("individual phase costs match", () => {
    const phaseLogCosts: Record<string, number> = {};

    // Find the run folder
    const runsDir = path.join(testDir, ".langton/runs");
    let runFolder = "";
    if (fs.existsSync(runsDir)) {
      const runFolders = fs.readdirSync(runsDir);
      if (runFolders.length > 0) {
        runFolder = path.join(runsDir, runFolders[0]);
      }
    }

    // Calculate from logs using result messages
    for (const phaseId of ["phase-1", "phase-2", "phase-3"]) {
      const logPath = path.join(runFolder, `${phaseId}-claude.log`); // Corrected path
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
      if (completedEvent.data?.success && completedEvent.data?.phaseId) {
        const logCost = phaseLogCosts[completedEvent.data.phaseId] || 0;
        expect(completedEvent.data?.cost || 0).toBeCloseTo(logCost, 4); // Increased precision
      }
    }
  });
}
