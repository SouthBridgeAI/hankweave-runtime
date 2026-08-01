/**
 * Tests for CodonRunner's failure reason classification from result messages.
 *
 * Classification is delegated to the shared classifier in
 * server/error-classification.ts: transient errors (timeouts, rate limits,
 * transport faults, unknown text) are retriable; billing/auth/invalid-request
 * errors are not.
 */

import { describe, expect, test } from "bun:test";
import { deriveAttemptFailure } from "../../server/codon-runner.js";
import { jsonl, sdkLog, useCodonRunnerSuite } from "../utils/codon-runner-test-harness.js";

describe("CodonRunner failure reason classification", () => {
  const suite = useCodonRunnerSuite("failure-reason");

  async function runAndGetFailureReason(logContent: string) {
    const h = await suite.makeRunner({ log: logContent });
    await h.parseLog();
    return h.runner.getOutcome().failureReason;
  }

  test("classifies timeout error as { type: 'timeout', retriable: true }", async () => {
    const failureReason = await runAndGetFailureReason(
      jsonl(sdkLog.init(), sdkLog.errorResult("API Error: Request timed out.")),
    );
    expect(failureReason).toMatchObject({ type: "timeout", retriable: true });
  });

  test("classifies rate-limit error as { type: 'rate-limit', retriable: true }", async () => {
    const failureReason = await runAndGetFailureReason(
      jsonl(sdkLog.init(), sdkLog.errorResult("Rate limit exceeded (429)")),
    );
    expect(failureReason).toMatchObject({ type: "rate-limit", retriable: true });
  });

  test("classifies api error as { type: 'api-error', retriable: true }", async () => {
    const failureReason = await runAndGetFailureReason(
      jsonl(sdkLog.init(), sdkLog.errorResult("Internal API error 500")),
    );
    expect(failureReason).toMatchObject({ type: "api-error", retriable: true });
  });

  test("classifies unknown error as retriable api-error (transient by default)", async () => {
    const failureReason = await runAndGetFailureReason(
      jsonl(sdkLog.init(), sdkLog.errorResult("Something unexpected happened")),
    );
    expect(failureReason).toMatchObject({ type: "api-error", retriable: true });
  });

  test("classifies billing error as non-retriable", async () => {
    const failureReason = await runAndGetFailureReason(
      jsonl(sdkLog.init(), sdkLog.errorResult("Credit balance is too low")),
    );
    expect(failureReason).toMatchObject({ type: "api-error", retriable: false });
  });

  test("leaves failureReason UNSET for an empty error-subtype result (SDK placeholder)", async () => {
    // The Claude SDK strips the `result` field from subtype:"error" messages;
    // ClaudeAgentSDKManager.convertSDKMessageToJSONL then writes result:"".
    // Classifying that empty placeholder would always yield a default-retriable
    // api-error and shadow the real thrown error in the SDK-crash path. Instead,
    // failureReason must stay undefined so the later thrown error is classified
    // authoritatively (see codon-runner-transient-crash-retry.test.ts).
    const failureReason = await runAndGetFailureReason(
      jsonl(sdkLog.init(), sdkLog.errorResult("")),
    );
    expect(failureReason).toBeUndefined();
  });

  test("falls back to the passthrough `error` field when `result` is empty", async () => {
    // Some result shapes carry the real text in an `error` field alongside an
    // empty `result`. The fallback must classify it — here a permanent billing
    // error — instead of leaving the failure to the generic retriable backstop.
    const failureReason = await runAndGetFailureReason(
      jsonl(
        sdkLog.init(),
        sdkLog.errorResult("", {
          error: "API Error: Your credit balance is too low to access the API.",
        }),
      ),
    );
    expect(failureReason).toMatchObject({ type: "api-error", retriable: false });
  });

  test("classifies disguised error (subtype=success, is_error=true) as retriable failure", async () => {
    const failureReason = await runAndGetFailureReason(
      jsonl(
        sdkLog.init(),
        sdkLog.disguisedErrorResult(
          "API Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
        ),
      ),
    );
    expect(failureReason).toMatchObject({ type: "api-error", retriable: true });
  });

  test("does NOT extend on an empty error-subtype result followed by a clean exit", async () => {
    // An empty subtype:"error" result (the SDK placeholder, result:"") leaves
    // failureReason unset so a later thrown error can classify authoritatively.
    // But when the process then exits cleanly (code 0) with NO thrown error,
    // the internal extension loop must NOT re-prompt: the codon must fail and
    // let the runtime's failure policy apply.
    let onExtensionCalled = false;
    const h = await suite.makeRunner({
      log: jsonl(sdkLog.init(), sdkLog.errorResult("")),
      codon: { exhaustWithPrompt: "Continue" }, // enable extensions
      runner: {
        extensionConfig: { maxExtensions: 2, exhaustWithPrompt: "Continue" },
        shouldInterrupt: () => false,
        onExtension: () => {
          onExtensionCalled = true;
        },
      },
    });

    // Guard: even if the (buggy) extension path fires, never spawn a real SDK.
    h.stubRunExtension();

    // Parse the init + empty error result (sets resultMessageReceived and
    // currentSessionId; leaves failureReason undefined). Then simulate the
    // process exiting cleanly with no thrown SDK error.
    await h.parseLog();
    await h.emitProcessExit(0);

    expect(onExtensionCalled).toBe(false);
    expect(h.events.exits.map((e) => e.code)).toEqual([0]);
  });
});

