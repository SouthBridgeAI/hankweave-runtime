import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SentinelEvent, SentinelOutputEvent } from "../../server/schemas/event-schemas.js";
import { SentinelConfigLoader } from "../../server/sentinels/sentinel-config-loader.js";
import { SentinelManager } from "../../server/sentinels/sentinel-manager.js";
import { CodonId, EventId } from "../../server/types/branded-types.js";
import type {
  HankweaveGenerateObjectOptions,
  HankweaveGenerateTextOptions,
} from "../../server/types/llm-call-types.js";
import type { SentinelConfig } from "../../server/types/sentinel-types.js";
import type { CodonSentinelEntry } from "../../server/types/types.js";
import { createMockLlm } from "../utils/mock-llm.js";

const mockLlmProvider = createMockLlm();

// Adapter to match expected signature
const mockLLM = {
  generateText: async (_id: string, options: HankweaveGenerateTextOptions) =>
    mockLlmProvider.generateText(options),
  generateObject: async (_id: string, options: HankweaveGenerateObjectOptions) =>
    mockLlmProvider.generateObject(options),
};

/**
 * Integration tests for Sentinel + HankweaveServer integration.
 * Tests the full integration of sentinels with codon lifecycle, event routing, and state management.
 */

describe("Sentinel HankweaveServer Integration", () => {
  let testDir: string;
  let executionDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `hankweave-sentinel-integration-${Date.now()}`);
    executionDir = path.join(testDir, "execution");
    await fs.promises.mkdir(executionDir, { recursive: true });
  });

  afterEach(async () => {
    if (fs.existsSync(testDir)) {
      await fs.promises.rm(testDir, { recursive: true, force: true });
    }
  });

  describe("State Persistence", () => {
    it("should track sentinel state in SentinelManager", async () => {
      const manager = new SentinelManager({
        enablePersistence: false,
      });

      await manager.initialize();

      const config: SentinelConfig = {
        id: "test-sentinel",
        name: "Test",
        trigger: { type: "event", on: ["info"] },
        execution: { strategy: "immediate" },
        userPromptText: "test",
        model: "mockmodel", // No slash - uses fallback
      };

      await manager.loadSentinelsForCodon([config], CodonId("test-codon"), {
        llmCallOverride: mockLLM.generateText,
        llmObjectCallOverride: mockLLM.generateObject,
        runStartTime: new Date(),
        executionPath: executionDir,
      });

      const states = manager.getSentinelStates();

      expect(states).toHaveLength(1);
      expect(states[0].id).toBe("test-sentinel");
      expect(states[0].model).toBe("mockmodel"); // Match config
      expect(states[0].llmCallCount).toBe(0);
      expect(states[0].totalTriggers).toBe(0);
      expect(states[0].status).toBe("active");

      await manager.shutdown();
    });
  });

  describe("Cost Tracking", () => {
    it("should track sentinel costs separately from codon costs", async () => {
      const manager = new SentinelManager({
        enablePersistence: false,
      });

      await manager.initialize();

      const config: SentinelConfig = {
        id: "cost-tracker",
        name: "Cost Tracker",
        trigger: { type: "event", on: ["info"] },
        execution: { strategy: "immediate" },
        userPromptText: "Count events",
        model: "mockmodel", // No slash - uses fallback
      };

      await manager.loadSentinelsForCodon([config], CodonId("test-codon"), {
        llmCallOverride: mockLLM.generateText,
        llmObjectCallOverride: mockLLM.generateObject,
        runStartTime: new Date(),
        executionPath: executionDir,
      });

      const costs = manager.getSentinelCosts();

      expect(costs.has("cost-tracker")).toBe(true);
      expect(costs.get("cost-tracker")).toBe(0); // No LLM calls yet

      await manager.shutdown();
    });
  });

  describe("Graceful Shutdown", () => {
    it("should complete all sentinel work before shutdown", async () => {
      const manager = new SentinelManager({
        enablePersistence: false,
      });

      await manager.initialize();

      const config: SentinelConfig = {
        id: "shutdown-test",
        name: "Shutdown Test",
        trigger: { type: "event", on: ["*"] },
        execution: { strategy: "count", threshold: 10 },
        userPromptText: "test",
        model: "mockmodel", // No slash - uses fallback
      };

      await manager.loadSentinelsForCodon([config], CodonId("test-codon"), {
        llmCallOverride: mockLLM.generateText,
        llmObjectCallOverride: mockLLM.generateObject,
        runStartTime: new Date(),
        executionPath: executionDir,
      });

      // Add some events
      for (let i = 0; i < 5; i++) {
        await manager.handleEvent({
          id: EventId(`event-${i}`),
          timestamp: new Date().toISOString(),
          type: "info",
          data: { message: "test" },
        });
      }

      // Shutdown should complete all work
      await manager.shutdown();

      // Manager should have no active sentinels after shutdown
      expect(manager.getSentinelCount()).toBe(0);
    });
  });

  describe("Configuration Loading", () => {
    it("should handle wrapper pattern correctly", async () => {
      const loader = new SentinelConfigLoader();

      const entries: CodonSentinelEntry[] = [
        {
          sentinelConfig: {
            id: "inline-test",
            name: "Inline Test",
            trigger: { type: "event", on: ["info"] },
            execution: { strategy: "immediate" },
            userPromptText: "test",
            model: "mock/model",
          },
          settings: {
            failCodonIfNotLoaded: true,
            outputPaths: {
              logFile: "custom.md",
            },
          },
        },
      ];

      const result = loader.loadConfigsForCodon(entries, "test-codon", testDir);

      expect(result.configs).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
      expect(result.configs[0].failCodonIfNotLoaded).toBe(true);
      expect(result.configs[0].outputPaths?.logFile).toBe("custom.md");
      expect(result.configs[0].source).toBe("inline");
    });
  });

  describe("Event Emission", () => {
    it("should set event callback and route sentinel events", async () => {
      const manager = new SentinelManager({
        enablePersistence: false,
      });

      const capturedEvents: SentinelEvent[] = [];
      manager.setEventCallback((event) => {
        capturedEvents.push(event);
      });

      await manager.initialize();

      const config: SentinelConfig = {
        id: "event-test",
        name: "Event Test",
        trigger: { type: "event", on: ["info"] },
        execution: { strategy: "immediate" },
        userPromptText: "test: <%= it.events.length %>",
        model: "mockmodel", // No slash - uses fallback
        reportToWebsocket: {
          outputs: true,
          triggers: true,
        },
      };

      await manager.loadSentinelsForCodon([config], CodonId("test-codon"), {
        llmCallOverride: mockLLM.generateText,
        llmObjectCallOverride: mockLLM.generateObject,
        runStartTime: new Date(),
        executionPath: executionDir,
      });

      // Trigger the sentinel
      await manager.handleEvent({
        id: EventId("test-event"),
        timestamp: new Date().toISOString(),
        type: "info",
        data: { message: "test" },
      });

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Should have sentinel.output events at minimum
      const outputEvents = capturedEvents.filter(
        (e): e is SentinelOutputEvent => e.type === "sentinel.output",
      );

      expect(outputEvents.length).toBeGreaterThan(0);

      if (outputEvents.length > 0) {
        expect(outputEvents[0].data.sentinelId).toBe("event-test");
        expect(outputEvents[0].data.outputType).toBe("text");
        expect(outputEvents[0].data.content).toBeDefined();
      }

      await manager.shutdown();
    });
  });
});
