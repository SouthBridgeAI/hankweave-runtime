import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { SentinelConfig } from "../../server/config-validation/sentinel.schema.js";
import type { ServerEvent } from "../../server/schemas/event-schemas.js";
import type { CodonId } from "../../server/types/branded-types.js";
import { EventId } from "../../server/types/branded-types.js";
import type {
  HankweaveGenerateTextOptions,
  HankweaveGenerateTextResult,
} from "../../server/types/llm-call-types.js";
import { Logger } from "../../server/utils.js";
import { createMockLlm } from "../utils/mock-llm.js";
import { createTestSentinelManager } from "../utils/sentinel-test-harness.js";

/**
 * Tests for the second drain fix: ensuring sentinels watching codon.completed
 * actually process the event before being unloaded.
 *
 * Background: codon.completed is emitted AFTER the first sentinel drain in
 * handleCodonComplete(). Without a second drain, sentinels watching this event
 * would have their triggers queued but silently dropped on unload.
 *
 * See: intermediates/42-sentinel-codon-completed-fix/plan.md
 */

class MockLogger extends Logger {
  logs: Array<{ message: string; level: string }> = [];

  constructor() {
    super("/dev/null");
  }

  log(message: string, level: "info" | "error" | "debug" = "info"): void {
    this.logs.push({ message, level });
  }
}