describe("deriveAttemptFailure — the single classification site over failure evidence", () => {
  // CodonRunner's handlers record raw evidence (result text, timeout, crash
  // error); this pure function owns the priority between them. These tests pin
  // that priority so it cannot silently regress into write-ordering behavior.

  test("no evidence → undefined (runtime synthesizes a backstop)", () => {
    expect(deriveAttemptFailure({ errorResultText: "", sessionEstablished: true })).toBeUndefined();
  });

  test("empty placeholder text contributes nothing: the thrown permanent error classifies", () => {
    // The SDK writes result:"" and THEN throws the real billing error. Empty
    // text must never classify.
    const crashError = new Error("API Error: Your credit balance is too low to access the API.");
    const derived = deriveAttemptFailure({
      errorResultText: "",
      crashError,
      sessionEstablished: true,
    });
    expect(derived?.reason).toMatchObject({ type: "api-error", retriable: false });
    expect(derived?.error).toBe(crashError);
  });

  test("non-empty result text beats the crash text; the crash Error is attached for telemetry", () => {
    // The result carries the real upstream error (a transient socket drop);
    // the SDK's subsequent throw is generic and must not reclassify it.
    const crashError = new Error("Claude Code process exited with code 1");
    const derived = deriveAttemptFailure({
      errorResultText: "API Error: The socket connection was closed unexpectedly.",
      crashError,
      sessionEstablished: true,
    });
    expect(derived?.reason).toMatchObject({ type: "api-error", retriable: true });
    expect(derived?.error).toBe(crashError);
  });

  test("the typed result-timeout Error rides along with a text classification", () => {
    const resultTimeoutError = new Error("typed APITimeoutError stand-in");
    const derived = deriveAttemptFailure({
      errorResultText: "API Error: Request timed out.",
      resultTimeoutError,
      sessionEstablished: true,
    });
    expect(derived?.reason).toMatchObject({ type: "timeout", retriable: true });
    expect(derived?.error).toBe(resultTimeoutError);
  });

  test("runner-initiated assistant timeout wins over the crash of its own teardown", () => {
    // The runner kills a hung session itself; the ensuing process error is a
    // byproduct and must not overwrite the timeout classification.
    const assistantTimeoutError = new Error("typed APITimeoutError stand-in");
    const derived = deriveAttemptFailure({
      errorResultText: "",
      assistantTimeoutError,
      crashError: new Error("process was killed"),
      sessionEstablished: true,
    });
    expect(derived?.reason).toMatchObject({ type: "timeout", retriable: true });
    expect(derived?.error).toBe(assistantTimeoutError);
  });

  test("unrecognized crash before session establishment is a permanent local-setup failure", () => {
    const derived = deriveAttemptFailure({
      errorResultText: "",
      crashError: new Error("spawn ENOENT: no such executable"),
      sessionEstablished: false,
    });
    expect(derived?.reason).toMatchObject({ retriable: false });
  });

  test("known-transient crash text stays retriable even before session establishment", () => {
    const derived = deriveAttemptFailure({
      errorResultText: "",
      crashError: new Error("API Error: 500 Internal Server Error (overloaded_error)"),
      sessionEstablished: false,
    });
    expect(derived?.reason).toMatchObject({ retriable: true });
  });
});
