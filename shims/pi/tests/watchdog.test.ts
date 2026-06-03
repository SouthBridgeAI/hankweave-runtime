import { describe, expect, test } from "bun:test";
import { BusyStepTimeoutError, withAdaptiveTimeout } from "@shims/common";
import { applyPiWatchdogEvent, isPiWatchdogActivityEvent } from "../src/pi-agent.js";

type WatchdogEvent = {
  type:
    | "agent_start"
    | "turn_start"
    | "message_start"
    | "message_update"
    | "message_end"
    | "tool_execution_start"
    | "tool_execution_update"
    | "tool_execution_end"
    | "turn_end"
    | "agent_end"
    | "auto_retry_start"
    | "auto_retry_end"
    | "compaction_start"
    | "compaction_end";
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Pi watchdog activity detection", () => {
  test("treats lifecycle and streaming events as timeout-resetting activity", () => {
    const activityEvents: WatchdogEvent["type"][] = [
      "agent_start",
      "turn_start",
      "message_start",
      "message_update",
      "message_end",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
      "turn_end",
      "agent_end",
      "auto_retry_start",
      "auto_retry_end",
      "compaction_start",
      "compaction_end",
    ];

    for (const type of activityEvents) {
      expect(isPiWatchdogActivityEvent({ type } as WatchdogEvent)).toBe(true);
    }
  });
});

describe("Pi watchdog adaptive timeout semantics", () => {
  test("treats a quiet in-progress turn as busy rather than idle", async () => {
    async function* sparseTurn() {
      yield { type: "turn_start" } as const;
      await delay(60);
      yield { type: "turn_end" } as const;
    }

    const seen: WatchdogEvent["type"][] = [];

    for await (const event of withAdaptiveTimeout(sparseTurn(), {
      idleTimeoutMs: 20,
      busyTimeoutMs: 100,
      onEvent(event, controller) {
        applyPiWatchdogEvent(event, controller);
      },
    })) {
      seen.push(event.type);
    }

    expect(seen).toEqual(["turn_start", "turn_end"]);
  });

  test("does not revert to idle immediately after tool_execution_end inside an active turn", async () => {
    async function* quietAfterTool() {
      yield { type: "turn_start" } as const;
      yield { type: "tool_execution_start" } as const;
      yield { type: "tool_execution_end" } as const;
      await delay(60);
      yield { type: "turn_end" } as const;
    }

    const seen: WatchdogEvent["type"][] = [];

    for await (const event of withAdaptiveTimeout(quietAfterTool(), {
      idleTimeoutMs: 20,
      busyTimeoutMs: 100,
      onEvent(event, controller) {
        applyPiWatchdogEvent(event, controller);
      },
    })) {
      seen.push(event.type);
    }

    expect(seen).toEqual([
      "turn_start",
      "tool_execution_start",
      "tool_execution_end",
      "turn_end",
    ]);
  });

  test("reports BusyStepTimeoutError for a stalled started turn", async () => {
    async function* stalledTurn() {
      yield { type: "turn_start" } as const;
      await new Promise(() => {});
    }

    const seen: WatchdogEvent["type"][] = [];

    try {
      for await (const event of withAdaptiveTimeout(stalledTurn(), {
        idleTimeoutMs: 20,
        busyTimeoutMs: 50,
        onEvent(event, controller) {
          applyPiWatchdogEvent(event, controller);
        },
      })) {
        seen.push(event.type);
      }
      throw new Error("Expected busy-step timeout");
    } catch (error) {
      expect(error).toBeInstanceOf(BusyStepTimeoutError);
      expect((error as BusyStepTimeoutError).timeoutMs).toBe(50);
    }

    expect(seen).toEqual(["turn_start"]);
  });
});
