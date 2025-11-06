/**
 * Chronicler Integration Test Group
 *
 * Tests that chroniclers integrate correctly with the main Tadpole workflow:
 * - Chroniclers load without blocking phase execution
 * - Events are emitted correctly
 * - State is persisted
 * - Costs are tracked separately
 * - Output files are generated correctly
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ChroniclerLoadedEvent,
  ChroniclerOutputEvent,
  ChroniclerUnloadedEvent,
  ServerEvent,
} from "../../../server/schemas/event-schemas.js";
import type { TadpoleState } from "../../../server/types/state-types.js";

// TestState interface for this test group
interface TestState {
  events?: ServerEvent[];
  executionPath?: string;
}

export function runChroniclerIntegrationTests(testState: TestState): void {
  describe("Lifecycle Events", () => {
    it("should emit chronicler.loaded, .output, and .unloaded events for each chronicler", () => {
      if (!testState.events || testState.events.length === 0) {
        console.log("⚠️ No events captured");
        return;
      }

      const loadedEvents = testState.events.filter(
        (e) => e.type === "chronicler.loaded",
      ) as ChroniclerLoadedEvent[];
      const outputEvents = testState.events.filter(
        (e) => e.type === "chronicler.output",
      ) as ChroniclerOutputEvent[];
      const unloadedEvents = testState.events.filter(
        (e) => e.type === "chronicler.unloaded",
      ) as ChroniclerUnloadedEvent[];

      console.log(
        `Chronicler events: ${loadedEvents.length} loaded, ${outputEvents.length} outputs, ${unloadedEvents.length} unloaded`,
      );

      // Should have loaded events for all chroniclers
      expect(loadedEvents.length).toBeGreaterThan(0);

      // Collect unique chronicler IDs from loaded events
      const loadedChroniclerIds = new Set(loadedEvents.map((e) => e.data.chroniclerId));

      // Should have unloaded events matching loaded events
      expect(unloadedEvents.length).toBe(loadedEvents.length);

      const unloadedChroniclerIds = new Set(unloadedEvents.map((e) => e.data.chroniclerId));
      expect(unloadedChroniclerIds.size).toBe(loadedChroniclerIds.size);

      // Every loaded chronicler should be unloaded
      for (const id of loadedChroniclerIds) {
        expect(unloadedChroniclerIds.has(id)).toBe(true);
      }

      // Verify event structure
      for (const event of loadedEvents) {
        expect(event.data.chroniclerId).toBeDefined();
        expect(event.data.phaseId).toBeDefined();
        expect(event.data.model).toBeDefined();
        expect(event.data.triggerType).toBeDefined();
        expect(event.data.executionStrategy).toBeDefined();
      }

      for (const event of unloadedEvents) {
        expect(event.data.chroniclerId).toBeDefined();
        expect(event.data.phaseId).toBeDefined();
        expect(event.data.reason).toBeDefined();
        expect(typeof event.data.finalCost).toBe("number");
        expect(typeof event.data.llmCallCount).toBe("number");
      }
    });

    it("should show chronicler information in the persisted state", async () => {
      if (!testState.executionPath) {
        console.log("⚠️ No execution path");
        return;
      }

      const statePath = path.join(testState.executionPath, ".tadpole/state.json");
      if (!fs.existsSync(statePath)) {
        console.log("⚠️ No state.json found");
        return;
      }

      const state: TadpoleState = JSON.parse(await fs.promises.readFile(statePath, "utf-8"));

      let foundChroniclers = false;
      for (const run of state.runs) {
        for (const phase of run.phases) {
          if (
            (phase.status === "completed" ||
              phase.status === "failed" ||
              phase.status === "skipped") &&
            phase.chroniclers
          ) {
            foundChroniclers = true;

            // Verify chroniclers.executed array exists
            expect(phase.chroniclers.executed).toBeDefined();
            expect(Array.isArray(phase.chroniclers.executed)).toBe(true);

            // Verify each chronicler state
            for (const chrState of phase.chroniclers.executed) {
              expect(chrState.id).toBeDefined();
              expect(chrState.model).toBeDefined();
              expect(chrState.loadedAt).toBeDefined();
              // Status can be "active" or "unloaded" depending on timing
              expect(["active", "unloaded"]).toContain(chrState.status);
              // unloadReason only exists for unloaded chroniclers
              if (chrState.status === "unloaded") {
                expect(chrState.unloadReason).toBeDefined();
              }
              expect(typeof chrState.totalCost).toBe("number");
              expect(typeof chrState.llmCallCount).toBe("number");
              expect(typeof chrState.totalTriggers).toBe("number");
            }

            // Verify totalCost is calculated
            expect(typeof phase.chroniclers.totalCost).toBe("number");
            expect(phase.chroniclers.totalCost).toBeGreaterThanOrEqual(0);

            console.log(
              `✓ Phase ${phase.phaseId}: ${phase.chroniclers.executed.length} chronicler(s), ` +
                `cost=$${phase.chroniclers.totalCost.toFixed(6)}`,
            );
          }
        }
      }

      expect(foundChroniclers).toBe(true);
    });
  });

  describe("Output Files", () => {
    it("should generate a human-readable test run narrative file", async () => {
      if (!testState.executionPath) {
        console.log("⚠️ No execution path");
        return;
      }

      const narratorOutputDir = path.join(
        testState.executionPath,
        ".tadpole/chroniclers/outputs/test-narrator",
      );

      if (!fs.existsSync(narratorOutputDir)) {
        console.log("⚠️ No narrator output directory");
        return;
      }

      // Find any .md files (auto-generated with timestamps)
      const files = await fs.promises.readdir(narratorOutputDir);
      const mdFiles = files.filter((f) => f.endsWith(".md"));

      expect(mdFiles.length).toBeGreaterThan(0);

      // Verify content
      for (const file of mdFiles) {
        const filePath = path.join(narratorOutputDir, file);
        const content = await fs.promises.readFile(filePath, "utf-8");

        expect(content.length).toBeGreaterThan(0);

        // Should contain some keywords related to the test phases
        const hasKeywords =
          content.toLowerCase().includes("poem") ||
          content.toLowerCase().includes("write") ||
          content.toLowerCase().includes("file") ||
          content.toLowerCase().includes("agent");

        expect(hasKeywords).toBe(true);

        console.log(`✓ Narrator output (${file}): ${content.length} chars`);
      }
    });

    it("should generate structured cost analysis data as NDJSON", async () => {
      if (!testState.executionPath) {
        console.log("⚠️ No execution path");
        return;
      }

      const costAnalystOutputDir = path.join(
        testState.executionPath,
        ".tadpole/chroniclers/outputs/cost-analyst",
      );

      if (!fs.existsSync(costAnalystOutputDir)) {
        console.log("⚠️ No cost-analyst output directory");
        return;
      }

      // Find any .ndjson files
      const files = await fs.promises.readdir(costAnalystOutputDir);
      const ndjsonFiles = files.filter((f) => f.endsWith(".ndjson") || f.endsWith(".jsonl"));

      expect(ndjsonFiles.length).toBeGreaterThan(0);

      // Parse and validate NDJSON
      for (const file of ndjsonFiles) {
        const filePath = path.join(costAnalystOutputDir, file);
        const content = await fs.promises.readFile(filePath, "utf-8");

        const lines = content.trim().split("\n");
        expect(lines.length).toBeGreaterThan(0);

        // Parse each line as JSON
        for (const line of lines) {
          if (!line.trim()) continue;

          const parsed = JSON.parse(line);

          // Verify schema compliance
          expect(typeof parsed.totalInputTokens).toBe("number");
          expect(typeof parsed.totalOutputTokens).toBe("number");
          expect(typeof parsed.totalCost).toBe("number");
          expect(parsed.mostExpensiveCall).toBeDefined();
          expect(typeof parsed.mostExpensiveCall.phaseId).toBe("string");
          expect(typeof parsed.mostExpensiveCall.cost).toBe("number");
        }

        console.log(`✓ Cost analysis (${file}): ${lines.length} NDJSON entries, all valid`);
      }
    });

    it("should generate code review feedback for Phase 3", async () => {
      if (!testState.executionPath) {
        console.log("⚠️ No execution path");
        return;
      }

      const qaBotOutputDir = path.join(
        testState.executionPath,
        ".tadpole/chroniclers/outputs/qa-bot",
      );

      if (!fs.existsSync(qaBotOutputDir)) {
        console.log("⚠️ No qa-bot output directory");
        return;
      }

      // Find any .md files
      const files = await fs.promises.readdir(qaBotOutputDir);
      const mdFiles = files.filter((f) => f.endsWith(".md"));

      expect(mdFiles.length).toBeGreaterThan(0);

      // Verify content mentions TypeScript or code quality
      for (const file of mdFiles) {
        const filePath = path.join(qaBotOutputDir, file);
        const content = await fs.promises.readFile(filePath, "utf-8");

        expect(content.length).toBeGreaterThan(0);

        // Should contain keywords related to code review
        const hasCodeKeywords =
          content.toLowerCase().includes("typescript") ||
          content.toLowerCase().includes("type") ||
          content.toLowerCase().includes("function") ||
          content.toLowerCase().includes("code") ||
          content.toLowerCase().includes("variable");

        expect(hasCodeKeywords).toBe(true);

        console.log(`✓ QA bot review (${file}): ${content.length} chars`);
      }
    });
  });

  describe("Cost Tracking", () => {
    it("should track chronicler costs separately from phase costs", async () => {
      if (!testState.executionPath) {
        console.log("⚠️ No execution path");
        return;
      }

      const statePath = path.join(testState.executionPath, ".tadpole/state.json");
      if (!fs.existsSync(statePath)) {
        return;
      }

      const state: TadpoleState = JSON.parse(await fs.promises.readFile(statePath, "utf-8"));

      let foundChroniclerCosts = false;

      for (const run of state.runs) {
        for (const phase of run.phases) {
          if (phase.status === "completed" && phase.chroniclers) {
            foundChroniclerCosts = true;

            // Phase has its own finalCost
            const phaseCost = phase.finalCost;
            expect(typeof phaseCost).toBe("number");
            expect(phaseCost).toBeGreaterThan(0);

            // Chroniclers have separate totalCost
            expect(typeof phase.chroniclers.totalCost).toBe("number");

            // These should be independent values
            expect(phase.chroniclers.totalCost).not.toBe(phaseCost);

            console.log(
              `✓ Phase ${phase.phaseId}: Agent cost=$${phaseCost.toFixed(6)}, ` +
                `Chronicler cost=$${phase.chroniclers.totalCost.toFixed(6)}`,
            );
          }
        }
      }

      expect(foundChroniclerCosts).toBe(true);
    });
  });
}
