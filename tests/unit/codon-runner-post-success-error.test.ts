/**
 * Tests for CodonRunner's handling of post-success SDK errors.
 *
 * This tests the fix for a known Claude Agent SDK bug where the SDK
 * emits an error ("only prompt commands are supported in streaming mode")
 * AFTER already reporting a successful result.
 *
 * See: intermediates/31-fixing-claude-sdk-bug/bug_investigation.md
 */

import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { SessionId } from "../../server/types/branded-types.js";
import { jsonl, sdkLog, useCodonRunnerSuite } from "../utils/codon-runner-test-harness.js";

// Path to test log file that reproduces the SDK bug sequence
// This contains real data extracted from run 1769144204725-v8vnh
const BUGGY_LOG_PATH = path.resolve(
  import.meta.dir,
  "../test-data/claude-logs/sdk-post-success-error/buggy-sequence.jsonl",
);

describe("CodonRunner post-success SDK error handling", () => {
  const suite = useCodonRunnerSuite("sdk-error");

  describe("with real buggy SDK log sequence (log replay)", () => {
    test("should emit exit instead of error after parsing success result", async () => {
      const h = await suite.makeRunner({ logFile: BUGGY_LOG_PATH });

      await h.parseLog();

      // Verify the success flag was set by parsing the log
      expect(h.internals.successResultReceived).toBe(true);

      // Now simulate the SDK crash - this is what triggers the error event.
      // In real scenario: SDK emits success, then error_during_execution, then crashes
      await h.emitProcessError("Claude Code process exited with code 1");

      // Verify: we got exit(0), not error
      expect(h.events.exits.map((e) => e.code)).toEqual([0]);
      expect(h.events.errors.length).toBe(0);
    });
  });

  describe("without success result (normal error path)", () => {
    test("permanent failure with no success result -> non-retriable exit, not fatal error", async () => {
      // No success result -> post-success suppression must NOT apply. With no
      // result message at all, the crash is classified. A PERMANENT failure
      // (here, a billing error) is still an SDK/API outcome, so it routes through
      // the EXIT path carrying a non-retriable failureReason — letting
      // resolveFailurePolicy decide shutdown vs continue — rather than a fatal
      // "error" that the runtime would escalate to FATAL shutdown, bypassing the
      // policy. Transient crashes with no result also route to the exit path —
      // see tests/unit/codon-runner-transient-crash-retry.test.ts.
      const h = await suite.makeRunner(); // empty log: no success result

      expect(h.internals.successResultReceived).toBe(false);

      // Simulate a permanent SDK error without prior success
      await h.emitProcessError("API Error: Your credit balance is too low to access the API.");

      // Verify: routed to the exit/failure-policy path with a non-retriable
      // reason, NOT a fatal runner error.
      expect(h.events.errors.length).toBe(0);
      expect(h.events.exits.length).toBe(1);
      expect(h.events.exits[0]?.code).not.toBe(0);
      expect(h.runner.getOutcome().failureReason).toMatchObject({ retriable: false });
    });
  });

  describe("error result followed by an SDK throw", () => {
    // The SDK can emit an error RESULT and THEN throw a process-manager error.
    // The throw must be routed by RETRIABILITY (deriveAttemptFailure prefers
    // the result text), not by whether a result arrived — otherwise
    // `onFailure: retry` is bypassed.
    async function runWithResultThenThrow(resultOverrides: Record<string, unknown>) {
      const h = await suite.makeRunner({
        log: jsonl(
          sdkLog.init(),
          sdkLog.result({
            num_turns: 5,
            duration_ms: 10000,
            duration_api_ms: 8000,
            ...resultOverrides,
          }),
        ),
      });
      await h.parseLog();

      // A disguised/error result is never a success.
      expect(h.internals.successResultReceived).toBe(false);

      // SDK throws after emitting the result.
      await h.emitProcessError("Claude Code process exited with code 1");
      return h;
    }

    test("retriable error result then throw -> retriable exit, not fatal", async () => {
      // A disguised socket-drop result.
      const h = await runWithResultThenThrow({
        subtype: "success",
        is_error: true,
        result: "API Error: The socket connection was closed unexpectedly.",
      });
      expect(h.events.errors.length).toBe(0);
      expect(h.events.exits.length).toBe(1);
      expect(h.events.exits[0]?.code).not.toBe(0);
    });

    test("permanent error result then throw -> non-retriable exit routed to failure policy", async () => {
      const h = await runWithResultThenThrow({
        subtype: "error",
        is_error: true,
        result: "API Error: Your credit balance is too low to access the API.",
      });
      // Permanent, but still an SDK/API outcome: route through the exit path with
      // a non-retriable reason (not a fatal runner error that bypasses the policy).
      expect(h.events.errors.length).toBe(0);
      expect(h.events.exits.length).toBe(1);
      expect(h.events.exits[0]?.code).not.toBe(0);
      expect(h.runner.getOutcome().failureReason).toMatchObject({ retriable: false });
    });
  });

  describe("successResultReceived flag behavior", () => {
    test("should be false initially", async () => {
      const h = await suite.makeRunner(); // empty log

      expect(h.internals.successResultReceived).toBe(false);
    });

    test("should be set to true only for success subtype", async () => {
      const h = await suite.makeRunner({
        log: jsonl(sdkLog.init(), sdkLog.successResult("All done!")),
      });

      // Initially false
      expect(h.internals.successResultReceived).toBe(false);

      await h.parseLog();

      // After parsing success result, should be true
      expect(h.internals.successResultReceived).toBe(true);
    });

    test("should NOT be set for disguised errors (subtype=success, is_error=true)", async () => {
      // The SDK reports transport failures as subtype="success" with is_error=true. Treating
      // those as success routed the SDK's thrown error through the
      // post-success suppression path, masking the real failure.
      const h = await suite.makeRunner({
        log: jsonl(
          sdkLog.init(),
          sdkLog.disguisedErrorResult("API Error: The socket connection was closed unexpectedly."),
        ),
      });

      await h.parseLog();

      // Disguised error must not count as success...
      expect(h.internals.successResultReceived).toBe(false);

      // ...and must produce a retriable failure reason for the runtime.
      expect(h.runner.getOutcome().failureReason).toMatchObject({
        type: "api-error",
        retriable: true,
      });
    });

    test("should reset successResultReceived between extensions", async () => {
      // A flag that persists across extensions would mask extension failures
      // as successes when SDK errors occur.
      const h = await suite.makeRunner({
        log: jsonl(sdkLog.init(), sdkLog.successResult("Initial run completed successfully")),
        codon: { exhaustWithPrompt: "Continue with extension" }, // enable extensions
        runner: {
          extensionConfig: {
            maxExtensions: 5,
            exhaustWithPrompt: "Continue with extension",
          },
          shouldInterrupt: () => false,
          onExtension: () => {
            // Extension callback - empty for this test
          },
        },
      });

      await h.parseLog();

      // Verify: successResultReceived is true after initial success
      expect(h.internals.successResultReceived).toBe(true);

      // Prevent real SDK spawn during this unit test
      // (performExtension -> runExtension -> spawn -> SDK query)
      h.stubRunExtension();

      // Now simulate triggering an extension by calling performExtension directly.
      // In real scenarios, this happens when the process exits and shouldExtendCodon returns true
      await h.internals.performExtension.call(
        h.runner,
        SessionId("test-session"),
        { maxExtensions: 5, exhaustWithPrompt: "Continue with extension" },
        () => {},
        0, // previousExitCode
        false, // wasContextExceeded
      );

      // After performExtension resets per-extension state,
      // successResultReceived should be false (ready for the next extension's success tracking)
      expect(h.internals.successResultReceived).toBe(false);
    });
  });
});
