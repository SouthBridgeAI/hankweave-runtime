import { describe, expect, test } from "bun:test";
import { type ExecutionCodonEntry, ExecutionPlanner } from "../../server/execution-planner.js";
import { CodonId, RunId, SessionId } from "../../server/types/branded-types.js";
import type { CodonExecution, Run } from "../../server/types/state-types.js";
import type { Codon, CodonConfig, Loop } from "../../server/types/types.js";
import { createTestCodon } from "../utils/test-codon-factory.js";

// ============================================================================
// Test Fixtures
// ============================================================================

const createCodon = (id: string, name: string): Codon =>
  createTestCodon({
    id,
    name,
    model: "sonnet",
    continuationMode: "fresh",
    promptText: `Prompt for ${name}`,
  });

const createLoop = (
  id: string,
  name: string,
  codons: Codon[],
  terminateOn: Loop["terminateOn"],
): Loop => ({
  type: "loop",
  id: CodonId(id),
  name,
  codons,
  terminateOn,
});

const _createCompletedCodon = (
  codonId: string,
  loopContext?: ExecutionCodonEntry["loopContext"],
): CodonExecution => {
  const codon: CodonExecution = {
    status: "completed",
    codonId: CodonId(codonId),
    startTime: "2024-01-01T00:00:00Z",
    endTime: "2024-01-01T00:01:00Z",
    claudeSessionId: SessionId("session-123"),
    claudeLogPath: "/path/to/log",
    exitCode: 0,
    finalCost: 0.01,
    finalTokens: {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    resultMessageReceived: true,
    extensionCount: 0,
    completionCheckpoint: "commit-123",
  };
  // Add loopContext for testing (will be typed properly in Step 6)
  if (loopContext) {
    // biome-ignore lint/suspicious/noExplicitAny: loopContext will be added to CodonExecution in Step 6
    (codon as any).loopContext = loopContext;
  }
  return codon;
};

const _createRunWithCodons = (codons: CodonExecution[]): Run => ({
  runId: RunId("test-run"),
  runFolder: "/test/run",
  gitBranch: "test-branch",
  startingConditions: { type: "fresh" },
  codons,
  status: "running",
  startTime: "2024-01-01T00:00:00Z",
  serverPid: 12345,
});

// ============================================================================
// Test: buildInitialPlan()
// ============================================================================

describe("ExecutionPlanner - buildInitialPlan", () => {
  test("expands only first iteration of a loop", () => {
    const loopCodon1 = createCodon("write-code", "Write Code");
    const loopCodon2 = createCodon("write-tests", "Write Tests");

    const configs: CodonConfig[] = [
      createLoop("dev-loop", "Development Loop", [loopCodon1, loopCodon2], {
        type: "iterationLimit",
        limit: 3,
      }),
    ];

    const planner = new ExecutionPlanner(configs);
    const plan = planner.buildInitialPlan();

    expect(plan).toHaveLength(2); // Only first iteration

    // Check first codon
    expect(plan[0].codonId).toBe(CodonId("write-code#0"));
    expect(plan[0].codon).toEqual(loopCodon1);
    expect(plan[0].loopContext).toEqual({
      loopId: CodonId("dev-loop"),
      iteration: 0,
      codonIndexInLoop: 0,
    });

    // Check second codon
    expect(plan[1].codonId).toBe(CodonId("write-tests#0"));
    expect(plan[1].codon).toEqual(loopCodon2);
    expect(plan[1].loopContext).toEqual({
      loopId: CodonId("dev-loop"),
      iteration: 0,
      codonIndexInLoop: 1,
    });
  });

  test("handles mixed codons and loops", () => {
    const codon1 = createCodon("setup", "Setup");
    const loopCodon1 = createCodon("review", "Review");
    const loopCodon2 = createCodon("refine", "Refine");
    const codon2 = createCodon("finalize", "Finalize");

    const configs: CodonConfig[] = [
      codon1,
      createLoop("review-loop", "Review Loop", [loopCodon1, loopCodon2], {
        type: "iterationLimit",
        limit: 2,
      }),
      codon2,
    ];

    const planner = new ExecutionPlanner(configs);
    const plan = planner.buildInitialPlan();

    expect(plan).toHaveLength(4); // setup + review#1 + refine#1 + finalize

    // Check setup (regular codon)
    expect(plan[0].codonId).toBe(CodonId("setup"));
    expect(plan[0].loopContext).toBeUndefined();

    // Check loop codons (first iteration only)
    expect(plan[1].codonId).toBe(CodonId("review#0"));
    expect(plan[1].loopContext?.iteration).toBe(0);

    expect(plan[2].codonId).toBe(CodonId("refine#0"));
    expect(plan[2].loopContext?.iteration).toBe(0);

    // Check finalize (regular codon)
    expect(plan[3].codonId).toBe(CodonId("finalize"));
    expect(plan[3].loopContext).toBeUndefined();
  });

  test("handles multiple loops", () => {
    const loop1Codon = createCodon("analyze", "Analyze");
    const loop2Codon = createCodon("implement", "Implement");

    const configs: CodonConfig[] = [
      createLoop("loop-1", "Loop 1", [loop1Codon], {
        type: "iterationLimit",
        limit: 2,
      }),
      createLoop("loop-2", "Loop 2", [loop2Codon], {
        type: "iterationLimit",
        limit: 3,
      }),
    ];

    const planner = new ExecutionPlanner(configs);
    const plan = planner.buildInitialPlan();

    expect(plan).toHaveLength(2); // One codon from each loop (first iteration)

    expect(plan[0].codonId).toBe(CodonId("analyze#0"));
    expect(plan[0].loopContext?.loopId).toBe(CodonId("loop-1"));

    expect(plan[1].codonId).toBe(CodonId("implement#0"));
    expect(plan[1].loopContext?.loopId).toBe(CodonId("loop-2"));
  });

  test("handles contextExceeded termination", () => {
    const loopCodon = createCodon("iterate", "Iterate");

    const configs: CodonConfig[] = [
      createLoop("context-loop", "Context Loop", [loopCodon], {
        type: "contextExceeded",
      }),
    ];

    const planner = new ExecutionPlanner(configs);
    const plan = planner.buildInitialPlan();

    expect(plan).toHaveLength(1); // Only first iteration
    expect(plan[0].codonId).toBe(CodonId("iterate#0"));
  });
});

// ============================================================================
// Test: expandNextIteration()
// ============================================================================
//
// These tests verify how the execution plan grows as loop iterations complete.
// Key concept: New iterations are only added when the LAST codon in a loop
// iteration completes. The plan expands incrementally, one iteration at a time.
//
// ============================================================================

describe("ExecutionPlanner - expandNextIteration", () => {
  test("adds next iteration when last codon of iteration completes", () => {
    // Config: Loop(dev-loop, limit:3) { write, test }
    //
    // Initial plan:
    //   write#0 → test#0
    //
    // After completing write#0:
    //   write#0 → test#0
    //   (no change - not last codon in iteration)
    //
    // After completing test#0:
    //   write#0 → test#0 → write#1 → test#1
    //                      └─ iteration 1 added
    const loopCodon1 = createCodon("write", "Write");
    const loopCodon2 = createCodon("test", "Test");

    const configs: CodonConfig[] = [
      createLoop("dev-loop", "Dev Loop", [loopCodon1, loopCodon2], {
        type: "iterationLimit",
        limit: 3,
      }),
    ];

    const planner = new ExecutionPlanner(configs);
    let plan = planner.buildInitialPlan();

    // Complete first codon (write#0) - should not add iteration
    plan = planner.expandNextIteration({
      currentPlan: plan,
      completedCodonId: CodonId("write#0"),
    });
    expect(plan).toHaveLength(2); // Still just iteration 0

    // Complete second codon (test#0) - should add iteration 1
    plan = planner.expandNextIteration({
      currentPlan: plan,
      completedCodonId: CodonId("test#0"),
    });
    expect(plan).toHaveLength(4); // Iteration 0 + iteration 1

    expect(plan[2].codonId).toBe(CodonId("write#1"));
    expect(plan[2].loopContext?.iteration).toBe(1);

    expect(plan[3].codonId).toBe(CodonId("test#1"));
    expect(plan[3].loopContext?.iteration).toBe(1);
  });

  test("stops at iteration limit", () => {
    // Config: Loop(limited-loop, limit:2) { work }
    //
    // Initial plan:
    //   work#0
    //
    // After completing work#0:
    //   work#0 → work#1
    //            └─ iteration 1 added
    //
    // After completing work#1:
    //   work#0 → work#1
    //   (no change - limit:2 reached, only iterations 0 and 1)
    const loopCodon = createCodon("work", "Work");

    const configs: CodonConfig[] = [
      createLoop("limited-loop", "Limited Loop", [loopCodon], {
        type: "iterationLimit",
        limit: 2,
      }),
    ];

    const planner = new ExecutionPlanner(configs);
    let plan = planner.buildInitialPlan();

    // Complete work#0 - should add iteration 1
    plan = planner.expandNextIteration({
      currentPlan: plan,
      completedCodonId: CodonId("work#0"),
    });
    expect(plan).toHaveLength(2);
    expect(plan[1].codonId).toBe(CodonId("work#1"));

    // Complete work#1 - should NOT add iteration 2 (limit of 2 means iterations 0 and 1 only)
    plan = planner.expandNextIteration({
      currentPlan: plan,
      completedCodonId: CodonId("work#1"),
    });
    expect(plan).toHaveLength(2); // No new codons added
  });

  test("contextExceeded continues indefinitely", () => {
    // Config: Loop(endless-loop, contextExceeded) { iterate }
    //
    // Initial plan:
    //   iterate#0
    //
    // After completing iterate#0:
    //   iterate#0 → iterate#1
    //
    // After completing iterate#1:
    //   iterate#0 → iterate#1 → iterate#2
    //
    // ... continues indefinitely until contextExceeded=true is passed
    const loopCodon = createCodon("iterate", "Iterate");

    const configs: CodonConfig[] = [
      createLoop("endless-loop", "Endless Loop", [loopCodon], {
        type: "contextExceeded",
      }),
    ];

    const planner = new ExecutionPlanner(configs);
    let plan = planner.buildInitialPlan();

    // Complete iterate#0 through iterate#4, should keep adding (5 total iterations)
    for (let i = 0; i < 5; i++) {
      plan = planner.expandNextIteration({
        currentPlan: plan,
        completedCodonId: CodonId(`iterate#${i}`),
      });
      expect(plan).toHaveLength(i + 2); // Should grow each time
      expect(plan[i + 1].codonId).toBe(CodonId(`iterate#${i + 1}`));
    }
  });

  test("injects new iteration at correct position", () => {
    // Config: setup, Loop(work-loop, limit:3) { work }, finalize
    //
    // Initial plan:
    //   setup → work#0 → finalize
    //
    // After completing work#0:
    //   setup → work#0 → work#1 → finalize
    //                    └─ injected before finalize
    const codon1 = createCodon("setup", "Setup");
    const loopCodon = createCodon("work", "Work");
    const codon2 = createCodon("finalize", "Finalize");

    const configs: CodonConfig[] = [
      codon1,
      createLoop("work-loop", "Work Loop", [loopCodon], {
        type: "iterationLimit",
        limit: 3,
      }),
      codon2,
    ];

    const planner = new ExecutionPlanner(configs);
    let plan = planner.buildInitialPlan();

    expect(plan).toHaveLength(3); // setup, work#0, finalize

    // Complete work#0 - should inject work#1 between work#0 and finalize
    plan = planner.expandNextIteration({
      currentPlan: plan,
      completedCodonId: CodonId("work#0"),
    });
    expect(plan).toHaveLength(4);
    expect(plan[0].codonId).toBe(CodonId("setup"));
    expect(plan[1].codonId).toBe(CodonId("work#0"));
    expect(plan[2].codonId).toBe(CodonId("work#1")); // Injected here
    expect(plan[3].codonId).toBe(CodonId("finalize"));
  });

  test("throws error for codon not found", () => {
    const codon = createCodon("regular", "Regular");

    const configs: CodonConfig[] = [codon];

    const planner = new ExecutionPlanner(configs);
    const plan = planner.buildInitialPlan();

    // Try to expand with non-existent codon - should throw error
    expect(() =>
      planner.expandNextIteration({
        currentPlan: plan,
        completedCodonId: CodonId("non-existent"),
      }),
    ).toThrow("Codon not found in plan: non-existent");
  });

  test("throws error for non-loop codons", () => {
    const codon = createCodon("regular", "Regular");

    const configs: CodonConfig[] = [codon];

    const planner = new ExecutionPlanner(configs);
    const plan = planner.buildInitialPlan();

    // Try to expand - should throw error since codon is not in a loop
    expect(() =>
      planner.expandNextIteration({
        currentPlan: plan,
        completedCodonId: CodonId("regular"),
      }),
    ).toThrow("Not in a loop: regular");
  });
});

// ============================================================================
// Test: expandNextIteration() - Context Exceeded Handling
// ============================================================================
//
// These tests verify how contextExceeded flag affects loop expansion.
// Key concepts:
//   - For loops with terminateOn: { type: "contextExceeded" }, the loop stops
//     when contextExceeded=true is passed after completing a codon
//   - For loops with terminateOn: { type: "iterationLimit" }, contextExceeded
//     is ignored - the loop runs until the iteration limit
//   - If contextExceeded=true at a non-last codon, remaining codons in that
//     iteration are REMOVED from the plan
//
// ============================================================================

describe("ExecutionPlanner - expandNextIteration - context exceeded", () => {
  test("contextExceeded=true stops loop with contextExceeded termination", () => {
    // Config: Loop(context-loop, contextExceeded) { work }
    //
    // Initial plan:
    //   work#0
    //
    // After completing work#0 with contextExceeded=true:
    //   work#0
    //   (no expansion - context exceeded stops loop)
    const loopCodon = createCodon("work", "Work");

    const configs: CodonConfig[] = [
      createLoop("context-loop", "Context Loop", [loopCodon], {
        type: "contextExceeded",
      }),
    ];

    const planner = new ExecutionPlanner(configs);
    let plan = planner.buildInitialPlan();

    expect(plan).toHaveLength(1); // work#0

    // Complete work#0 with contextExceeded=true - should NOT expand
    plan = planner.expandNextIteration({
      currentPlan: plan,
      completedCodonId: CodonId("work#0"),
      contextExceeded: true,
    });
    expect(plan).toHaveLength(1); // No new iteration added
  });

  test("contextExceeded=false continues loop with contextExceeded termination", () => {
    // Config: Loop(context-loop, contextExceeded) { work }
    //
    // Initial plan:
    //   work#0
    //
    // After completing work#0 with contextExceeded=false:
    //   work#0 → work#1
    //
    // After completing work#1 with contextExceeded=false:
    //   work#0 → work#1 → work#2
    const loopCodon = createCodon("work", "Work");

    const configs: CodonConfig[] = [
      createLoop("context-loop", "Context Loop", [loopCodon], {
        type: "contextExceeded",
      }),
    ];

    const planner = new ExecutionPlanner(configs);
    let plan = planner.buildInitialPlan();

    expect(plan).toHaveLength(1); // work#0

    // Complete work#0 with contextExceeded=false - should expand
    plan = planner.expandNextIteration({
      currentPlan: plan,
      completedCodonId: CodonId("work#0"),
      contextExceeded: false,
    });
    expect(plan).toHaveLength(2); // work#0, work#1
    expect(plan[1].codonId).toBe(CodonId("work#1"));

    // Complete work#1 with contextExceeded=false - should expand again
    plan = planner.expandNextIteration({
      currentPlan: plan,
      completedCodonId: CodonId("work#1"),
      contextExceeded: false,
    });
    expect(plan).toHaveLength(3); // work#0, work#1, work#2
    expect(plan[2].codonId).toBe(CodonId("work#2"));
  });

  test("contextExceeded=true does NOT stop loop with iterationLimit termination", () => {
    // Config: Loop(limited-loop, limit:3) { work }
    //
    // Initial plan:
    //   work#0
    //
    // After completing work#0 with contextExceeded=true:
    //   work#0 → work#1
    //   (still expands - iterationLimit ignores contextExceeded flag)
    const loopCodon = createCodon("work", "Work");

    const configs: CodonConfig[] = [
      createLoop("limited-loop", "Limited Loop", [loopCodon], {
        type: "iterationLimit",
        limit: 3,
      }),
    ];

    const planner = new ExecutionPlanner(configs);
    let plan = planner.buildInitialPlan();

    expect(plan).toHaveLength(1); // work#0

    // Complete work#0 with contextExceeded=true
    // Should STILL expand because loop terminates on iterationLimit, not contextExceeded
    plan = planner.expandNextIteration({
      currentPlan: plan,
      completedCodonId: CodonId("work#0"),
      contextExceeded: true,
    });
    expect(plan).toHaveLength(2); // work#0, work#1
    expect(plan[1].codonId).toBe(CodonId("work#1"));
  });

  test("contextExceeded stops multi-codon loop at correct point", () => {
    // Config: Loop(dev-loop, contextExceeded) { analyze, implement, test }
    //
    // Initial plan:
    //   analyze#0 → implement#0 → test#0
    //
    // After completing analyze#0:
    //   analyze#0 → implement#0 → test#0
    //   (no change - not last codon in iteration)
    //
    // After completing implement#0:
    //   analyze#0 → implement#0 → test#0
    //   (no change - not last codon in iteration)
    //
    // After completing test#0 with contextExceeded=false:
    //   analyze#0 → implement#0 → test#0 → analyze#1 → implement#1 → test#1
    //                                       └─ iteration 1 added
    //
    // After completing test#1 with contextExceeded=true:
    //   analyze#0 → implement#0 → test#0 → analyze#1 → implement#1 → test#1
    //   (no iteration 2 - context exceeded stops loop)
    const loopCodon1 = createCodon("analyze", "Analyze");
    const loopCodon2 = createCodon("implement", "Implement");
    const loopCodon3 = createCodon("test", "Test");

    const configs: CodonConfig[] = [
      createLoop("dev-loop", "Dev Loop", [loopCodon1, loopCodon2, loopCodon3], {
        type: "contextExceeded",
      }),
    ];

    const planner = new ExecutionPlanner(configs);
    let plan = planner.buildInitialPlan();

    expect(plan).toHaveLength(3); // First iteration: analyze#0, implement#0, test#0

    // Complete analyze#0 (not last codon) - should not expand
    plan = planner.expandNextIteration({
      currentPlan: plan,
      completedCodonId: CodonId("analyze#0"),
      contextExceeded: false,
    });
    expect(plan).toHaveLength(3);

    // Complete implement#0 (not last codon) - should not expand
    plan = planner.expandNextIteration({
      currentPlan: plan,
      completedCodonId: CodonId("implement#0"),
      contextExceeded: false,
    });
    expect(plan).toHaveLength(3);

    // Complete test#0 (last codon) with contextExceeded=false - should expand
    plan = planner.expandNextIteration({
      currentPlan: plan,
      completedCodonId: CodonId("test#0"),
      contextExceeded: false,
    });
    expect(plan).toHaveLength(6); // Second iteration added
    expect(plan[3].codonId).toBe(CodonId("analyze#1"));
    expect(plan[4].codonId).toBe(CodonId("implement#1"));
    expect(plan[5].codonId).toBe(CodonId("test#1"));

    // Complete test#1 (last codon) with contextExceeded=true - should NOT expand
    plan = planner.expandNextIteration({
      currentPlan: plan,
      completedCodonId: CodonId("test#1"),
      contextExceeded: true,
    });
    expect(plan).toHaveLength(6); // No new iteration
  });

  test("contextExceeded works correctly with codons before and after loop", () => {
    // Config: setup, Loop(work-loop, contextExceeded) { work }, finalize
    //
    // Initial plan:
    //   setup → work#0 → finalize
    //
    // After completing work#0 with contextExceeded=false:
    //   setup → work#0 → work#1 → finalize
    //                    └─ injected before finalize
    //
    // After completing work#1 with contextExceeded=true:
    //   setup → work#0 → work#1 → finalize
    //   (no work#2 - loop stopped, finalize still at end)
    const setupCodon = createCodon("setup", "Setup");
    const loopCodon = createCodon("work", "Work");
    const finalizeCodon = createCodon("finalize", "Finalize");

    const configs: CodonConfig[] = [
      setupCodon,
      createLoop("work-loop", "Work Loop", [loopCodon], {
        type: "contextExceeded",
      }),
      finalizeCodon,
    ];

    const planner = new ExecutionPlanner(configs);
    let plan = planner.buildInitialPlan();

    expect(plan).toHaveLength(3); // setup, work#0, finalize

    // Complete work#0 with contextExceeded=false - should expand
    plan = planner.expandNextIteration({
      currentPlan: plan,
      completedCodonId: CodonId("work#0"),
      contextExceeded: false,
    });
    expect(plan).toHaveLength(4); // setup, work#0, work#1, finalize
    expect(plan[2].codonId).toBe(CodonId("work#1"));
    expect(plan[3].codonId).toBe(CodonId("finalize")); // Finalize pushed down

    // Complete work#1 with contextExceeded=true - should NOT expand
    plan = planner.expandNextIteration({
      currentPlan: plan,
      completedCodonId: CodonId("work#1"),
      contextExceeded: true,
    });
    expect(plan).toHaveLength(4); // No change
    expect(plan[3].codonId).toBe(CodonId("finalize")); // Finalize still at end
  });

  test("default contextExceeded=false continues contextExceeded loop", () => {
    // Config: Loop(context-loop, contextExceeded) { work }
    //
    // Initial plan:
    //   work#0
    //
    // After completing work#0 (no contextExceeded param):
    //   work#0 → work#1
    //   (expands because contextExceeded defaults to false)
    const loopCodon = createCodon("work", "Work");

    const configs: CodonConfig[] = [
      createLoop("context-loop", "Context Loop", [loopCodon], {
        type: "contextExceeded",
      }),
    ];

    const planner = new ExecutionPlanner(configs);
    let plan = planner.buildInitialPlan();

    // Call without contextExceeded parameter (should default to false)
    plan = planner.expandNextIteration({
      currentPlan: plan,
      completedCodonId: CodonId("work#0"),
    });
    expect(plan).toHaveLength(2); // Should expand since default is false
    expect(plan[1].codonId).toBe(CodonId("work#1"));
  });

  test("contextExceeded at non-last codon in loop removes remaining codons in iteration", () => {
    // Config: Loop(main-loop, contextExceeded) { analyze, refine }, finalize
    //
    // Initial plan:
    //   analyze#0 → refine#0 → finalize
    //
    // After completing analyze#0 with contextExceeded=true:
    //   analyze#0 → finalize
    //               └─ refine#0 removed (mid-iteration stop)
    //
    // Key: remaining codons in iteration are removed, but post-loop codons kept
    const loopCodon1 = createCodon("analyze", "Analyze");
    const loopCodon2 = createCodon("refine", "Refine");
    const finalCodon = createCodon("finalize", "Finalize");

    const configs: CodonConfig[] = [
      createLoop("main-loop", "Main Loop", [loopCodon1, loopCodon2], {
        type: "contextExceeded",
      }),
      finalCodon,
    ];

    const planner = new ExecutionPlanner(configs);
    let plan = planner.buildInitialPlan();

    // Initial plan should have first iteration of loop + finalize
    expect(plan).toHaveLength(3);
    expect(plan[0].codonId).toBe(CodonId("analyze#0"));
    expect(plan[1].codonId).toBe(CodonId("refine#0"));
    expect(plan[2].codonId).toBe(CodonId("finalize"));

    // Complete analyze#0 (first codon in loop) with contextExceeded=true
    // Should remove remaining codons in iteration (refine#0) but keep finalize
    plan = planner.expandNextIteration({
      currentPlan: plan,
      completedCodonId: CodonId("analyze#0"),
      contextExceeded: true,
    });

    expect(plan).toHaveLength(2);
    expect(plan[0].codonId).toBe(CodonId("analyze#0"));
    expect(plan[1].codonId).toBe(CodonId("finalize"));
  });

  test("contextExceeded at last codon in loop removes no codons but prevents next iteration", () => {
    // Config: Loop(main-loop, contextExceeded) { analyze, refine }, finalize
    //
    // Initial plan:
    //   analyze#0 → refine#0 → finalize
    //
    // After completing analyze#0:
    //   analyze#0 → refine#0 → finalize
    //   (no change - not last codon)
    //
    // After completing refine#0 with contextExceeded=true:
    //   analyze#0 → refine#0 → finalize
    //   (no iteration 1 - but no codons removed since iteration completed)
    const loopCodon1 = createCodon("analyze", "Analyze");
    const loopCodon2 = createCodon("refine", "Refine");
    const finalCodon = createCodon("finalize", "Finalize");

    const configs: CodonConfig[] = [
      createLoop("main-loop", "Main Loop", [loopCodon1, loopCodon2], {
        type: "contextExceeded",
      }),
      finalCodon,
    ];

    const planner = new ExecutionPlanner(configs);
    let plan = planner.buildInitialPlan();

    expect(plan).toHaveLength(3); // analyze#0, refine#0, finalize

    // Complete analyze#0 without context exceeded - should not expand yet
    plan = planner.expandNextIteration({
      currentPlan: plan,
      completedCodonId: CodonId("analyze#0"),
      contextExceeded: false,
    });
    expect(plan).toHaveLength(3); // No change, not at last codon

    // Complete refine#0 (last codon in loop) with contextExceeded=true
    // Should NOT add next iteration but should keep finalize
    plan = planner.expandNextIteration({
      currentPlan: plan,
      completedCodonId: CodonId("refine#0"),
      contextExceeded: true,
    });

    expect(plan).toHaveLength(3); // analyze#0, refine#0, finalize (no new iteration)
    expect(plan[0].codonId).toBe(CodonId("analyze#0"));
    expect(plan[1].codonId).toBe(CodonId("refine#0"));
    expect(plan[2].codonId).toBe(CodonId("finalize"));
  });
});

// ============================================================================
// Test: validatePlan()
// ============================================================================

describe("ExecutionPlanner - validatePlan", () => {
  test("detects duplicate codon IDs", () => {
    const codon = createCodon("test", "Test");

    const configs: CodonConfig[] = [codon];
    const planner = new ExecutionPlanner(configs);

    // Create plan with duplicate IDs
    const invalidPlan: ExecutionCodonEntry[] = [
      { codon, codonId: CodonId("test") },
      { codon, codonId: CodonId("test") }, // Duplicate
    ];

    expect(() => planner.validatePlan(invalidPlan)).toThrow("Duplicate codon IDs");
  });

  test("detects invalid loop config index", () => {
    const codon = createCodon("test", "Test");

    const configs: CodonConfig[] = [codon];
    const planner = new ExecutionPlanner(configs);

    // Create plan with invalid loop context
    const invalidPlan: ExecutionCodonEntry[] = [
      {
        codon,
        codonId: CodonId("test#1"),
        loopContext: {
          loopId: CodonId("nonexistent-loop"),
          iteration: 1,
          codonIndexInLoop: 0,
        },
      },
    ];

    expect(() => planner.validatePlan(invalidPlan)).toThrow("Loop not found");
  });

  test("detects codon index out of bounds", () => {
    const loopCodon = createCodon("work", "Work");

    const configs: CodonConfig[] = [
      createLoop("loop", "Loop", [loopCodon], {
        type: "iterationLimit",
        limit: 2,
      }),
    ];
    const planner = new ExecutionPlanner(configs);

    // Create plan with out-of-bounds codon index
    const invalidPlan: ExecutionCodonEntry[] = [
      {
        codon: loopCodon,
        codonId: CodonId("work#1"),
        loopContext: {
          loopId: CodonId("loop"),
          iteration: 1,
          codonIndexInLoop: 5, // Out of bounds (loop only has 1 codon)
        },
      },
    ];

    expect(() => planner.validatePlan(invalidPlan)).toThrow("Codon index 5 out of bounds");
  });

  test("passes validation for valid plan", () => {
    const loopCodon1 = createCodon("write", "Write");
    const loopCodon2 = createCodon("test", "Test");

    const configs: CodonConfig[] = [
      createLoop("dev-loop", "Dev Loop", [loopCodon1, loopCodon2], {
        type: "iterationLimit",
        limit: 2,
      }),
    ];

    const planner = new ExecutionPlanner(configs);
    const plan = planner.buildInitialPlan();

    // Should not throw
    expect(() => planner.validatePlan(plan)).not.toThrow();
  });
});
