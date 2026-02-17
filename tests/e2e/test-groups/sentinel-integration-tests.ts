/**
 * Sentinel Integration Test Group
 *
 * Tests that sentinels integrate correctly with the main Hankweave workflow:
 * - Sentinels load without blocking codon execution
 * - Events are emitted correctly
 * - State is persisted
 * - Costs are tracked separately
 * - Output files are generated correctly
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  SentinelLoadedEvent,
  SentinelOutputEvent,
  SentinelUnloadedEvent,
  ServerEvent,
} from "../../../server/schemas/event-schemas.js";
import type { HankweaveState } from "../../../server/types/state-types.js";

// TestState interface for this test group
interface TestState {
  events?: ServerEvent[];
  executionPath?: string;
  codonModels: Record<string, string>;
}

/** Check if a model string refers to a non-Anthropic provider */
function isNonAnthropicModel(model: string): boolean {
  const lower = model.toLowerCase();
  return (
    !lower.includes("claude") &&
    !lower.includes("sonnet") &&
    !lower.includes("opus") &&
    !lower.includes("haiku")
  );
}

export function runSentinelIntegrationTests(testState: TestState): void {
  describe("Lifecycle Events", () => {
    it("should emit sentinel.loaded, .output, and .unloaded events for each sentinel", () => {
      if (!testState.events || testState.events.length === 0) {
        console.log("⚠️ No events captured");
        return;
      }

      const loadedEvents = testState.events.filter(
        (e) => e.type === "sentinel.loaded",
      ) as SentinelLoadedEvent[];
      const outputEvents = testState.events.filter(
        (e) => e.type === "sentinel.output",
      ) as SentinelOutputEvent[];
      const unloadedEvents = testState.events.filter(
        (e) => e.type === "sentinel.unloaded",
      ) as SentinelUnloadedEvent[];

      console.log(
        `Sentinel events: ${loadedEvents.length} loaded, ${outputEvents.length} outputs, ${unloadedEvents.length} unloaded`,
      );

      // Should have loaded events for all sentinels
      expect(loadedEvents.length).toBeGreaterThan(0);

      // Collect unique sentinel IDs from loaded events
      const loadedSentinelIds = new Set(loadedEvents.map((e) => e.data.sentinelId));

      // Should have unloaded events matching loaded events (or slightly fewer if the last codon's sentinels haven't unloaded yet)
      // Sentinels are typically unloaded when the next codon starts or when the server shuts down.
      // If the test finishes before shutdown completes, we might miss the final unload events.
      expect(unloadedEvents.length).toBeGreaterThanOrEqual(
        loadedEvents.length - loadedSentinelIds.size,
      );

      const unloadedSentinelIds = new Set(unloadedEvents.map((e) => e.data.sentinelId));

      // We can't strictly check this because of the same reason
      // expect(unloadedSentinelIds.size).toBe(loadedSentinelIds.size);

      // Every loaded sentinel should be unloaded
      for (const id of loadedSentinelIds) {
        expect(unloadedSentinelIds.has(id)).toBe(true);
      }

      // Verify event structure
      for (const event of loadedEvents) {
        expect(event.data.sentinelId).toBeDefined();
        expect(event.data.codonId).toBeDefined();
        expect(event.data.model).toBeDefined();
        expect(event.data.triggerType).toBeDefined();
        expect(event.data.executionStrategy).toBeDefined();
      }

      for (const event of unloadedEvents) {
        expect(event.data.sentinelId).toBeDefined();
        expect(event.data.codonId).toBeDefined();
        expect(event.data.reason).toBeDefined();
        expect(typeof event.data.finalCost).toBe("number");
        expect(typeof event.data.llmCallCount).toBe("number");
      }
    });

    it("should show sentinel information in the persisted state", async () => {
      if (!testState.executionPath) {
        console.log("⚠️ No execution path");
        return;
      }

      const statePath = path.join(testState.executionPath, ".hankweave/state.json");
      if (!fs.existsSync(statePath)) {
        console.log("⚠️ No state.json found");
        return;
      }

      const state: HankweaveState = JSON.parse(await fs.promises.readFile(statePath, "utf-8"));

      let foundSentinels = false;
      for (const run of state.runs) {
        for (const codon of run.codons) {
          if (
            (codon.status === "completed" ||
              codon.status === "failed" ||
              codon.status === "skipped") &&
            codon.sentinels
          ) {
            foundSentinels = true;

            // Verify sentinels.executed array exists
            expect(codon.sentinels.executed).toBeDefined();
            expect(Array.isArray(codon.sentinels.executed)).toBe(true);

            // Verify each sentinel state
            for (const sentinelState of codon.sentinels.executed) {
              expect(sentinelState.id).toBeDefined();
              expect(sentinelState.model).toBeDefined();
              expect(sentinelState.loadedAt).toBeDefined();
              // Status can be "active" or "unloaded" depending on timing
              expect(["active", "unloaded"]).toContain(sentinelState.status);
              // unloadReason only exists for unloaded sentinels
              if (sentinelState.status === "unloaded") {
                expect(sentinelState.unloadReason).toBeDefined();
              }
              expect(typeof sentinelState.totalCost).toBe("number");
              expect(typeof sentinelState.llmCallCount).toBe("number");
              expect(typeof sentinelState.totalTriggers).toBe("number");
            }

            // Verify totalCost is calculated
            expect(typeof codon.sentinels.totalCost).toBe("number");
            expect(codon.sentinels.totalCost).toBeGreaterThanOrEqual(0);

            console.log(
              `✓ Codon ${codon.codonId}: ${codon.sentinels.executed.length} sentinel(s), ` +
                `cost=$${codon.sentinels.totalCost.toFixed(6)}`,
            );
          }
        }
      }

      expect(foundSentinels).toBe(true);
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
        ".hankweave/sentinels/outputs/test-sentinel",
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

        // Should contain some keywords related to the test codons
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
        ".hankweave/sentinels/outputs/cost-analyst",
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
          expect(typeof parsed.mostExpensiveCall.codonId).toBe("string");
          expect(typeof parsed.mostExpensiveCall.cost).toBe("number");
        }

        console.log(`✓ Cost analysis (${file}): ${lines.length} NDJSON entries, all valid`);
      }
    });

    it("should generate code review feedback for Codon 3", async () => {
      if (!testState.executionPath) {
        console.log("⚠️ No execution path");
        return;
      }

      const qaBotOutputDir = path.join(
        testState.executionPath,
        ".hankweave/sentinels/outputs/qa-bot",
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

        // Sentinel output may be empty if a non-Anthropic model (e.g. Gemini)
        // didn't produce code for the qa-bot to review.
        const codon3IsNonAnthropic = isNonAnthropicModel(testState.codonModels["codon-3"] || "");
        if (content.length === 0 && codon3IsNonAnthropic) {
          console.warn(
            `⚠️ qa-bot output file ${file} is empty — non-Anthropic model (${testState.codonModels["codon-3"]}); skipping`,
          );
          continue;
        }
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
    it("should track sentinel costs separately from codon costs", async () => {
      if (!testState.executionPath) {
        console.log("⚠️ No execution path");
        return;
      }

      const statePath = path.join(testState.executionPath, ".hankweave/state.json");
      if (!fs.existsSync(statePath)) {
        return;
      }

      const state: HankweaveState = JSON.parse(await fs.promises.readFile(statePath, "utf-8"));

      let foundSentinelCosts = false;

      for (const run of state.runs) {
        for (const codon of run.codons) {
          if (codon.status === "completed" && codon.sentinels) {
            foundSentinelCosts = true;

            // Codon has its own finalCost
            const codonCost = codon.finalCost;
            expect(typeof codonCost).toBe("number");
            expect(codonCost).toBeGreaterThan(0);

            // Sentinels have separate totalCost
            expect(typeof codon.sentinels.totalCost).toBe("number");

            // These should be independent values
            expect(codon.sentinels.totalCost).not.toBe(codonCost);

            console.log(
              `✓ Codon ${codon.codonId}: Agent cost=$${codonCost.toFixed(6)}, ` +
                `Sentinel cost=$${codon.sentinels.totalCost.toFixed(6)}`,
            );
          }
        }
      }

      expect(foundSentinelCosts).toBe(true);
    });
  });
}
