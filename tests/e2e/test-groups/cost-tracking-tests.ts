import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  CodonCompletedEvent,
  ServerEvent,
  StateSnapshotEvent,
} from "../../../server/types/types.js";
import { parseJSONL } from "../../utils/test-data-helpers.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
  events: ServerEvent[];
  // State-based fields
  completedCodons: Array<{
    codonId: string;
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

  test("all 3 codons marked as completed", () => {
    // Use state-based completed codons instead of event
    expect(testState.completedCodons.length).toBe(3);
  });

  test("completed codons have costs", () => {
    // Verify each completed codon has a cost
    for (const codon of testState.completedCodons) {
      expect(codon.cost).toBeGreaterThan(0);
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

  test("individual codon costs match", () => {
    const codonLogCosts: Record<string, number> = {};

    // Find the run folder
    const runsDir = path.join(testDir, ".hankweave/runs");
    let runFolder = "";
    if (fs.existsSync(runsDir)) {
      const runFolders = fs.readdirSync(runsDir);
      if (runFolders.length > 0) {
        runFolder = path.join(runsDir, runFolders[0]);
      }
    }

    // Calculate from logs using result messages
    for (const codonId of ["codon-1", "codon-2", "codon-3"]) {
      const logPath = path.join(runFolder, `${codonId}-claude.log`); // Corrected path
      if (fs.existsSync(logPath)) {
        const logContent = fs.readFileSync(logPath, "utf-8");
        const logEntries = parseJSONL(logContent);
        const resultMessage = logEntries.find(
          (e) => e.type === "result" && e.subtype === "success",
        );
        if (resultMessage?.total_cost_usd) {
          codonLogCosts[codonId] = resultMessage.total_cost_usd;
        }
      }
    }

    // Compare with events
    const codonCompletedEvents = testState.client?.getEventsByType("codon.completed") || [];
    for (const event of codonCompletedEvents) {
      const completedEvent = event as CodonCompletedEvent;
      if (completedEvent.data?.success && completedEvent.data?.codonId) {
        const logCost = codonLogCosts[completedEvent.data.codonId] || 0;

        if (logCost) {
          // some providers will not have cost data in logs - only compare if we have it
          expect(completedEvent.data?.cost || 0).toBeCloseTo(logCost, 4); // Increased precision
        }
      }
    }
  });
}
