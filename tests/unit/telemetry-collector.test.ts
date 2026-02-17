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
