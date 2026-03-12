import { describe, expect, test } from "bun:test";
import { type BudgetExceededInfo, BudgetTracker } from "../../server/budget";
import { BudgetLimits } from "../../server/types/budget-types";

describe("BudgetTracker", () => {
  describe("cost budget", () => {
    test("emits exceeded when cost reaches limit", () => {
      const tracker = new BudgetTracker(new BudgetLimits({ maxDollars: 1.0 }));
      const events: BudgetExceededInfo[] = [];
      tracker.on("exceeded", (info) => events.push(info));

      tracker.addCost(0.6);
      expect(tracker.isExceeded()).toBe(false);
      expect(events).toHaveLength(0);

      tracker.addCost(0.5);
      expect(tracker.isExceeded()).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0].currency).toBe("cost");
      expect(events[0].limit).toBe(1.0);
      expect(events[0].used).toBeCloseTo(1.1, 5);
    });

    test("emits exceeded exactly once (idempotent)", () => {
      const tracker = new BudgetTracker(new BudgetLimits({ maxDollars: 1.0 }));
      const events: BudgetExceededInfo[] = [];
      tracker.on("exceeded", (info) => events.push(info));

      tracker.addCost(1.5);
      tracker.addCost(0.5);
      tracker.addCost(0.5);
      expect(events).toHaveLength(1);
    });

    test("addCost(0) is a no-op", () => {
      const tracker = new BudgetTracker(new BudgetLimits({ maxDollars: 0.01 }));
      const events: BudgetExceededInfo[] = [];
      tracker.on("exceeded", (info) => events.push(info));

      tracker.addCost(0);
      expect(tracker.isExceeded()).toBe(false);
      expect(events).toHaveLength(0);
    });

    test("negative delta is ignored", () => {
      const tracker = new BudgetTracker(new BudgetLimits({ maxDollars: 1.0 }));
      tracker.addCost(-5);
      expect(tracker.getState().costUsed).toBe(0);
    });

    test("getRemainingCost reflects consumption", () => {
      const tracker = new BudgetTracker(new BudgetLimits({ maxDollars: 5.0 }));
      expect(tracker.getRemainingCost()).toBe(5.0);

      tracker.addCost(2.0);
      expect(tracker.getRemainingCost()).toBe(3.0);

      tracker.addCost(4.0);
      expect(tracker.getRemainingCost()).toBe(0); // clamped to 0
    });

    test("getRemainingCost is undefined when no limit", () => {
      const tracker = new BudgetTracker(new BudgetLimits({}));
      expect(tracker.getRemainingCost()).toBeUndefined();
    });

    test("exact limit triggers exceeded", () => {
      const tracker = new BudgetTracker(new BudgetLimits({ maxDollars: 1.0 }));
      const events: BudgetExceededInfo[] = [];
      tracker.on("exceeded", (info) => events.push(info));

      tracker.addCost(1.0);
      expect(tracker.isExceeded()).toBe(true);
      expect(events).toHaveLength(1);
    });
  });

  describe("output token budget", () => {
    test("emits exceeded when tokens reach limit", () => {
      const tracker = new BudgetTracker(new BudgetLimits({ maxOutputTokens: 1000 }));
      const events: BudgetExceededInfo[] = [];
      tracker.on("exceeded", (info) => events.push(info));

      tracker.addOutputTokens(500);
      expect(tracker.isExceeded()).toBe(false);

      tracker.addOutputTokens(600);
      expect(tracker.isExceeded()).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0].currency).toBe("outputTokens");
      expect(events[0].limit).toBe(1000);
      expect(events[0].used).toBe(1100);
    });

    test("zero delta is ignored", () => {
      const tracker = new BudgetTracker(new BudgetLimits({ maxOutputTokens: 10 }));
      tracker.addOutputTokens(0);
      expect(tracker.isExceeded()).toBe(false);
    });

    test("negative delta is ignored", () => {
      const tracker = new BudgetTracker(new BudgetLimits({ maxOutputTokens: 100 }));
      tracker.addOutputTokens(-50);
      expect(tracker.getState().outputTokensUsed).toBe(0);
    });

    test("exact limit triggers exceeded", () => {
      const tracker = new BudgetTracker(new BudgetLimits({ maxOutputTokens: 500 }));
      const events: BudgetExceededInfo[] = [];
      tracker.on("exceeded", (info) => events.push(info));

      tracker.addOutputTokens(500);
      expect(tracker.isExceeded()).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0].currency).toBe("outputTokens");
      expect(events[0].used).toBe(500);
    });
  });

  describe("context tokens budget", () => {
    test("exceeds when high-water mark reaches limit", () => {
      const tracker = new BudgetTracker(new BudgetLimits({ maxContextTokens: 100000 }));
      const events: BudgetExceededInfo[] = [];
      tracker.on("exceeded", (info) => events.push(info));

      tracker.updateContextTokens(50000, 10000);
      expect(tracker.isExceeded()).toBe(false);

      tracker.updateContextTokens(90000, 15000);
      expect(tracker.isExceeded()).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0].currency).toBe("contextTokens");
      expect(events[0].limit).toBe(100000);
      expect(events[0].used).toBe(105000);
    });

    test("tracks high-water mark, not sum", () => {
      const tracker = new BudgetTracker(new BudgetLimits({ maxContextTokens: 100000 }));
      tracker.updateContextTokens(80000, 5000);
      tracker.updateContextTokens(60000, 3000);
      expect(tracker.getState().contextTokensHighWaterMark).toBe(85000);
    });

    test("no-op when no limit set", () => {
      const tracker = new BudgetTracker(new BudgetLimits({ maxDollars: 1.0 }));
      tracker.updateContextTokens(500000, 50000);
      expect(tracker.isExceeded()).toBe(false);
    });

    test("hasLimits returns true with context token limit", () => {
      expect(new BudgetTracker(new BudgetLimits({ maxContextTokens: 50000 })).hasLimits()).toBe(
        true,
      );
    });
  });

  describe("duration budget", () => {
    test("does not exceed when within limit", () => {
      const tracker = new BudgetTracker(new BudgetLimits({ maxTimeSeconds: 60 }));
      tracker.checkTime();
      expect(tracker.isExceeded()).toBe(false);
    });

    test("skips check when no duration limit", () => {
      const tracker = new BudgetTracker(new BudgetLimits({ maxDollars: 1.0 }));
      tracker.checkTime(); // should not throw or emit
      expect(tracker.isExceeded()).toBe(false);
    });

    test("zero-second limit triggers exceeded on first checkTime", () => {
      const tracker = new BudgetTracker(new BudgetLimits({ maxTimeSeconds: 0 }));
      const events: BudgetExceededInfo[] = [];
      tracker.on("exceeded", (info) => events.push(info));

      tracker.checkTime();
      expect(tracker.isExceeded()).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0].currency).toBe("duration");
      expect(events[0].limit).toBe(0);
    });
  });

  describe("no limits", () => {
    test("hasLimits returns false when empty", () => {
      const tracker = new BudgetTracker(new BudgetLimits({}));
      expect(tracker.hasLimits()).toBe(false);
    });

    test("hasLimits returns true with any limit", () => {
      expect(new BudgetTracker(new BudgetLimits({ maxDollars: 1 })).hasLimits()).toBe(true);
      expect(new BudgetTracker(new BudgetLimits({ maxTimeSeconds: 60 })).hasLimits()).toBe(true);
      expect(new BudgetTracker(new BudgetLimits({ maxOutputTokens: 500 })).hasLimits()).toBe(true);
    });

    test("never exceeds without limits", () => {
      const tracker = new BudgetTracker(new BudgetLimits({}));
      tracker.addCost(1000);
      tracker.addOutputTokens(1000000);
      tracker.checkTime();
      expect(tracker.isExceeded()).toBe(false);
    });
  });

  describe("multi-currency", () => {
    test("first exceeded currency wins", () => {
      const tracker = new BudgetTracker(
        new BudgetLimits({
          maxDollars: 10,
          maxOutputTokens: 100,
        }),
      );
      const events: BudgetExceededInfo[] = [];
      tracker.on("exceeded", (info) => events.push(info));

      tracker.addOutputTokens(150); // tokens exceed first
      tracker.addCost(15); // cost would also exceed, but already exceeded

      expect(events).toHaveLength(1);
      expect(events[0].currency).toBe("outputTokens");
    });
  });

  describe("getState", () => {
    test("reports accumulated values", () => {
      const tracker = new BudgetTracker(new BudgetLimits({ maxDollars: 10 }));
      tracker.addCost(2.5);
      tracker.addOutputTokens(300);

      const state = tracker.getState();
      expect(state.costUsed).toBeCloseTo(2.5, 5);
      expect(state.outputTokensUsed).toBe(300);
      expect(state.elapsedSeconds).toBeGreaterThanOrEqual(0);
    });
  });

  describe("getExceededInfo", () => {
    test("returns undefined when not exceeded", () => {
      const tracker = new BudgetTracker(new BudgetLimits({ maxDollars: 10 }));
      expect(tracker.getExceededInfo()).toBeUndefined();
    });

    test("returns info when exceeded", () => {
      const tracker = new BudgetTracker(new BudgetLimits({ maxDollars: 1.0 }));
      tracker.addCost(1.5);
      const info = tracker.getExceededInfo();
      expect(info).toBeDefined();
      expect(info?.currency).toBe("cost");
      expect(info?.limit).toBe(1.0);
      expect(info?.used).toBe(1.5);
      expect(info?.message).toContain("exceeded");
    });
  });
});