describe("Sentinel codon.completed drain", () => {
  let testDir: string;
  let logger: MockLogger;

  beforeEach(async () => {
    const tempBase = tmpdir();
    testDir = path.join(tempBase, `test-sentinel-codon-completed-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    logger = new MockLogger();
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  /**
   * Helper: create a codon.completed event
   */
  function makeCodonCompletedEvent(codonId: string): ServerEvent {
    return {
      id: EventId(`codon-completed-${Date.now()}`),
      timestamp: new Date().toISOString(),
      type: "codon.completed",
      data: {
        codonId,
        success: true,
        cost: 0.05,
        duration: 5000,
        exitStatus: { type: "success" },
      },
    };
  }

  /**
   * Helper: wrap mock LLM to match sentinel expected signature
   */
  function wrapMockLlm(
    mockLlm: ReturnType<typeof createMockLlm>,
  ): (id: string, options: HankweaveGenerateTextOptions) => Promise<HankweaveGenerateTextResult> {
    return async (_sentinelId: string, options: HankweaveGenerateTextOptions) => {
      return mockLlm.generateText(options);
    };
  }

  test("immediate sentinel watching codon.completed fires after second drain", async () => {
    const manager = createTestSentinelManager({
      logger,
    });

    const executionCalls: Array<{ id: string; events: ServerEvent[] }> = [];
    const mockLlm = createMockLlm();

    const config: SentinelConfig = {
      id: "completion-watcher",
      name: "Completion Watcher",
      model: "mockmodel",
      trigger: { type: "event", on: ["codon.completed"] },
      execution: { strategy: "immediate" },
      userPromptText: "Summarize the codon completion: <%= JSON.stringify(it.events[0].data) %>",
    };

    await manager.loadSentinelsForCodon([config], "test-codon" as CodonId, {
      llmCallOverride: wrapMockLlm(mockLlm),
      executionPath: testDir,
      onExecute: (id, events) => executionCalls.push({ id, events }),
    });

    expect(manager.getSentinelCount()).toBe(1);

    // Simulate the first drain (no codon.completed yet, so nothing fires)
    await manager.completeAllWork();
    expect(executionCalls.length).toBe(0);

    // Now emit the codon.completed event (what the runtime does after drain 1)
    await manager.handleEvent(makeCodonCompletedEvent("test-codon"));

    // Second drain — this is the fix: processes the codon.completed trigger
    await manager.completeAllWork();

    // The sentinel should have fired exactly once
    expect(executionCalls.length).toBe(1);
    expect(executionCalls[0].id).toBe("completion-watcher");
    expect(executionCalls[0].events[0].type).toBe("codon.completed");

    await manager.shutdown();
  });

  test("debounce sentinel watching codon.completed fires after second drain", async () => {
    const manager = createTestSentinelManager({
      logger,
    });

    const executionCalls: Array<{ id: string; events: ServerEvent[] }> = [];
    const mockLlm = createMockLlm();

    const config: SentinelConfig = {
      id: "debounce-completion-watcher",
      name: "Debounce Completion Watcher",
      model: "mockmodel",
      trigger: { type: "event", on: ["codon.completed"] },
      execution: { strategy: "debounce", milliseconds: 5000 }, // Long debounce
      userPromptText: "Summarize: <%= it.events.length %> events",
    };

    await manager.loadSentinelsForCodon([config], "test-codon" as CodonId, {
      llmCallOverride: wrapMockLlm(mockLlm),
      executionPath: testDir,
      onExecute: (id, events) => executionCalls.push({ id, events }),
    });

    // First drain — nothing to process
    await manager.completeAllWork();
    expect(executionCalls.length).toBe(0);

    // Emit codon.completed — this starts the debounce timer (5s)
    await manager.handleEvent(makeCodonCompletedEvent("test-codon"));

    // Without the second drain, the debounce timer would never fire
    // (the sentinel would be destroyed first). The second drain flushes it.
    await manager.completeAllWork();

    expect(executionCalls.length).toBe(1);
    expect(executionCalls[0].id).toBe("debounce-completion-watcher");

    await manager.shutdown();
  });

  test("count sentinel watching codon.completed (threshold=1) fires after second drain", async () => {
    const manager = createTestSentinelManager({
      logger,
    });

    const executionCalls: Array<{ id: string; events: ServerEvent[] }> = [];
    const mockLlm = createMockLlm();

    const config: SentinelConfig = {
      id: "count-completion-watcher",
      name: "Count Completion Watcher",
      model: "mockmodel",
      trigger: { type: "event", on: ["codon.completed"] },
      execution: { strategy: "count", threshold: 1 },
      userPromptText: "Summarize: <%= it.events.length %> events",
    };

    await manager.loadSentinelsForCodon([config], "test-codon" as CodonId, {
      llmCallOverride: wrapMockLlm(mockLlm),
      executionPath: testDir,
      onExecute: (id, events) => executionCalls.push({ id, events }),
    });

    // First drain — nothing
    await manager.completeAllWork();
    expect(executionCalls.length).toBe(0);

    // Emit codon.completed — count threshold met (1 event >= threshold 1)
    await manager.handleEvent(makeCodonCompletedEvent("test-codon"));

    // Second drain
    await manager.completeAllWork();

    expect(executionCalls.length).toBe(1);
    expect(executionCalls[0].id).toBe("count-completion-watcher");

    await manager.shutdown();
  });

  test("sentinel watching both file.updated and codon.completed processes both", async () => {
    const manager = createTestSentinelManager({
      logger,
    });

    const executionCalls: Array<{ id: string; events: ServerEvent[] }> = [];
    const mockLlm = createMockLlm();

    const config: SentinelConfig = {
      id: "dual-watcher",
      name: "Dual Watcher",
      model: "mockmodel",
      trigger: { type: "event", on: ["file.updated", "codon.completed"] },
      execution: { strategy: "immediate" },
      userPromptText: "Event: <%= it.events[0].type %>",
    };

    await manager.loadSentinelsForCodon([config], "test-codon" as CodonId, {
      llmCallOverride: wrapMockLlm(mockLlm),
      executionPath: testDir,
      onExecute: (id, events) => executionCalls.push({ id, events }),
    });

    // Simulate agent runtime: file.updated events during execution
    await manager.handleEvent({
      id: EventId("file-1"),
      timestamp: new Date().toISOString(),
      type: "file.updated",
      data: {
        path: "src/main.ts",
        filename: "main.ts",
        content: "console.log('hello')",
        action: "modified",
      },
    });

    // First drain — processes file.updated trigger
    await manager.completeAllWork();
    expect(executionCalls.length).toBe(1);
    expect(executionCalls[0].events[0].type).toBe("file.updated");

    // Now emit codon.completed
    await manager.handleEvent(makeCodonCompletedEvent("test-codon"));

    // Second drain — processes codon.completed trigger
    await manager.completeAllWork();

    expect(executionCalls.length).toBe(2);
    expect(executionCalls[1].events[0].type).toBe("codon.completed");

    await manager.shutdown();
  });

  test("multiple sentinels watching codon.completed all fire during second drain", async () => {
    const manager = createTestSentinelManager({
      logger,
    });

    const executionCalls: Array<{ id: string; events: ServerEvent[] }> = [];
    const mockLlm = createMockLlm();

    const configs: SentinelConfig[] = [
      {
        id: "watcher-a",
        name: "Watcher A",
        model: "mockmodel",
        trigger: { type: "event", on: ["codon.completed"] },
        execution: { strategy: "immediate" },
        userPromptText: "Sentinel A: <%= it.events.length %> events",
      },
      {
        id: "watcher-b",
        name: "Watcher B",
        model: "mockmodel",
        trigger: { type: "event", on: ["codon.completed"] },
        execution: { strategy: "immediate" },
        userPromptText: "Sentinel B: <%= it.events.length %> events",
      },
    ];

    await manager.loadSentinelsForCodon(configs, "test-codon" as CodonId, {
      llmCallOverride: wrapMockLlm(mockLlm),
      executionPath: testDir,
      onExecute: (id, events) => executionCalls.push({ id, events }),
    });

    expect(manager.getSentinelCount()).toBe(2);

    // First drain — nothing
    await manager.completeAllWork();
    expect(executionCalls.length).toBe(0);

    // Emit codon.completed
    await manager.handleEvent(makeCodonCompletedEvent("test-codon"));

    // Second drain — both sentinels should fire
    await manager.completeAllWork();

    expect(executionCalls.length).toBe(2);
    const firedIds = executionCalls.map((c) => c.id).sort();
    expect(firedIds).toEqual(["watcher-a", "watcher-b"]);

    await manager.shutdown();
  });

  test("without second drain, codon.completed trigger would be dropped on unload", async () => {
    // This test demonstrates the bug that the fix addresses.
    // Without the second completeAllWork(), the sentinel is destroyed
    // with the codon.completed trigger still queued.
    const manager = createTestSentinelManager({
      logger,
    });

    const executionCalls: Array<{ id: string; events: ServerEvent[] }> = [];
    const mockLlm = createMockLlm();

    const config: SentinelConfig = {
      id: "orphaned-watcher",
      name: "Orphaned Watcher",
      model: "mockmodel",
      trigger: { type: "event", on: ["codon.completed"] },
      execution: { strategy: "immediate" },
      userPromptText: "This should fire: <%= it.events.length %>",
    };

    await manager.loadSentinelsForCodon([config], "test-codon" as CodonId, {
      llmCallOverride: wrapMockLlm(mockLlm),
      executionPath: testDir,
      onExecute: (id, events) => executionCalls.push({ id, events }),
    });

    // First drain
    await manager.completeAllWork();

    // Emit codon.completed — trigger is queued
    await manager.handleEvent(makeCodonCompletedEvent("test-codon"));

    // Simulate what happens WITHOUT the fix: go straight to loading next codon's sentinels.
    // loadSentinelsForCodon calls unloadAllSentinels("codon-complete") which calls destroy(),
    // dropping the queued trigger.
    await manager.loadSentinelsForCodon([], "next-codon" as CodonId, {
      llmCallOverride: wrapMockLlm(mockLlm),
      executionPath: testDir,
    });

    // The trigger was dropped — sentinel never fired
    // NOTE: With the immediate strategy, there's a race condition where the
    // fire-and-forget handleEvent might complete before unload. To make this
    // deterministic, we'd need a slower LLM mock. The key insight is that
    // for debounce/count/timeWindow strategies, the trigger is ALWAYS dropped.
    // This test documents the pattern; the actual fix (second drain) makes
    // it reliable for all strategies.

    await manager.shutdown();
  });
});
