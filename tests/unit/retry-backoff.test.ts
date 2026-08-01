/**
 * Retry pacing: exponential backoff and provider-supplied Retry-After. With a
 * flat delay, a rate limit that needs seconds to clear burns every retry
 * attempt within a few seconds and fails the run regardless.
 */

import { describe, expect, test } from "bun:test";
import {
  classifyApiErrorText,
  computeRetryDelayMs,
  MAX_RETRY_DELAY_MS,
  parseRetryAfterMs,
} from "../../server/error-classification.js";

describe("parseRetryAfterMs", () => {
  describe("header / JSON forms (bare value is seconds, per RFC 9110)", () => {
    const cases: Array<{ name: string; text: string; expected: number }> = [
      { name: "http header", text: "retry-after: 30", expected: 30_000 },
      { name: "underscore key", text: '{"retry_after": 12}', expected: 12_000 },
      { name: "camelCase key", text: "retryAfter: 5", expected: 5_000 },
      { name: "spaced words", text: "retry after 60", expected: 60_000 },
      { name: "quoted value", text: '"retry-after": "45"', expected: 45_000 },
      { name: "fractional seconds", text: "retry-after: 1.5", expected: 1_500 },
    ];
    for (const c of cases) {
      test(c.name, () => {
        expect(parseRetryAfterMs(c.text)).toBe(c.expected);
      });
    }
  });

  describe("key-suffixed millisecond forms (unit lives in the key, before the value)", () => {
    const cases: Array<{ name: string; text: string; expected: number }> = [
      { name: "http header", text: "Retry-After-Ms: 30000", expected: 30_000 },
      { name: "underscore key", text: "retry_after_ms: 30000", expected: 30_000 },
      { name: "quoted JSON key", text: '"retry_after_ms": 30000', expected: 30_000 },
      { name: "camelCase key", text: "retryAfterMs: 30000", expected: 30_000 },
    ];
    for (const c of cases) {
      test(c.name, () => {
        expect(parseRetryAfterMs(c.text)).toBe(c.expected);
      });
    }
  });

  describe("explicit units win over the bare-seconds reading", () => {
    test("milliseconds are not read as seconds", () => {
      // The bare-value pattern would otherwise make this 500 SECONDS.
      expect(parseRetryAfterMs("retry-after 500ms")).toBe(500);
    });

    test("seconds suffix", () => {
      expect(parseRetryAfterMs("retry after 30s")).toBe(30_000);
    });

    test("spelled-out seconds", () => {
      expect(parseRetryAfterMs("Please retry after 90 seconds")).toBe(90_000);
    });

    test("minutes suffix", () => {
      expect(parseRetryAfterMs("retry-after 2 minutes")).toBe(120_000);
    });

    test("spelled-out milliseconds are not read as bare seconds", () => {
      // If only the "ms" suffix were recognized, the bare fallback would
      // capture 500 and schedule 500 SECONDS (capped to a minute).
      expect(parseRetryAfterMs("retry after 500 milliseconds")).toBe(500);
    });

    test("singular spelled-out millisecond", () => {
      expect(parseRetryAfterMs("retry-after: 1 millisecond")).toBe(1);
    });
  });

  describe("bare values must terminate without a unit", () => {
    test("an untranslated unit yields no hint, not bogus seconds", () => {
      // 2 hours: reading the 2 as seconds would be wildly wrong, and clamping
      // "2 hours" to a minute would misreport the provider. Fall back.
      expect(parseRetryAfterMs("retry after 2 hours")).toBeUndefined();
    });

    test("a suffixed unknown unit yields no hint", () => {
      expect(parseRetryAfterMs("retry-after: 30h")).toBeUndefined();
    });

    test("a trailing word disqualifies the bare reading", () => {
      expect(parseRetryAfterMs("retry after 30 requests")).toBeUndefined();
    });

    test("a next header line does not disqualify a bare value", () => {
      // Multi-line header dumps put a word (the next header name) after the
      // value — on a NEW line. Only same-line words disqualify.
      expect(parseRetryAfterMs("retry-after: 30\nx-request-id: abc")).toBe(30_000);
    });
  });

  describe("hostile inputs: digits embedded in larger tokens must not parse", () => {
    // Each of these previously (or would plausibly) misparse its LEADING digit
    // group as delay-seconds — e.g. "1,000" as a 1s wait against a 1000s ask.
    // A missing hint falls back to backoff; a wrong hint silently mispaces.
    const noneCases: Array<{ name: string; text: string }> = [
      { name: "thousands-separated bare value", text: "retry-after: 1,000" },
      { name: "thousands-separated value with unit", text: "retry after 1,000 seconds" },
      { name: "thousands-separated ms-key value", text: "retry_after_ms: 1,500" },
      { name: "clock time", text: "please retry after 07:30 UTC" },
      { name: "hyphenated date", text: "retry after 2026-07-30" },
      { name: "slashed date", text: "retry after 07/30/2026" },
      { name: "phone number", text: "retry after 1-800-555-0100 for support" },
      { name: "HTTP-date Retry-After", text: "retry-after: Fri, 31 Dec 1999 23:59:59 GMT" },
      { name: "hex value", text: "retry-after: 0x1f" },
      { name: "scientific notation", text: "retry after 1e9 seconds" },
      { name: "version string", text: "retry after upgrading to v2.5.1" },
      { name: "unknown word unit (months)", text: "retry after 30 months" },
      { name: "unknown word unit (days)", text: "retry after 2 days" },
      { name: "sub-ms word unit", text: "retry after 500 microseconds" },
      // The unit lives in a DIFFERENT key that merely contains "retry-after-ms".
      { name: "foreign key containing the ms key", text: "x-retry-after-ms-remaining: 500" },
      // The number is the duration OF the failure, not a wait instruction:
      // "retry" appears after the digits, and no retry-after key precedes them.
      {
        name: "elapsed duration in prose",
        text: "Request timed out after 400 seconds, please retry",
      },
    ];
    for (const c of noneCases) {
      test(c.name, () => {
        expect(parseRetryAfterMs(c.text)).toBeUndefined();
      });
    }

    test("a JSON separator comma after the value does not reject it", () => {
      // The larger-token guard rejects ",<digit>" specifically; a plain
      // field-separating comma keeps the bare-seconds reading.
      expect(parseRetryAfterMs('{"retry_after": 30, "code": 429}')).toBe(30_000);
    });
  });

  describe("worded provider phrasings", () => {
    test("try again in Ns", () => {
      expect(parseRetryAfterMs("Rate limited. Please try again in 20s")).toBe(20_000);
    });

    test("wait N milliseconds", () => {
      expect(parseRetryAfterMs("wait 250ms before retrying")).toBe(250);
    });

    test("try again in N minutes", () => {
      expect(parseRetryAfterMs("Too many requests, try again in 3 minutes")).toBe(180_000);
    });
  });

  describe("no hint present", () => {
    const noneCases = [
      "",
      "Internal server error",
      // The real OpenRouter/Poolside 429 that motivated this work says "retry
      // shortly" with no number — it must yield no hint, not a bogus one.
      '429: {"message":"Provider returned error","code":429,"metadata":{"raw":"poolside/laguna-s-2.1 is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits","provider_name":"Poolside","is_byok":false}}',
    ];
    for (const text of noneCases) {
      test(`no hint: ${text.slice(0, 40) || "(empty)"}`, () => {
        expect(parseRetryAfterMs(text)).toBeUndefined();
      });
    }

    test("non-string input is tolerated", () => {
      expect(parseRetryAfterMs(undefined as unknown as string)).toBeUndefined();
    });
  });

  describe("implausible values are discarded, not clamped", () => {
    test("a multi-hour wait yields no hint", () => {
      // Clamping to a minute would misreport the provider's answer; falling
      // back to backoff is the honest behaviour.
      expect(parseRetryAfterMs("retry-after: 86400")).toBeUndefined();
    });

    test("zero is a legitimate 'retry immediately'", () => {
      expect(parseRetryAfterMs("retry-after: 0")).toBe(0);
    });
  });
});

