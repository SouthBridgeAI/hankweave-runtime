/**
 * CodonRunner timeout classification. Three shapes must classify as
 * { type:"timeout", retriable:true } with an APITimeoutError carried for
 * telemetry:
 *
 *  1. The CLI's SYNTHETIC assistant message (model "<synthetic>", string
 *     content "API Error: Request timed out.") — the session is hung, so the
 *     runner must also tear its own process down.
 *  2. The plain assistant-TEXT form (a text content item with the same text).
 *  3. The RESULT-message form (is_error result carrying the timeout text).
 *
 * The assistant shapes are NOT forwarded as assistantMessage events (no
 * assistant.action for timeout text), and every classification point emits
 * `codonFailure` for live client display.
 *
 * Also covers the getOutcome() surface: the single per-attempt outcome struct
 * the runtime reads once in handleCodonComplete.
 */

import { describe, expect, test } from "bun:test";
import { APITimeoutError } from "../../server/types/error-types.js";
import {
  jsonl,
  sdkLog,
  TIMEOUT_TEXT,
  useCodonRunnerSuite,
} from "../utils/codon-runner-test-harness.js";

describe("CodonRunner timeout classification", () => {
  const suite = useCodonRunnerSuite("timeout");

  async function makeRunnerWithLog(logContent: string) {
    const h = await suite.makeRunner({ log: logContent });
    await h.parseLog();
    return h;
  }

  test("synthetic timeout message → timeout classification + self-kill, not forwarded", async () => {
    const h = await makeRunnerWithLog(jsonl(sdkLog.init(), sdkLog.syntheticTimeout()));

    expect(h.runner.getOutcome().failureReason).toMatchObject({
      type: "timeout",
      retriable: true,
      message: TIMEOUT_TEXT,
    });
    expect(h.runner.getOutcome().failureError).toBeInstanceOf(APITimeoutError);
    // The runner tears its own process down (the runtime no longer reaches in).
    expect(h.killCalls.length).toBe(1);
    // Live display: exactly one codonFailure carrying the typed error.
    expect(h.events.codonFailures.length).toBe(1);
    expect(h.events.codonFailures[0]?.reason.type).toBe("timeout");
    expect(h.events.codonFailures[0]?.error).toBeInstanceOf(APITimeoutError);
    // The timeout message is suppressed, mirroring the runtime's old early-return.
    expect(h.events.assistantTexts).not.toContain(TIMEOUT_TEXT);
  });

  test("assistant-text timeout message → timeout classification + self-kill, not forwarded", async () => {
    const h = await makeRunnerWithLog(jsonl(sdkLog.init(), sdkLog.assistantText(TIMEOUT_TEXT)));

    expect(h.runner.getOutcome().failureReason).toMatchObject({
      type: "timeout",
      retriable: true,
      message: TIMEOUT_TEXT,
    });
    expect(h.runner.getOutcome().failureError).toBeInstanceOf(APITimeoutError);
    expect(h.killCalls.length).toBe(1);
    expect(h.events.codonFailures.length).toBe(1);
    expect(h.events.assistantTexts).not.toContain(TIMEOUT_TEXT);
  });

  test("string-content timeout on a NORMAL model → classified + self-kill, not forwarded", async () => {
    // Assistant content may be a plain string (not an array) even for
    // non-synthetic models. Without string normalization the timeout would be
    // forwarded unclassified and the session left to the idle watchdog.
    const h = await makeRunnerWithLog(
      jsonl(sdkLog.init(), sdkLog.assistantText(TIMEOUT_TEXT, { stringContent: true })),
    );

    expect(h.runner.getOutcome().failureReason).toMatchObject({
      type: "timeout",
      retriable: true,
      message: TIMEOUT_TEXT,
    });
    expect(h.runner.getOutcome().failureError).toBeInstanceOf(APITimeoutError);
    expect(h.killCalls.length).toBe(1);
    expect(h.events.codonFailures.length).toBe(1);
    expect(h.events.assistantTexts).not.toContain(TIMEOUT_TEXT);
  });

  test("non-timeout assistant messages are still forwarded", async () => {
    const h = await makeRunnerWithLog(jsonl(sdkLog.init(), sdkLog.assistantText("working on it")));

    expect(h.events.assistantTexts).toContain("working on it");
    expect(h.runner.getOutcome().failureReason).toBeUndefined();
    expect(h.killCalls.length).toBe(0);
  });

  test("result-message timeout → timeout classification with APITimeoutError, no kill", async () => {
    const h = await makeRunnerWithLog(
      jsonl(sdkLog.init(), sdkLog.errorResult(TIMEOUT_TEXT, { duration_ms: 60_000 })),
    );

    expect(h.runner.getOutcome().failureReason).toMatchObject({
      type: "timeout",
      retriable: true,
      message: TIMEOUT_TEXT,
    });
    expect(h.runner.getOutcome().failureError).toBeInstanceOf(APITimeoutError);
    expect(h.events.codonFailures.length).toBe(1);
    expect(h.events.codonFailures[0]?.error).toBeInstanceOf(APITimeoutError);
    // A result message means the session already ended — nothing to kill.
    expect(h.killCalls.length).toBe(0);

    const outcome = h.runner.getOutcome();
    expect(outcome.resultReceived).toBe(true);
    expect(outcome.success).toBe(false);
    expect(outcome.errorResultReceived).toBe(true);
    expect(outcome.failureReason?.type).toBe("timeout");
    expect(outcome.failureError).toBeInstanceOf(APITimeoutError);
    expect(outcome.sessionEstablished).toBe(true);
  });

  test("Pi idle-timeout result keeps its real provider text — no Claude-specific APITimeoutError", async () => {
    // APITimeoutError's message is hard-coded to "Claude API request timed
    // out"; wrapping the Pi agent's idle-timeout in it would misreport the
    // provider and drop the actual duration. Only the Claude CLI's exact
    // timeout text gets the typed error.
    const piIdleText = "Idle timeout: no events received for 180000ms";
    const h = await makeRunnerWithLog(
      jsonl(sdkLog.init(), sdkLog.errorResult(piIdleText, { duration_ms: 180_000 })),
    );

    expect(h.runner.getOutcome().failureReason).toMatchObject({
      type: "timeout",
      retriable: true,
      message: piIdleText,
    });
    // No Claude-specific wrapper: the codonFailure display and telemetry keep
    // the provider's own message via reason.message.
    expect(h.runner.getOutcome().failureError).toBeUndefined();
    expect(h.events.codonFailures.length).toBe(1);
    expect(h.events.codonFailures[0]?.reason.message).toBe(piIdleText);
    expect(h.events.codonFailures[0]?.error).toBeUndefined();
  });

  test("getOutcome(): clean success run", async () => {
    const h = await makeRunnerWithLog(jsonl(sdkLog.init(), sdkLog.successResult()));

    expect(h.runner.getOutcome()).toMatchObject({
      resultReceived: true,
      success: true,
      errorResultReceived: false,
      failureReason: undefined,
      failureError: undefined,
      sessionEstablished: true,
    });
  });

  test("getOutcome(): empty error placeholder + permanent SDK throw carries the thrown Error", async () => {
    // SDK placeholder — real error text arrives via the thrown error.
    const h = await makeRunnerWithLog(jsonl(sdkLog.init(), sdkLog.errorResult("")));

    const thrown = new Error("API Error: Your credit balance is too low to access the API.");
    await h.emitProcessError(thrown);

    const outcome = h.runner.getOutcome();
    expect(outcome.resultReceived).toBe(true);
    expect(outcome.success).toBe(false);
    // The empty placeholder still blocks extension...
    expect(outcome.errorResultReceived).toBe(true);
    // ...while the classification comes from the REAL thrown error (permanent).
    expect(outcome.failureReason).toMatchObject({ type: "api-error", retriable: false });
    expect(outcome.failureError).toBe(thrown);
    expect(outcome.sessionEstablished).toBe(true);
  });
});
