import { describe, test, expect } from "bun:test";
import {
  BusyStepTimeoutError,
  IdleTimeoutError,
  withAdaptiveTimeout,
  withIdleTimeout,
} from "../src/timeout.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("withIdleTimeout", () => {
  test("yields all events from a fast iterator", async () => {
    async function* fastEvents() {
      yield "a";
      yield "b";
      yield "c";
    }

    const results: string[] = [];
    for await (const event of withIdleTimeout(fastEvents(), 1000)) {
      results.push(event);
    }

    expect(results).toEqual(["a", "b", "c"]);
  });

  test("throws IdleTimeoutError on slow iterator", async () => {
    async function* slowEvents() {
      yield "first";
      // Then hang forever
      await new Promise(() => {});
    }

    const results: string[] = [];
    try {
      for await (const event of withIdleTimeout(slowEvents(), 50)) {
        results.push(event);
      }
      throw new Error("Should not reach here");
    } catch (err) {
      expect(err).toBeInstanceOf(IdleTimeoutError);
      expect((err as IdleTimeoutError).timeoutMs).toBe(50);
      expect((err as IdleTimeoutError).message).toContain("50ms");
    }

    expect(results).toEqual(["first"]);
  });

  test("resets timer between events", async () => {
    async function* slowButSteadyEvents() {
      yield 1;
      await delay(20);
      yield 2;
      await delay(20);
      yield 3;
    }

    const results: number[] = [];
    // Timeout of 50ms is longer than the 20ms gaps, so all events should arrive
    for await (const event of withIdleTimeout(slowButSteadyEvents(), 50)) {
      results.push(event);
    }

    expect(results).toEqual([1, 2, 3]);
  });

  test("calls iterator.return() on timeout", async () => {
    let returnCalled = false;
    let nextCallCount = 0;

    const fakeIterable: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            nextCallCount++;
            if (nextCallCount === 1) {
              return Promise.resolve({ value: "first" as string, done: false as const });
            }
            return new Promise(() => {}); // hang on second call
          },
          return() {
            returnCalled = true;
            return Promise.resolve({ value: undefined, done: true as const });
          },
        };
      },
    };

    try {
      for await (const _event of withIdleTimeout(fakeIterable, 50)) {
        // consume first event, then it will hang and timeout
      }
    } catch {
      // expected timeout
    }

    // return() is called fire-and-forget, give microtask a chance to run
    await delay(10);
    expect(returnCalled).toBe(true);
  });

  test("handles empty iterator", async () => {
    async function* emptyEvents() {
      // yields nothing
    }

    const results: string[] = [];
    for await (const event of withIdleTimeout(emptyEvents(), 50)) {
      results.push(event);
    }

    expect(results).toEqual([]);
  });
});

describe("IdleTimeoutError", () => {
  test("has correct name and properties", () => {
    const err = new IdleTimeoutError(5000);
    expect(err.name).toBe("IdleTimeoutError");
    expect(err.timeoutMs).toBe(5000);
    expect(err.message).toBe("Idle timeout: no events received for 5000ms");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("withAdaptiveTimeout", () => {
  test("uses busy timeout after controller marks busy", async () => {
    type Event = { type: "step_start" | "result" };

    async function* busyButQuiet() {
      yield { type: "step_start" } as const;
      await delay(80);
      yield { type: "result" } as const;
    }

    const results: Event[] = [];

    for await (const event of withAdaptiveTimeout(busyButQuiet(), {
      idleTimeoutMs: 20,
      busyTimeoutMs: 120,
      onEvent(event, controller) {
        if (event.type === "step_start") {
          controller.markBusy();
        } else {
          controller.markIdle();
        }
      },
    })) {
      results.push(event);
    }

    expect(results).toEqual([{ type: "step_start" }, { type: "result" }]);
  });

  test("throws BusyStepTimeoutError when a busy step stalls", async () => {
    async function* stalledBusy() {
      yield { type: "step_start" } as const;
      await new Promise(() => {});
    }

    const results: string[] = [];

    try {
      for await (const event of withAdaptiveTimeout(stalledBusy(), {
        idleTimeoutMs: 20,
        busyTimeoutMs: 50,
        onEvent(event, controller) {
          if (event.type === "step_start") {
            controller.markBusy();
          }
        },
      })) {
        results.push(event.type);
      }
      throw new Error("Should not reach here");
    } catch (err) {
      expect(err).toBeInstanceOf(BusyStepTimeoutError);
      expect((err as BusyStepTimeoutError).timeoutMs).toBe(50);
      expect((err as BusyStepTimeoutError).message).toContain("50ms");
    }

    expect(results).toEqual(["step_start"]);
  });
});
