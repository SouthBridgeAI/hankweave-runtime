import { describe, expect, test } from "bun:test";
import { withAdaptiveTimeout } from "@shims/common/timeout";
import {
  shouldTreatTurnStartAsBusy,
  updateCodexTimeoutState,
} from "../src/timeout-state.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("adaptive timeout strategy", () => {
  test("treats normal turn starts as busy work", () => {
    expect(shouldTreatTurnStartAsBusy(2_000)).toBe(true);
    expect(shouldTreatTurnStartAsBusy(1_000)).toBe(false);
  });

  test("does not false-timeout while a turn is quietly in progress", async () => {
    async function* events() {
      yield {
        type: "turn.started",
      } as const;
      await delay(80);
      yield {
        type: "item.completed",
        item: {
          id: "item_turn_1",
          type: "agent_message",
          text: "done",
        },
      } as const;
      yield {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0,
        },
      } as const;
    }

    const seen: string[] = [];
    for await (const event of withAdaptiveTimeout(events(), {
      idleTimeoutMs: 20,
      busyTimeoutMs: 120,
      onEvent(event, controller) {
        updateCodexTimeoutState(event, controller, 2_000);
      },
    })) {
      seen.push(event.type);
    }

    expect(seen).toEqual(["turn.started", "item.completed", "turn.completed"]);
  });

  test("does not false-timeout while a tool is clearly running", async () => {
    async function* events() {
      yield {
        type: "item.started",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "sleep 1 && echo done",
          aggregated_output: "",
          status: "in_progress",
        },
      } as const;
      await delay(80);
      yield {
        type: "item.completed",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "sleep 1 && echo done",
          aggregated_output: "done\n",
          exit_code: 0,
          status: "completed",
        },
      } as const;
    }

    const seen: string[] = [];
    for await (const event of withAdaptiveTimeout(events(), {
      idleTimeoutMs: 20,
      busyTimeoutMs: 120,
      onEvent(event, controller) {
        updateCodexTimeoutState(event, controller, 20);
      },
    })) {
      seen.push(event.type);
    }

    expect(seen).toEqual(["item.started", "item.completed"]);
  });
});
