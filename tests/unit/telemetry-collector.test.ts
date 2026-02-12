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
  test("rig.setup.completed is silently ignored (removed in telemetry simplification)", () => {
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
    expect(queued.length).toBe(0);
  });

  test("rig.setup.failed is silently ignored (removed in telemetry simplification)", () => {
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
    expect(queued.length).toBe(0);
  });

  test("loop.iteration.completed is silently ignored (removed in telemetry simplification)", () => {
    const collector = createCollector();
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
    expect(queued.length).toBe(0);
  });
});
