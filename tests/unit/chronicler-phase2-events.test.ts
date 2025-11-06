import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Chronicler } from "../../server/chroniclers/chronicler.js";
import type { ChroniclerEvent } from "../../server/schemas/event-schemas.js";
import { EventId, PhaseId } from "../../server/types/branded-types.js";
import { createMockLlm } from "../utils/mock-llm.js";

/**
 * Unit tests for Phase 2 event emission features.
 * Tests chronicler.output, chronicler.triggered, and chronicler.error events.
 */

describe("Phase 2: Chronicler Event Emission", () => {
  let testDir: string;
  const mockLlmProvider = createMockLlm();

  // Adapter to match Chronicler's expected signature (id, options) => Promise
  const mockLLM = {
    generateText: async (
      _id: string,
      options: Parameters<typeof mockLlmProvider.generateText>[0],
    ) => mockLlmProvider.generateText(options),
    generateObject: async (
      _id: string,
      options: Parameters<typeof mockLlmProvider.generateObject>[0],
    ) => mockLlmProvider.generateObject(options),
  };

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `chronicler-events-test-${Date.now()}`);
    await fs.promises.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    if (fs.existsSync(testDir)) {
      await fs.promises.rm(testDir, { recursive: true, force: true });
    }
  });

  describe("chronicler.output events", () => {
    it("should emit chronicler.output event with full content (text)", async () => {
      const capturedEvents: ChroniclerEvent[] = [];

      const chronicler = new Chronicler(
        {
          id: "output-test",
          name: "Output Test",
          model: "mockmodel",
          trigger: { type: "event", on: ["info"] },
          execution: { strategy: "immediate" },
          userPromptText: "Test: <%= it.events.length %>",
          reportToWebsocket: {
            outputs: true,
          },
        },
        PhaseId("test-phase"),
        mockLLM.generateText,
        undefined,
        undefined,
        undefined,
        new Date(),
        undefined,
        { input: 0.25, output: 0.25 },
        undefined,
        testDir,
        undefined,
        (event) => capturedEvents.push(event),
      );

      await chronicler.handleEvent({
        id: EventId("test-1"),
        timestamp: new Date().toISOString(),
        type: "info",
        data: { message: "test" },
      });

      // Wait for async execution
      await new Promise((resolve) => setTimeout(resolve, 100));

      const outputEvents = capturedEvents.filter((e) => e.type === "chronicler.output");
      expect(outputEvents.length).toBeGreaterThan(0);

      if (outputEvents.length > 0) {
        const event = outputEvents[0];
        expect(event.data.chroniclerId).toBe("output-test");
        expect(event.data.phaseId).toBe("test-phase");
        expect(event.data.triggerNumber).toBeGreaterThan(0);
        expect(event.data.outputType).toBe("text");
        expect(event.data.content).toBeDefined();
        expect(typeof event.data.cost).toBe("number");
      }

      chronicler.destroy();
    });

    it("should NOT emit chronicler.output when outputs disabled", async () => {
      const capturedEvents: ChroniclerEvent[] = [];

      const chronicler = new Chronicler(
        {
          id: "no-output",
          name: "No Output",
          model: "mockmodel",
          trigger: { type: "event", on: ["info"] },
          execution: { strategy: "immediate" },
          userPromptText: "Test",
          reportToWebsocket: {
            outputs: false, // Disabled
          },
        },
        PhaseId("test-phase"),
        mockLLM.generateText,
        undefined,
        undefined,
        undefined,
        new Date(),
        undefined,
        { input: 0.25, output: 0.25 },
        undefined,
        testDir,
        undefined,
        (event) => capturedEvents.push(event),
      );

      await chronicler.handleEvent({
        id: EventId("test-1"),
        timestamp: new Date().toISOString(),
        type: "info",
        data: { message: "test" },
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const outputEvents = capturedEvents.filter((e) => e.type === "chronicler.output");
      expect(outputEvents.length).toBe(0); // Should be disabled

      chronicler.destroy();
    });
  });

  describe("chronicler.triggered events", () => {
    it("should emit chronicler.triggered when triggers=true", async () => {
      const capturedEvents: ChroniclerEvent[] = [];

      const chronicler = new Chronicler(
        {
          id: "triggered-test",
          name: "Triggered Test",
          model: "mockmodel",
          trigger: { type: "event", on: ["info"] },
          execution: { strategy: "immediate" },
          userPromptText: "Test",
          reportToWebsocket: {
            triggers: true, // Enabled
          },
        },
        PhaseId("test-phase"),
        mockLLM.generateText,
        undefined,
        undefined,
        undefined,
        new Date(),
        undefined,
        undefined,
        undefined,
        testDir,
        undefined,
        (event) => capturedEvents.push(event),
      );

      await chronicler.handleEvent({
        id: EventId("test-1"),
        timestamp: new Date().toISOString(),
        type: "info",
        data: { message: "test" },
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const triggeredEvents = capturedEvents.filter((e) => e.type === "chronicler.triggered");
      expect(triggeredEvents.length).toBeGreaterThan(0);

      if (triggeredEvents.length > 0) {
        const event = triggeredEvents[0];
        expect(event.data.chroniclerId).toBe("triggered-test");
        expect(event.data.triggerNumber).toBeGreaterThan(0);
        expect(event.data.strategy).toBe("immediate");
        expect(event.data.eventCount).toBeGreaterThan(0);
      }

      chronicler.destroy();
    });

    it("should NOT emit chronicler.triggered when triggers=false (default)", async () => {
      const capturedEvents: ChroniclerEvent[] = [];

      const chronicler = new Chronicler(
        {
          id: "no-triggered",
          name: "No Triggered",
          model: "mockmodel",
          trigger: { type: "event", on: ["info"] },
          execution: { strategy: "immediate" },
          userPromptText: "Test",
          // triggers defaults to false
        },
        PhaseId("test-phase"),
        mockLLM.generateText,
        undefined,
        undefined,
        undefined,
        new Date(),
        undefined,
        undefined,
        undefined,
        testDir,
        undefined,
        (event) => capturedEvents.push(event),
      );

      await chronicler.handleEvent({
        id: EventId("test-1"),
        timestamp: new Date().toISOString(),
        type: "info",
        data: { message: "test" },
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const triggeredEvents = capturedEvents.filter((e) => e.type === "chronicler.triggered");
      expect(triggeredEvents.length).toBe(0); // Default is OFF

      chronicler.destroy();
    });
  });

  describe("chronicler.error events", () => {
    it("should emit chronicler.error on LLM failure", async () => {
      const capturedEvents: ChroniclerEvent[] = [];
      const failingLlmProvider = createMockLlm({
        forceError: new Error("LLM failed"),
      });

      const failingLLM = {
        generateText: async (
          _id: string,
          options: Parameters<typeof mockLlmProvider.generateText>[0],
        ) => failingLlmProvider.generateText(options),
      };

      const chronicler = new Chronicler(
        {
          id: "error-test",
          name: "Error Test",
          model: "mockmodel",
          trigger: { type: "event", on: ["info"] },
          execution: { strategy: "immediate" },
          userPromptText: "Test",
          reportToWebsocket: {
            errors: true, // Enabled (default)
          },
        },
        PhaseId("test-phase"),
        failingLLM.generateText,
        undefined,
        undefined,
        undefined,
        new Date(),
        undefined,
        undefined,
        undefined,
        testDir,
        undefined,
        (event) => capturedEvents.push(event),
      );

      // This should fail
      try {
        await chronicler.handleEvent({
          id: EventId("test-1"),
          timestamp: new Date().toISOString(),
          type: "info",
          data: { message: "test" },
        });
      } catch {
        // Expected to fail
      }

      await new Promise((resolve) => setTimeout(resolve, 100));

      const errorEvents = capturedEvents.filter((e) => e.type === "chronicler.error");
      expect(errorEvents.length).toBeGreaterThan(0);

      if (errorEvents.length > 0) {
        const event = errorEvents[0];
        expect(event.data.chroniclerId).toBe("error-test");
        expect(event.data.errorType).toBe("llm-call-failed");
        expect(event.data.retriable).toBe(true);
        expect(event.data.consecutiveFailureCount).toBeGreaterThan(0);
      }

      chronicler.destroy();
    });
  });

  describe("ChroniclerState tracking", () => {
    it("should track llmCallCount and triggerNumber", async () => {
      const chronicler = new Chronicler(
        {
          id: "state-test",
          name: "State Test",
          model: "mockmodel",
          trigger: { type: "event", on: ["info"] },
          execution: { strategy: "immediate" },
          userPromptText: "Test",
        },
        PhaseId("test-phase"),
        mockLLM.generateText,
        undefined,
        undefined,
        undefined,
        new Date(),
        undefined,
        undefined,
        undefined,
        testDir,
      );

      // Initial state
      let state = chronicler.getChroniclerState();
      expect(state.llmCallCount).toBe(0);
      expect(state.totalTriggers).toBe(0);

      // Trigger once
      await chronicler.handleEvent({
        id: EventId("test-1"),
        timestamp: new Date().toISOString(),
        type: "info",
        data: { message: "test" },
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // State should be updated
      state = chronicler.getChroniclerState();
      expect(state.llmCallCount).toBe(1);
      expect(state.totalTriggers).toBe(1);
      expect(state.status).toBe("active");

      chronicler.destroy();
    });
  });
});
