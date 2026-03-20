#!/usr/bin/env bun
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CodonCompletedEvent, ServerReadyEvent } from "../../server/schemas/event-schemas.js";
import { launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import { getFreePort } from "../utils/test-helpers.js";

describe("Codex Web Search Query E2E", () => {
  it("should record non-empty WebSearch query in transcript log", async () => {
    const port = await getFreePort();
    const hankweave = await launchHankweave({
      configPath: "tests/config/test-codex-web-search.config.json",
      port,
      logPrefix: "[codex-web-search-test]",
    });

    try {
      const readyEvent = (await hankweave.waitForEvent("server.ready")) as ServerReadyEvent;
      const executionPath = readyEvent.data.executionPath;

      await hankweave.waitForCodonStart("codex-web-search", undefined, 30_000);
      const completedEvent = (await hankweave.waitForCodonCompletion(
        "codex-web-search",
        undefined,
        300_000,
      )) as CodonCompletedEvent;

      expect(completedEvent.data.success).toBe(true);

      await hankweave.waitForRunToComplete(10_000);

      // Locate the transcript log for this codon
      const runsDir = path.join(executionPath, ".hankweave", "runs");
      const runId = fs.readdirSync(runsDir)[0];
      const logPath = path.join(runsDir, runId, "codex-web-search-claude.log");
      expect(fs.existsSync(logPath)).toBe(true);

      // Parse JSONL and collect WebSearch tool_use blocks
      type ContentBlock = { type: string; name?: string; input?: { query?: string } };
      type LogEntry = { type: string; message?: { content?: ContentBlock[] } };

      const entries = fs
        .readFileSync(logPath, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as LogEntry);

      const webSearchUses = entries.flatMap((e) => {
        if (e.type !== "assistant") return [];
        return (e.message?.content ?? []).filter(
          (c) => c.type === "tool_use" && c.name === "WebSearch",
        );
      });

      // The codon must have performed at least one web search
      expect(webSearchUses.length).toBeGreaterThan(0);

      // CRITICAL: every WebSearch tool_use must have a non-empty query.
      // This currently FAILS because the shim emits the tool_use block on
      // item.started when item.query is still "" — the actual query arrives
      // in later streaming chunks but is never written back to the transcript.
      // Once the shim fix lands (defer emission until item.completed), this passes.
      for (const use of webSearchUses) {
        expect(use.input?.query).toBeTruthy();
      }
    } finally {
      if (hankweave.process.exitCode === null && hankweave.process.signalCode === null) {
        await hankweave.stop();
      }
    }
  }, 600_000);
});
