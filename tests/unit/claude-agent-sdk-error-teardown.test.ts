/**
 * Regression: when the SDK query fails MID-STREAM (e.g. a 401/token-expiry or
 * socket drop during the agent's streaming turn), the in-flight query must be
 * ABORTED so its streaming connection and child process are torn down. Without
 * the abort, the child lingers and subsequent teardown/shutdown can wedge — the
 * production hang where a run detected an unrecoverable error but never exited.
 *
 * The SDK `query` is mocked at the module level BEFORE the manager is imported
 * (via top-level await + dynamic import) so the manager binds to the stub.
 */
import { describe, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ClaudeLogParser } from "../../server/claude-log-parser";
import { Logger } from "../../server/utils";

// A generator that establishes a session (one system/init message) and then
// throws mid-stream, mirroring a token expiry during the agent's streaming turn.
function failingMidStreamQuery() {
  return (async function* () {
    yield { type: "system", subtype: "init", session_id: "sess-midstream" };
    throw new Error("Claude Code returned an error result: 401 Invalid authentication credentials");
  })();
}

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => failingMidStreamQuery(),
}));

const { ClaudeAgentSDKManager } = await import("../../server/claude-agent-sdk-manager");

describe("ClaudeAgentSDKManager mid-stream error teardown", () => {
  test("aborts the in-flight abortController when the query fails mid-stream", async () => {
    const tempDir = path.resolve("tests", "test-area", `temp-sdk-teardown-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    try {
      const logger = new Logger(path.join(tempDir, "test.log"));
      const logParser = new ClaudeLogParser({
        logPath: path.join(tempDir, "mock.log"),
        codonId: "analyze",
        parsingInterval: 100,
      });
      const manager = new ClaudeAgentSDKManager(tempDir, tempDir, logger, logParser);

      // Pre-set the abortController (normally created in spawn()) and spy on it.
      // The error path must abort it before cleanup() nulls the reference.
      const abortController = new AbortController();
      const abortSpy = spyOn(abortController, "abort");
      // biome-ignore lint/suspicious/noExplicitAny: private field access for unit test
      (manager as any).abortController = abortController;

      await expect(
        // biome-ignore lint/suspicious/noExplicitAny: private method access for unit test
        (manager as any).runQuery("prompt", { model: "claude-sonnet-4-6" }, "analyze", undefined),
      ).rejects.toThrow(/401/);

      expect(abortSpy).toHaveBeenCalled();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
