/**
 * A transient server-side API error (HTTP 500 / "overloaded" / dropped socket)
 * can crash the SDK subprocess MID-CONVERSATION, before any result message is
 * emitted; the SDK surfaces this as a process-manager "error" event.
 *
 * Contract: such a crash must surface as a failure routed through the normal
 * exit path — "exit" with a non-zero code and a classified failureReason in
 * getOutcome() — never as a bare runner "error", which the runtime escalates
 * to a FATAL shutdown that bypasses `onFailure: retry`/`ignore`.
 *
 * Retriability follows classifyApiErrorText: unrecognized crash text defaults
 * to RETRIABLE once a session was established (bounded by maxAttempts), and to
 * NON-retriable before establishment (a local setup failure). Permanent errors
 * (billing/auth) stay non-retriable either way.
 */

import { describe, expect, test } from "bun:test";
import { jsonl, sdkLog, useCodonRunnerSuite } from "../utils/codon-runner-test-harness.js";

describe("CodonRunner transient-crash retry", () => {
  const suite = useCodonRunnerSuite("cc500");

  /** A runner whose log is empty, so no result message is ever parsed. */
  function makeRunnerWithEmptyLog() {
    return suite.makeRunner({
      codon: { id: "analyze", name: "Answer the next batch of queries" },
    });
  }

  test("explicit 5xx crash with no result -> retriable exit, not fatal error", async () => {
    const h = await makeRunnerWithEmptyLog();

    // No success result was received
    expect(h.internals.successResultReceived).toBe(false);

    // SDK subprocess died on a server-side 500 (queryPromise rejected).
    await h.emitProcessError("API Error: 500 Internal Server Error (overloaded_error)");

    // Must NOT bubble a bare fatal error (the runtime turns that into FATAL
    // shutdown, bypassing onFailure: retry).
    expect(h.events.errors.length).toBe(0);

    // Must route into the normal exit/retry path with a non-zero (failed) code...
    expect(h.events.exits.length).toBe(1);
    expect(h.events.exits[0]?.code).not.toBe(0);

    // ...carrying a retriable failure reason so resolveFailurePolicy can retry.
    expect(h.runner.getOutcome().failureReason).toMatchObject({ retriable: true });
  });

  test("generic crash before session established -> non-retriable exit (local-setup)", async () => {
    const h = await makeRunnerWithEmptyLog();

    // No system/init message was ever observed (empty log, SDK session id never
    // captured), so getSystemMessageReceived() is false. The SDK's generic crash
    // text matches no known transient API pattern, so with no session established
    // it classifies as a local setup failure -> NON-retriable: retrying cannot
    // fix a process that died before it ever started talking.
    await h.emitProcessError("Claude Code process exited with code 1");

    // Still routed through the exit path (not a fatal runner error), so
    // resolveFailurePolicy decides — it just won't retry a non-retriable reason.
    expect(h.events.errors.length).toBe(0);
    expect(h.events.exits.length).toBe(1);
    expect(h.events.exits[0]?.code).not.toBe(0);
    expect(h.runner.getOutcome().failureReason).toMatchObject({ retriable: false });
  });

  test("generic crash AFTER session established -> retriable exit (transient)", async () => {
    // Companion to the case above: once a system/init message has been observed,
    // an unrecognized mid-conversation crash is treated as plausibly transient and
    // stays retriable. We simulate establishment by setting the runner's flag, the
    // same state onSystemMessage would produce.
    const h = await makeRunnerWithEmptyLog();
    h.internals.systemMessageReceived = true;

    await h.emitProcessError("Claude Code process exited with code 1");

    expect(h.events.errors.length).toBe(0);
    expect(h.events.exits.length).toBe(1);
    expect(h.events.exits[0]?.code).not.toBe(0);
    expect(h.runner.getOutcome().failureReason).toMatchObject({ retriable: true });
  });

  test("pi pre-session crash with unfamiliar text -> non-retriable exit, NOT fatal error", async () => {
    // A runner for a NON-Anthropic model, so createProcessManager wires up the
    // in-process PiSdkManager instead of the Claude Agent SDK manager. Like the
    // Claude SDK, its `error` event represents an SDK/API crash and must be
    // routed through the exit path with a classified failure reason. A crash
    // BEFORE any session message, with text matching no known transient API
    // signal, is a local setup failure — classified NON-retriable by the
    // sessionEstablished gate — but still exits (so failure policy runs)
    // instead of escalating to a fatal runtime shutdown.
    const h = await suite.makeRunner({
      codon: {
        id: "analyze",
        name: "Answer the next batch of queries",
        model: "gemini-2.5-flash", // non-Anthropic -> rewritten to pi/google -> PiSdkManager
      },
    });

    expect(h.internals.successResultReceived).toBe(false);

    // Local-failure-shaped text (no session was ever established).
    await h.emitProcessError("spawn node ENOENT");

    expect(h.events.errors.length).toBe(0);
    expect(h.events.exits.length).toBe(1);
    expect(h.events.exits[0]?.code).not.toBe(0);
    expect(h.runner.getOutcome().failureReason).toMatchObject({ retriable: false });
  });

  test("empty error-subtype result then permanent throw -> non-retriable (placeholder must NOT shadow real error)", async () => {
    // Regression for the P1 bug: an empty error-subtype result must NOT be
    // classified into failureReason (it would default to retriable and, via
    // `this.failureReason ?? classifyApiErrorText(error.message)`, shadow the
    // REAL thrown billing/auth/400 error — retrying a permanent failure).
    // The log already contains the empty error-subtype RESULT placeholder
    // (ClaudeAgentSDKManager.convertSDKMessageToJSONL writes result:"" for
    // subtype:"error"); parsing consumes it before the queryPromise-rejection
    // "error" event fires.
    const h = await suite.makeRunner({
      log: jsonl(sdkLog.init(), sdkLog.errorResult("")),
      codon: { id: "analyze", name: "Answer the next batch of queries" },
    });
    await h.parseLog();

    // The empty placeholder result was parsed but left failureReason unset.
    expect(h.runner.getOutcome().failureReason).toBeUndefined();

    // The SDK then rejects with the real permanent (billing) error.
    await h.emitProcessError("API Error: Your credit balance is too low to access the API.");

    expect(h.events.errors.length).toBe(0);
    expect(h.events.exits.length).toBe(1);
    expect(h.events.exits[0]?.code).not.toBe(0);
    // The real thrown error wins -> permanent, so onFailure won't retry.
    expect(h.runner.getOutcome().failureReason).toMatchObject({ retriable: false });
  });

  test("permanent error (billing) with no result -> non-retriable exit routed to failure policy", async () => {
    // Guard rail #1: the fix must NOT make genuinely permanent failures retriable.
    // Guard rail #2: an SDK API failure must NOT bubble as a fatal runner "error"
    // either — the runtime escalates those to FATAL shutdown, bypassing
    // handleCodonComplete/resolveFailurePolicy (no failed-state recording, and a
    // codon configured `onFailure: "ignore"` would be ignored). Instead it exits
    // non-zero carrying a NON-retriable failureReason, so resolveFailurePolicy
    // decides shutdown (abort/retry) vs continue (ignore).
    const h = await makeRunnerWithEmptyLog();

    await h.emitProcessError("API Error: Your credit balance is too low to access the API.");

    // No fatal error — routed through the exit/failure-policy path...
    expect(h.events.errors.length).toBe(0);
    expect(h.events.exits.length).toBe(1);
    expect(h.events.exits[0]?.code).not.toBe(0);
    // ...with a permanent reason so the policy won't retry (abort/retry shutdown,
    // ignore continues).
    expect(h.runner.getOutcome().failureReason).toMatchObject({ retriable: false });
  });
});
