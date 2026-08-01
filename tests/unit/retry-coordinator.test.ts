/**
 * RetryCoordinator — failure policy plus retry bookkeeping. These tests pin
 * the behaviour the runtime's decision sites depend on.
 */

import { describe, expect, test } from "bun:test";
import { RetryCoordinator } from "../../server/retry-coordinator.js";
import type { Codon, FailureReason } from "../../server/types/types.js";

function makeCodon(overrides: Partial<Codon> = {}): Codon {
  return { id: "analyze", name: "Analyze", prompt: "do the thing", ...overrides } as Codon;
}

const retriable: FailureReason = { type: "rate-limit", retriable: true };
const permanent: FailureReason = { type: "api-error", retriable: false };

describe("RetryCoordinator", () => {
  describe("onFailure: abort (the default)", () => {
    test("a retriable failure parks the server rather than retrying", () => {
      const c = new RetryCoordinator();
      expect(c.decide("analyze", makeCodon(), retriable).action).toBe("stay-active");
    });

    test("a permanent failure shuts the run down", () => {
      const c = new RetryCoordinator();
      expect(c.decide("analyze", makeCodon(), permanent).action).toBe("shutdown");
    });

    test("an unset onFailure behaves as abort", () => {
      const c = new RetryCoordinator();
      const explicit = new RetryCoordinator();
      expect(c.decide("analyze", makeCodon(), retriable).action).toBe(
        explicit.decide("analyze", makeCodon({ onFailure: "abort" }), retriable).action,
      );
    });

    test("a missing failure reason is treated as non-retriable", () => {
      const c = new RetryCoordinator();
      expect(c.decide("analyze", makeCodon(), undefined).action).toBe("shutdown");
    });
  });

  describe("onFailure: ignore", () => {
    test("continues regardless of retriability", () => {
      const c = new RetryCoordinator();
      const codon = makeCodon({ onFailure: "ignore" });
      expect(c.decide("analyze", codon, retriable).action).toBe("continue");
      expect(c.decide("analyze", codon, permanent).action).toBe("continue");
    });
  });

  describe("onFailure: retry", () => {
    const codon = makeCodon({
      onFailure: "retry",
      retryConfig: { maxAttempts: 3, delayMs: 1000 },
    } as Partial<Codon>);

    test("a permanent failure shuts down without consuming attempts", () => {
      const c = new RetryCoordinator();
      expect(c.decide("analyze", codon, permanent).action).toBe("shutdown");
      expect(c.getAttempts("analyze")).toBe(0);
    });

    test("a retriable failure retries and reports 1-based attempt numbering", () => {
      const c = new RetryCoordinator();
      const decision = c.decide("analyze", codon, retriable);
      expect(decision.action).toBe("retry");
      if (decision.action !== "retry") return;
      expect(decision.attempt).toBe(1);
      expect(decision.maxAttempts).toBe(3);
    });

    test("delays back off exponentially across recorded attempts", () => {
      const c = new RetryCoordinator();
      const delays: number[] = [];
      for (let i = 0; i < 3; i++) {
        const d = c.decide("analyze", codon, retriable);
        if (d.action !== "retry") break;
        delays.push(d.delayBeforeThisAttemptMs);
        c.recordAttempt("analyze");
      }
      expect(delays).toEqual([1000, 2000, 4000]);
    });

    test("the budget is exhausted after maxAttempts recorded retries", () => {
      const c = new RetryCoordinator();
      for (let i = 0; i < 3; i++) c.recordAttempt("analyze");
      expect(c.decide("analyze", codon, retriable).action).toBe("shutdown");
    });

    test("a provider Retry-After overrides the computed backoff", () => {
      const c = new RetryCoordinator();
      const decision = c.decide("analyze", codon, {
        type: "rate-limit",
        retriable: true,
        retryAfterMs: 15_000,
      });
      if (decision.action !== "retry") throw new Error("expected retry");
      expect(decision.delayBeforeThisAttemptMs).toBe(15_000);
    });

    test("maxDelayMs caps the backoff", () => {
      const capped = makeCodon({
        onFailure: "retry",
        retryConfig: { maxAttempts: 10, delayMs: 1000, maxDelayMs: 3000 },
      } as Partial<Codon>);
      const c = new RetryCoordinator();
      for (let i = 0; i < 5; i++) c.recordAttempt("analyze");
      const decision = c.decide("analyze", capped, retriable);
      if (decision.action !== "retry") throw new Error("expected retry");
      expect(decision.delayBeforeThisAttemptMs).toBe(3000);
    });

    test("an absent retryConfig uses the documented defaults", () => {
      const bare = makeCodon({ onFailure: "retry" });
      const c = new RetryCoordinator();
      const decision = c.decide("analyze", bare, retriable);
      if (decision.action !== "retry") throw new Error("expected retry");
      expect(decision.maxAttempts).toBe(3);
      expect(decision.delayBeforeThisAttemptMs).toBe(1000);
    });
  });

  describe("bookkeeping", () => {
    const codon = makeCodon({
      onFailure: "retry",
      retryConfig: { maxAttempts: 2, delayMs: 1000 },
    } as Partial<Codon>);

    test("decide does not consume an attempt on its own", () => {
      // The runtime can abandon a decision (shutdown during the delay); only an
      // explicit recordAttempt spends budget.
      const c = new RetryCoordinator();
      c.decide("analyze", codon, retriable);
      c.decide("analyze", codon, retriable);
      c.decide("analyze", codon, retriable);
      expect(c.getAttempts("analyze")).toBe(0);
    });

    test("attempts are tracked per codon", () => {
      const c = new RetryCoordinator();
      c.recordAttempt("analyze");
      c.recordAttempt("analyze");
      expect(c.getAttempts("analyze")).toBe(2);
      expect(c.getAttempts("emit")).toBe(0);
      // 'analyze' is spent; 'emit' still has its full budget.
      expect(c.decide("analyze", codon, retriable).action).toBe("shutdown");
      expect(c.decide("emit", codon, retriable).action).toBe("retry");
    });

    test("reset restores a full budget", () => {
      const c = new RetryCoordinator();
      c.recordAttempt("analyze");
      c.recordAttempt("analyze");
      expect(c.decide("analyze", codon, retriable).action).toBe("shutdown");
      c.reset("analyze");
      expect(c.getAttempts("analyze")).toBe(0);
      expect(c.decide("analyze", codon, retriable).action).toBe("retry");
    });

    test("resetting an unknown codon is a no-op", () => {
      const c = new RetryCoordinator();
      expect(() => c.reset("never-seen")).not.toThrow();
      expect(c.getAttempts("never-seen")).toBe(0);
    });
  });

  describe("logging", () => {
    test("every decision narrates the policy being applied", () => {
      const lines: string[] = [];
      const c = new RetryCoordinator((m) => lines.push(m));
      c.decide("analyze", makeCodon({ onFailure: "retry" }), retriable);
      expect(lines.some((l) => l.includes("onFailure=retry") && l.includes("retriable=true"))).toBe(
        true,
      );
    });

    test("exhausting the retry budget is called out", () => {
      const lines: string[] = [];
      const c = new RetryCoordinator((m) => lines.push(m));
      const codon = makeCodon({
        onFailure: "retry",
        retryConfig: { maxAttempts: 1, delayMs: 1 },
      } as Partial<Codon>);
      c.recordAttempt("analyze");
      c.decide("analyze", codon, retriable);
      expect(lines.some((l) => l.includes("exhausted 1 retry attempts"))).toBe(true);
    });

    test("a non-retriable error under onFailure=retry explains the fallback", () => {
      const lines: string[] = [];
      const c = new RetryCoordinator((m) => lines.push(m));
      c.decide("analyze", makeCodon({ onFailure: "retry" }), permanent);
      expect(lines.some((l) => l.includes("not retriable") && l.includes("falling back"))).toBe(
        true,
      );
    });

    test("an ignored failure is called out", () => {
      const lines: string[] = [];
      const c = new RetryCoordinator((m) => lines.push(m));
      c.decide("analyze", makeCodon({ onFailure: "ignore" }), permanent);
      expect(lines.some((l) => l.includes("onFailure: 'ignore'"))).toBe(true);
    });

    test("the default logger is a no-op", () => {
      const c = new RetryCoordinator();
      expect(() => c.decide("analyze", makeCodon(), retriable)).not.toThrow();
    });
  });
});
