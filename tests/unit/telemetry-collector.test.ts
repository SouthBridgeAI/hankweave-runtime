import { describe, expect, test } from "bun:test";
import type { ServerEvent } from "../../server/schemas/event-schemas.js";
import { TelemetryCollector } from "../../server/telemetry/telemetry-collector.js";

interface CollectorInternals {
  accumulated: {
    queuedEvents: Array<{
      event: string;
      properties: Record<string, unknown>;
    }>;
  };
}

function createCollector(): TelemetryCollector {
  const collector = new TelemetryCollector(
    {
      enabled: true,
      endpoint: "https://example.test",
      debug: true,
    },
    "test-client-id",
    false,
  );
  collector.setRunId("run-123");
  return collector;
}

function getQueuedEvents(
  collector: TelemetryCollector,
): CollectorInternals["accumulated"]["queuedEvents"] {
  return (collector as unknown as CollectorInternals).accumulated.queuedEvents;
}

describe("TelemetryCollector lifecycle telemetry mapping", () => {
  test("rig.setup.completed is captured as rig_setup_completed telemetry event", () => {
    const collector = createCollector();
    const event: ServerEvent = {
      id: "evt-1",
      timestamp: new Date().toISOString(),
      type: "rig.setup.completed",
      data: {
        codonId: "codon-1",
        rigType: "commands",
        commandCount: 3,
        durationMs: 1250,
        createdCheckpoint: true,
      },
    };

    collector.handleEvent(event);

    const queued = getQueuedEvents(collector);
    expect(queued.length).toBe(1);
    expect(queued[0].event).toBe("rig_setup_completed");
    expect(queued[0].properties.rig_type).toBe("commands");
    expect(queued[0].properties.command_count).toBe(3);
    expect(queued[0].properties.duration_ms).toBe(1250);
    expect(queued[0].properties.created_checkpoint).toBe(true);
  });

  test("rig.setup.failed is captured as rig_setup_failed telemetry event", () => {
    const collector = createCollector();
    const event: ServerEvent = {
      id: "evt-2",
      timestamp: new Date().toISOString(),
      type: "rig.setup.failed",
      data: {
        codonId: "codon-2",
        failureType: "command_failed",
        exitCode: 127,
        commandIndex: 1,
        ignored: false,
      },
    };

    collector.handleEvent(event);

    const queued = getQueuedEvents(collector);
    expect(queued.length).toBe(1);
    expect(queued[0].event).toBe("rig_setup_failed");
    expect(queued[0].properties.failure_type).toBe("command_failed");
    expect(queued[0].properties.exit_code).toBe(127);
    expect(queued[0].properties.command_index).toBe(1);
    expect(queued[0].properties.ignored).toBe(false);
  });

  test("loop.iteration.completed emits loop_iteration_completed telemetry event", () => {
    const collector = createCollector();
    collector.setRunId("test-run-1");
    const event: ServerEvent = {
      id: "evt-3",
      timestamp: new Date().toISOString(),
      type: "loop.iteration.completed",
      data: {
        loopId: "loop-1",
        iteration: 2,
        durationMs: 4200,
        costUsd: 0.1234,
        tokensUsed: 987,
        isFinal: true,
        terminationReason: "iteration_limit",
      },
    };

    collector.handleEvent(event);

    const queued = getQueuedEvents(collector);
    expect(queued.length).toBe(1);
    expect(queued[0].event).toBe("loop_iteration_completed");
    expect(queued[0].properties.loop_id_hash).toBeDefined();
    expect(queued[0].properties.iteration).toBe(2);
    expect(queued[0].properties.duration_ms).toBe(4200);
    expect(queued[0].properties.cost_usd).toBe(0.1234);
    expect(queued[0].properties.tokens_used).toBe(987);
    expect(queued[0].properties.is_final).toBe(true);
    expect(queued[0].properties.termination_reason).toBe("iteration_limit");
  });
});