describe("computeRetryDelayMs", () => {
  describe("exponential backoff", () => {
    test("doubles per attempt from the base delay", () => {
      const base = 1000;
      expect(computeRetryDelayMs({ baseDelayMs: base, attempts: 0 })).toBe(1000);
      expect(computeRetryDelayMs({ baseDelayMs: base, attempts: 1 })).toBe(2000);
      expect(computeRetryDelayMs({ baseDelayMs: base, attempts: 2 })).toBe(4000);
      expect(computeRetryDelayMs({ baseDelayMs: base, attempts: 3 })).toBe(8000);
    });

    test("the default 3-attempt budget now spans 7s, not 3s", () => {
      // This is the whole point: the old flat delay gave a rate limit three
      // chances inside three seconds.
      const base = 1000;
      const total = [0, 1, 2].reduce(
        (sum, attempts) => sum + computeRetryDelayMs({ baseDelayMs: base, attempts }),
        0,
      );
      expect(total).toBe(7000);
    });

    test("growth is capped at maxDelayMs", () => {
      expect(computeRetryDelayMs({ baseDelayMs: 1000, attempts: 20, maxDelayMs: 30_000 })).toBe(
        30_000,
      );
    });

    test("the cap defaults to MAX_RETRY_DELAY_MS", () => {
      expect(computeRetryDelayMs({ baseDelayMs: 1000, attempts: 20 })).toBe(MAX_RETRY_DELAY_MS);
    });

    test("a huge attempts value cannot overflow to Infinity", () => {
      const delay = computeRetryDelayMs({ baseDelayMs: 1000, attempts: 10_000 });
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBe(MAX_RETRY_DELAY_MS);
    });

    test("a zero base delay stays zero", () => {
      expect(computeRetryDelayMs({ baseDelayMs: 0, attempts: 5 })).toBe(0);
    });
  });

  describe("provider Retry-After takes precedence", () => {
    test("the hint is used instead of computed backoff", () => {
      expect(computeRetryDelayMs({ baseDelayMs: 1000, attempts: 0, retryAfterMs: 30_000 })).toBe(
        30_000,
      );
    });

    test("the hint wins even when backoff would be longer", () => {
      // Provider says 2s; backoff would say 16s. Trust the provider.
      expect(computeRetryDelayMs({ baseDelayMs: 1000, attempts: 4, retryAfterMs: 2000 })).toBe(
        2000,
      );
    });

    test("the hint is still capped by maxDelayMs", () => {
      expect(
        computeRetryDelayMs({
          baseDelayMs: 1000,
          attempts: 0,
          retryAfterMs: 500_000,
          maxDelayMs: 60_000,
        }),
      ).toBe(60_000);
    });

    test("a zero hint means retry immediately", () => {
      expect(computeRetryDelayMs({ baseDelayMs: 1000, attempts: 3, retryAfterMs: 0 })).toBe(0);
    });

    test("a non-finite hint falls back to backoff", () => {
      expect(
        computeRetryDelayMs({
          baseDelayMs: 1000,
          attempts: 1,
          retryAfterMs: Number.NaN,
        }),
      ).toBe(2000);
    });
  });

  test("delays are deterministic (no jitter) so retry timing is reproducible", () => {
    const args = { baseDelayMs: 1000, attempts: 2 };
    const runs = Array.from({ length: 5 }, () => computeRetryDelayMs(args));
    expect(new Set(runs).size).toBe(1);
  });
});

