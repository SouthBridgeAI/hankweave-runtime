#!/usr/bin/env bun
/**
 * E2E coverage for API-error classification + failure-policy routing, driven
 * deterministically through REPLAY mode (no real LLM API calls).
 *
 * Each test builds a self-contained replay execution dir whose codon log ends in
 * a crafted `result` message. Replay re-feeds that log through the real runtime,
 * so `classifyApiErrorText` and `resolveFailurePolicy` run exactly as in
 * production:
 *   - transient/retriable error + onFailure:"retry"  → a retry is attempted
 *   - permanent error           + onFailure:"retry"  → no retry, run fails
 *   - permanent error           + onFailure:"ignore" → failure ignored, run continues
 *   - permanent error           + onFailure:"abort"  → run fails, later codons skipped
 *   - no result message at all  + onFailure:"retry"  → retriable backstop, a retry is attempted
 *
 * Retriable scenarios assert that the FIRST "Retrying codon …" info event fires
 * (which proves classification → retry-policy routing) rather than waiting for the
 * run to terminate: replay re-runs a codon by re-writing the same log file, which
 * the parser can't cleanly re-tail, so the *second* replay attempt stalls. That is
 * a replay-harness limitation only — production retries use real process managers.
 * The single-attempt scenarios (permanent / ignore / abort) terminate normally.
 *
 * Companion unit coverage: tests/unit/error-classification.test.ts,
 * tests/unit/codon-runner-transient-crash-retry.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type LaunchedServer, launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import {
  assistantTextLine,
  type BuiltReplayFixture,
  buildReplayFixture,
  errorResultLine,
  successResultLine,
} from "../utils/replay-fixture-builder.js";
import { getFreePort } from "../utils/test-helpers.js";

const READY_TIMEOUT = 30_000;
const TERMINAL_TIMEOUT = 45_000;
const RETRY_TIMEOUT = 30_000;
const TEST_TIMEOUT = 60_000;

let fixture: BuiltReplayFixture | null = null;
let server: LaunchedServer | null = null;

afterEach(async () => {
  if (server) {
    // A retriable scenario leaves a codon mid-replay; SIGKILL avoids a slow
    // graceful-shutdown wait on the stalled second attempt.
    await server.kill().catch(() => {});
    server = null;
  }
  if (fixture) {
    fixture.cleanup();
    fixture = null;
  }
});

async function launchReplay(f: BuiltReplayFixture, logPrefix: string): Promise<LaunchedServer> {
  const port = await getFreePort();
  const s = await launchHankweave({
    configPath: f.configPath,
    dataDir: f.dataPath,
    replayDir: f.execDir,
    port,
    logPrefix,
    extraArgs: ["--force"],
  });
  await s.waitForEvent("server.ready", READY_TIMEOUT);
  return s;
}

describe("Error classification + failure policy (replay e2e)", () => {
  test(
    "transient error + onFailure:retry → a retry is attempted (retriable)",
    async () => {
      fixture = buildReplayFixture({
        codons: [
          {
            id: "flaky",
            onFailure: "retry",
            retryConfig: { maxAttempts: 2, delayMs: 200 },
            logLines: [errorResultLine("API Error: 500 Internal Server Error (overloaded_error)")],
          },
        ],
      });
      server = await launchReplay(fixture, "[replay-transient-retry]");

      // classifyApiErrorText("500 overloaded") → retriable → resolveFailurePolicy
      // returns "retry" → this info event fires.
      await server.waitForCodonRetry("flaky", RETRY_TIMEOUT);

      const completed = server.getCodonCompletion("flaky");
      expect(completed?.data.success).toBe(false);
      expect(completed?.data.failureReason?.retriable).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "disguised socket-drop result (subtype:success+is_error:true) + onFailure:retry → a retry is attempted",
    async () => {
      // A transient socket drop arrives as the SDK's
      // disguised `subtype:"success", is_error:true` result shape — not a plain
      // `subtype:"error"`. onResultMessage classified it retriable, but the
      // failure reason was cleared before resolveFailurePolicy read it, so the
      // codon aborted ("onFailure=retry but error is not retriable (no failure
      // reason), falling back to abort") despite onFailure:retry. This replays
      // the exact terminal result line (shape + message) and asserts the retry
      // fires and the classified reason survives to the completed event.
      fixture = buildReplayFixture({
        codons: [
          {
            id: "socketdrop",
            onFailure: "retry",
            retryConfig: { maxAttempts: 2, delayMs: 200 },
            logLines: [
              errorResultLine(
                "API Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
                { disguised: true },
              ),
            ],
          },
        ],
      });
      server = await launchReplay(fixture, "[replay-socket-drop-retry]");

      await server.waitForCodonRetry("socketdrop", RETRY_TIMEOUT);

      const completed = server.getCodonCompletion("socketdrop");
      expect(completed?.data.success).toBe(false);
      expect(completed?.data.failureReason?.type).toBe("api-error");
      expect(completed?.data.failureReason?.retriable).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "idle-timeout result (subtype:error) + onFailure:retry → a retry is attempted",
    async () => {
      // The SDK went silent and emitted a plain `subtype:"error"`
      // idle-timeout result. classifyApiErrorText tagged it timeout/retriable,
      // but the reason was cleared before resolveFailurePolicy read it, so the
      // codon aborted ("onFailure=retry but error is not retriable (no failure
      // reason), falling back to abort") despite onFailure:retry. Sibling to the
      // disguised socket-drop case above — same root cause, a DIFFERENT trigger
      // and result shape — proving the bypass is not specific to one error shape.
      fixture = buildReplayFixture({
        codons: [
          {
            id: "idletimeout",
            onFailure: "retry",
            retryConfig: { maxAttempts: 2, delayMs: 200 },
            logLines: [errorResultLine("Idle timeout: no events received for 180000ms")],
          },
        ],
      });
      server = await launchReplay(fixture, "[replay-idle-timeout-retry]");

      await server.waitForCodonRetry("idletimeout", RETRY_TIMEOUT);

      const completed = server.getCodonCompletion("idletimeout");
      expect(completed?.data.success).toBe(false);
      expect(completed?.data.failureReason?.type).toBe("timeout");
      expect(completed?.data.failureReason?.retriable).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "rate-limit error mentioning 'quota' + onFailure:retry → retriable (ordering fix)",
    async () => {
      // Regression for the rate-limit-before-quota ordering: an explicit
      // rate_limit/429 that also says "quota" must stay retriable, not be swallowed
      // by the broad billing/quota match.
      fixture = buildReplayFixture({
        codons: [
          {
            id: "ratelimited",
            onFailure: "retry",
            retryConfig: { maxAttempts: 2, delayMs: 200 },
            logLines: [
              errorResultLine("API Error: 429 rate_limit_error: quota exceeded, retry after 60s"),
            ],
          },
        ],
      });
      server = await launchReplay(fixture, "[replay-ratelimit-quota]");

      await server.waitForCodonRetry("ratelimited", RETRY_TIMEOUT);

      const completed = server.getCodonCompletion("ratelimited");
      expect(completed?.data.failureReason?.type).toBe("rate-limit");
      expect(completed?.data.failureReason?.retriable).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "no result message + onFailure:retry → retriable backstop, a retry is attempted",
    async () => {
      // A codon that produces no terminal result is
      // given a bounded-retriable synthesized reason (synthesizeMissingFailureReason).
      fixture = buildReplayFixture({
        codons: [
          {
            id: "noresult",
            onFailure: "retry",
            retryConfig: { maxAttempts: 2, delayMs: 200 },
            logLines: [assistantTextLine("working on it…", { sessionId: "x" })],
          },
        ],
      });
      server = await launchReplay(fixture, "[replay-no-result]");

      await server.waitForCodonRetry("noresult", RETRY_TIMEOUT);

      const completed = server.getCodonCompletion("noresult");
      expect(completed?.data.success).toBe(false);
      expect(completed?.data.failureReason?.retriable).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "provider usage-limit cap + onFailure:retry → permanent, NO retry, run fails",
    async () => {
      fixture = buildReplayFixture({
        codons: [
          {
            id: "capped",
            onFailure: "retry",
            retryConfig: { maxAttempts: 2, delayMs: 200 },
            logLines: [errorResultLine("GoUsageLimitError: monthly usage limit reached")],
          },
        ],
      });
      server = await launchReplay(fixture, "[replay-usage-limit]");

      // Permanent → resolveFailurePolicy returns "shutdown" → run fails, no retry.
      await server.waitForRunToFail(TERMINAL_TIMEOUT);

      expect(server.getCodonRetries("capped").length).toBe(0);
      const completed = server.getCodonCompletion("capped");
      expect(completed?.data.success).toBe(false);
      expect(completed?.data.failureReason?.retriable).toBe(false);
    },
    TEST_TIMEOUT,
  );

  test(
    "permanent error + onFailure:ignore → failure ignored, run continues",
    async () => {
      fixture = buildReplayFixture({
        codons: [
          {
            id: "first",
            onFailure: "ignore",
            logLines: [
              errorResultLine("API Error: Your credit balance is too low to access the API."),
            ],
          },
          {
            id: "second",
            logLines: [successResultLine("All good.")],
          },
        ],
      });
      server = await launchReplay(fixture, "[replay-ignore]");

      await server.waitForRunToComplete(TERMINAL_TIMEOUT);

      const first = server.getCodonCompletion("first");
      expect(first?.data.success).toBe(false);
      expect(first?.data.failureIgnored).toBe(true);

      const second = server.getCodonCompletion("second");
      expect(second?.data.success).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "permanent error + onFailure:abort → run fails, later codon skipped",
    async () => {
      fixture = buildReplayFixture({
        codons: [
          {
            id: "aborter",
            onFailure: "abort",
            logLines: [
              errorResultLine("API Error: Your credit balance is too low to access the API."),
            ],
          },
          {
            id: "never",
            logLines: [successResultLine("Should not run.")],
          },
        ],
      });
      server = await launchReplay(fixture, "[replay-abort]");

      await server.waitForRunToFail(TERMINAL_TIMEOUT);

      expect(server.getCodonCompletion("aborter")?.data.success).toBe(false);
      // The abort stops the run before the next codon starts.
      expect(server.hasCodonStarted("never")).toBe(false);
    },
    TEST_TIMEOUT,
  );
});
