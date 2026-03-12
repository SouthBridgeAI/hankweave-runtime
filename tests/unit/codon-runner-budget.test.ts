/**
 * Tests for CodonRunner's integration with the Budget facade.
 *
 * Verifies that CodonRunner correctly initializes budget tracking via
 * trackCodon and responds to Budget exceeded events. Allocation logic
 * itself is tested in budget.test.ts and budget-allocator.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Budget, type BudgetConfig } from "../../server/budget.js";
import { CodonRunner } from "../../server/codon-runner.js";
import type { ExecutionCodonEntry } from "../../server/execution-planner.js";
import type { LlmProviderRegistry } from "../../server/llm/llm-provider-registry.js";
import type { StateManager } from "../../server/state-manager.js";
import type { CodonId, RunId } from "../../server/types/branded-types.js";
import { Logger } from "../../server/utils.js";
import { createTestCodon } from "../utils/test-codon-factory.js";

const mockLlmRegistry = {
  calculateCost: () => null,
} as unknown as LlmProviderRegistry;

const mockRunId = "test-run-id" as unknown as RunId;

function createMockStateManager() {
  return {
    transition: () => {},
    getState: () => ({
      executionPlan: [],
    }),
    getCodonInCurrentRun: () => null,
    getCurrentRun: () => null,
  } as unknown as StateManager;
}

function createBudget(config: BudgetConfig = {}, plan: ExecutionCodonEntry[] = []): Budget {
  const logger = new Logger("/dev/null");
  return new Budget({ config, executionPlan: plan, logger });
}

describe("CodonRunner budget integration", () => {
  let tempDir: string;
  let logger: Logger;
  let runner: CodonRunner | null = null;

  beforeEach(async () => {
    tempDir = path.resolve("tests", "test-area", `temp-codon-runner-budget-${Date.now()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });
    logger = new Logger(path.join(tempDir, "test.log"));
  });

  afterEach(async () => {
    if (runner) {
      runner.cleanup();
      runner = null;
    }
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  test("constructs with a Budget instance and calls trackCodon", () => {
    const codon = createTestCodon({
      id: "test-codon",
      name: "Test Codon",
      promptText: "Test prompt",
      model: "sonnet",
      continuationMode: "fresh",
    });
    const codonId = "test-codon" as CodonId;
    const plan: ExecutionCodonEntry[] = [{ codon, codonId }];
    const budget = createBudget({}, plan);

    runner = new CodonRunner({
      codon,
      codonId,
      executionPath: tempDir,
      agentRootPath: tempDir,
      logger,
      llmRegistry: mockLlmRegistry,
      runId: mockRunId,
      stateManager: createMockStateManager(),
      logPath: path.join(tempDir, "session.jsonl"),
      budget,
    });

    // Runner created successfully and trackCodon was called (limits resolved)
    expect(runner).toBeTruthy();
    expect(budget.getEffectiveLimits(codonId)).toBeDefined();
  });

  test("budget.isExceeded is false when no limits configured", () => {
    const codonId = "test-codon" as CodonId;
    const codon = createTestCodon({
      id: "test-codon",
      name: "Test Codon",
      promptText: "Test prompt",
      model: "sonnet",
      continuationMode: "fresh",
    });

    const plan: ExecutionCodonEntry[] = [{ codon, codonId }];
    const budget = createBudget({}, plan);

    runner = new CodonRunner({
      codon,
      codonId,
      executionPath: tempDir,
      agentRootPath: tempDir,
      logger,
      llmRegistry: mockLlmRegistry,
      runId: mockRunId,
      stateManager: createMockStateManager(),
      logPath: path.join(tempDir, "session.jsonl"),
      budget,
    });

    expect(budget.isExceeded(codonId)).toBe(false);
  });

  test("budget exceeded event is emitted when limit is breached via CostTracker", () => {
    const codonId = "test-codon" as CodonId;
    const codon = createTestCodon({
      id: "test-codon",
      name: "Test Codon",
      promptText: "Test prompt",
      model: "sonnet",
      continuationMode: "fresh",
    });
    (codon as Record<string, unknown>).budget = { maxDollars: 1.0 };

    const plan: ExecutionCodonEntry[] = [{ codon, codonId }];
    // Mock that returns a real cost so CostTracker emits non-zero costDelta
    const llmRegistryWithCost = {
      calculateCost: () => 2.0,
    } as unknown as LlmProviderRegistry;
    const budget = createBudget({}, plan);

    runner = new CodonRunner({
      codon,
      codonId,
      executionPath: tempDir,
      agentRootPath: tempDir,
      logger,
      llmRegistry: llmRegistryWithCost,
      runId: mockRunId,
      stateManager: createMockStateManager(),
      logPath: path.join(tempDir, "session.jsonl"),
      budget,
    });

    // Simulate cost via the runner's internal CostTracker by feeding raw usage
    // CostTracker.handleAssistantUsage emits costIncremented → Budget picks it up
    (
      runner as unknown as { costTracker: { handleAssistantUsage: (u: unknown) => void } }
    ).costTracker.handleAssistantUsage({
      input_tokens: 1000,
      output_tokens: 1000,
    });

    expect(budget.isExceeded(codonId)).toBe(true);
    expect(budget.getExceededInfo(codonId)).toBeDefined();
    expect(budget.getExceededInfo(codonId)?.currency).toBe("cost");
  });

  test("budget with global maxDollars resolves limits", () => {
    const codonId = "test-codon" as CodonId;
    const codon = createTestCodon({
      id: "test-codon",
      name: "Test Codon",
      promptText: "Test prompt",
      model: "sonnet",
      continuationMode: "fresh",
    });

    const plan: ExecutionCodonEntry[] = [{ codon, codonId }];
    const budget = createBudget({ maxDollars: 10.0 }, plan);

    runner = new CodonRunner({
      codon,
      codonId,
      executionPath: tempDir,
      agentRootPath: tempDir,
      logger,
      llmRegistry: mockLlmRegistry,
      runId: mockRunId,
      stateManager: createMockStateManager(),
      logPath: path.join(tempDir, "session.jsonl"),
      budget,
    });

    expect(budget.isExceeded(codonId)).toBe(false);
    expect(budget.getEffectiveLimits(codonId).maxDollars).toBe(10.0);
  });
});