describe("classifyApiErrorText carries the retry-after hint", () => {
  test("a rate limit with a wait hint exposes retryAfterMs", () => {
    const reason = classifyApiErrorText("429 rate limit exceeded, retry after 30s");
    expect(reason).toMatchObject({ type: "rate-limit", retriable: true, retryAfterMs: 30_000 });
  });

  test("a bare 429 with a hint exposes retryAfterMs", () => {
    const reason = classifyApiErrorText("429 Too Many Requests (retry-after: 10)");
    expect(reason).toMatchObject({ type: "rate-limit", retriable: true, retryAfterMs: 10_000 });
  });

  test("a server error with a hint exposes retryAfterMs", () => {
    const reason = classifyApiErrorText("503 Service Unavailable, try again in 15s");
    expect(reason).toMatchObject({ retriable: true, retryAfterMs: 15_000 });
  });

  test("a timeout with a hint exposes retryAfterMs", () => {
    const reason = classifyApiErrorText("Request timed out; retry after 5s");
    expect(reason).toMatchObject({ type: "timeout", retriable: true, retryAfterMs: 5_000 });
  });

  test("the motivating OpenRouter 429 is retriable with no hint", () => {
    const reason = classifyApiErrorText(
      '429: {"message":"Provider returned error","code":429,"metadata":{"raw":"poolside/laguna-s-2.1 is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits","provider_name":"Poolside","is_byok":false}}',
    );
    expect(reason.type).toBe("rate-limit");
    expect(reason.retriable).toBe(true);
    expect(reason.retryAfterMs).toBeUndefined();
    // With no hint, pacing falls to backoff rather than the old flat 1s.
    expect(computeRetryDelayMs({ baseDelayMs: 1000, attempts: 2, retryAfterMs: undefined })).toBe(
      4000,
    );
  });

  describe("permanent failures carry no hint", () => {
    test("billing errors omit retryAfterMs even when text has a number", () => {
      const reason = classifyApiErrorText("insufficient credit, retry after 30s");
      expect(reason.retriable).toBe(false);
      expect(reason.retryAfterMs).toBeUndefined();
    });

    test("auth errors omit retryAfterMs", () => {
      const reason = classifyApiErrorText("401 unauthorized, retry after 10s");
      expect(reason.retriable).toBe(false);
      expect(reason.retryAfterMs).toBeUndefined();
    });
  });
});
