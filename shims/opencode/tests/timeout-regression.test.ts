import { describe, expect, test } from "bun:test";
import { withAdaptiveTimeout } from "@shims/common";
import { computeBusyTimeoutMs } from "../src/agent/opencode.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("adaptive timeout semantics", () => {
  test("does not false-timeout after step_start while busy", async () => {
    async function* sparseOpenCodeLikeStream() {
      yield { type: "step_start" } as const;
      await delay(80);
      yield { type: "step_finish" } as const;
    }

    const seen: string[] = [];
    for await (const event of withAdaptiveTimeout(sparseOpenCodeLikeStream(), {
      idleTimeoutMs: 20,
      busyTimeoutMs: 120,
      onEvent(event, controller) {
        if (event.type === "step_start") controller.markBusy();
        if (event.type === "step_finish") controller.markIdle();
      },
    })) {
      seen.push(event.type);
    }

    expect(seen).toEqual(["step_start", "step_finish"]);
  });

  test("streaming activity while busy resets the timer even for non-lifecycle events", async () => {
    async function* sparseStreamingStream() {
      yield { type: "step_start" } as const;
      await delay(60);
      yield { type: "reasoning" } as const;
      await delay(60);
      yield { type: "retry" } as const;
      await delay(60);
      yield { type: "step_finish" } as const;
    }

    const seen: string[] = [];
    for await (const event of withAdaptiveTimeout(sparseStreamingStream(), {
      idleTimeoutMs: 20,
      busyTimeoutMs: 90,
      onEvent(event, controller) {
        if (event.type === "step_start") controller.markBusy();
        if (event.type === "step_finish") controller.markIdle();
      },
    })) {
      seen.push(event.type);
    }

    expect(seen).toEqual(["step_start", "reasoning", "retry", "step_finish"]);
  });

  test("opencode busy timeout scales above baseline idle timeout", () => {
    expect(computeBusyTimeoutMs(1_000)).toBe(300_000);
    expect(computeBusyTimeoutMs(120_000)).toBe(600_000);
    expect(computeBusyTimeoutMs(300_000)).toBe(900_000);
    expect(computeBusyTimeoutMs(600_000)).toBe(900_000);
  });
});