describe("TelemetryCollector budget telemetry", () => {
  test("reportBudgetSet queues per-codon budget_set event with limits", () => {
    const collector = createCollector();
    collector.reportBudgetSet({
      codonId: "codon-1",
      limits: {
        maxDollars: 5.0,
        maxTimeSeconds: 300,
        maxOutputTokens: 10000,
        maxContextTokens: 200000,
        onExceeded: "complete",
        costSource: "shared pool",
      },
    });

    const queued = getQueuedEvents(collector);
    expect(queued.length).toBe(1);
    expect(queued[0].event).toBe("budget_set");
    expect(queued[0].properties.codon_id_hash).toBeDefined();
    expect(queued[0].properties.has_max_dollars).toBe(true);
    expect(queued[0].properties.max_dollars).toBe(5.0);
    expect(queued[0].properties.has_max_time_seconds).toBe(true);
    expect(queued[0].properties.max_time_seconds).toBe(300);
    expect(queued[0].properties.has_max_output_tokens).toBe(true);
    expect(queued[0].properties.max_output_tokens).toBe(10000);
    expect(queued[0].properties.has_max_context_tokens).toBe(true);
    expect(queued[0].properties.max_context_tokens).toBe(200000);
    expect(queued[0].properties.on_exceeded).toBe("complete");
    expect(queued[0].properties.cost_source).toBe("shared pool");
    expect(queued[0].properties.run_id_hash).toBeDefined();
  });

  test("reportBudgetSet reflects null when no limits configured", () => {
    const collector = createCollector();
    collector.reportBudgetSet({
      codonId: "codon-2",
      limits: {},
    });

    const queued = getQueuedEvents(collector);
    expect(queued.length).toBe(1);
    expect(queued[0].properties.has_max_dollars).toBe(false);
    expect(queued[0].properties.max_dollars).toBeNull();
    expect(queued[0].properties.has_max_time_seconds).toBe(false);
    expect(queued[0].properties.max_time_seconds).toBeNull();
    expect(queued[0].properties.has_max_output_tokens).toBe(false);
    expect(queued[0].properties.max_output_tokens).toBeNull();
    expect(queued[0].properties.has_max_context_tokens).toBe(false);
    expect(queued[0].properties.max_context_tokens).toBeNull();
  });

  test("reportBudgetSet uses hashed codon ID", () => {
    const collector = createCollector();
    const rawId = "my-codon-id";
    collector.reportBudgetSet({
      codonId: rawId,
      limits: { maxDollars: 1.0 },
    });

    const queued = getQueuedEvents(collector);
    expect(queued[0].properties.codon_id_hash).not.toBe(rawId);
    expect(typeof queued[0].properties.codon_id_hash).toBe("string");
  });

  test("reportBudgetExceeded queues budget_exceeded event", () => {
    const collector = createCollector();
    collector.reportBudgetExceeded({
      codonId: "codon-budget-test",
      info: {
        currency: "cost",
        limit: 3.0,
        used: 3.5,
        message: "Cost exceeded",
      },
    });

    const queued = getQueuedEvents(collector);
    const budgetExceededEvents = queued.filter((e) => e.event === "budget_exceeded");
    expect(budgetExceededEvents.length).toBe(1);
    expect(budgetExceededEvents[0].properties.currency).toBe("cost");
    expect(budgetExceededEvents[0].properties.limit).toBe(3.0);
    expect(budgetExceededEvents[0].properties.used).toBe(3.5);
    expect(budgetExceededEvents[0].properties.run_id_hash).toBeDefined();
  });

  test("codon_completed includes budget limits when budget was set", () => {
    const collector = createCollector();
    // Set budget limits first
    collector.reportBudgetSet({
      codonId: "codon-budget-1",
      limits: {
        maxDollars: 5.0,
        maxTimeSeconds: 300,
        maxOutputTokens: 10000,
        onExceeded: "complete",
      },
    });

    // Emit codon.completed
    collector.handleEvent({
      id: "evt-bc-1",
      timestamp: new Date().toISOString(),
      type: "codon.completed",
      data: {
        codonId: "codon-budget-1",
        success: true,
        cost: 2.5,
        duration: 150000,
        exitStatus: { type: "success", code: 0 },
      },
    } as ServerEvent);

    const queued = getQueuedEvents(collector);
    const completed = queued.find((e) => e.event === "codon_completed");
    expect(completed).toBeDefined();
    expect(completed?.properties.budget_max_dollars).toBe(5.0);
    expect(completed?.properties.budget_max_time_seconds).toBe(300);
    expect(completed?.properties.budget_max_output_tokens).toBe(10000);
    expect(completed?.properties.budget_on_exceeded).toBe("complete");
    expect(completed?.properties.budget_exceeded).toBe(false);
    expect(completed?.properties.budget_exceeded_currency).toBeNull();
    expect(completed?.properties.budget_exceeded_limit).toBeNull();
    expect(completed?.properties.budget_exceeded_used).toBeNull();
  });

  test("codon_completed includes budget exceeded info when budget was exceeded", () => {
    const collector = createCollector();
    collector.reportBudgetSet({
      codonId: "codon-exceeded-1",
      limits: { maxDollars: 3.0, onExceeded: "complete" },
    });

    collector.handleEvent({
      id: "evt-bc-2",
      timestamp: new Date().toISOString(),
      type: "codon.completed",
      data: {
        codonId: "codon-exceeded-1",
        success: true,
        cost: 3.5,
        duration: 60000,
        exitStatus: { type: "success", code: 0 },
        budgetExceeded: { currency: "cost", limit: 3.0, used: 3.5 },
      },
    } as ServerEvent);

    const queued = getQueuedEvents(collector);
    const completed = queued.find((e) => e.event === "codon_completed");
    expect(completed).toBeDefined();
    expect(completed?.properties.budget_max_dollars).toBe(3.0);
    expect(completed?.properties.budget_exceeded).toBe(true);
    expect(completed?.properties.budget_exceeded_currency).toBe("cost");
    expect(completed?.properties.budget_exceeded_limit).toBe(3.0);
    expect(completed?.properties.budget_exceeded_used).toBe(3.5);
  });

  test("codon_completed has null budget fields when no budget was configured", () => {
    const collector = createCollector();

    collector.handleEvent({
      id: "evt-bc-3",
      timestamp: new Date().toISOString(),
      type: "codon.completed",
      data: {
        codonId: "codon-no-budget",
        success: true,
        cost: 1.0,
        duration: 30000,
        exitStatus: { type: "success", code: 0 },
      },
    } as ServerEvent);

    const queued = getQueuedEvents(collector);
    const completed = queued.find((e) => e.event === "codon_completed");
    expect(completed).toBeDefined();
    expect(completed?.properties.budget_max_dollars).toBeNull();
    expect(completed?.properties.budget_max_time_seconds).toBeNull();
    expect(completed?.properties.budget_max_output_tokens).toBeNull();
    expect(completed?.properties.budget_on_exceeded).toBeNull();
    expect(completed?.properties.budget_exceeded).toBe(false);
    expect(completed?.properties.budget_exceeded_currency).toBeNull();
  });

  test("reportBudgetExceeded uses hashed codon ID, not raw", () => {
    const collector = createCollector();
    const rawCodonId = "my-secret-codon-id";
    collector.reportBudgetExceeded({
      codonId: rawCodonId,
      info: {
        currency: "duration",
        limit: 30,
        used: 60,
        message: "Duration exceeded",
      },
    });

    const queued = getQueuedEvents(collector);
    const budgetExceededEvents = queued.filter((e) => e.event === "budget_exceeded");
    expect(budgetExceededEvents.length).toBe(1);
    expect(budgetExceededEvents[0].properties.codon_id_hash).not.toBe(rawCodonId);
    expect(typeof budgetExceededEvents[0].properties.codon_id_hash).toBe("string");
    expect((budgetExceededEvents[0].properties.codon_id_hash as string).length).toBeGreaterThan(0);
  });
});
