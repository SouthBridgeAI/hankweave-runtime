#!/usr/bin/env bun
/**
 * Event-order fidelity for a single assistant message with mixed content.
 *
 * When one assistant message carries [thinking, text, Write x, Write y], the
 * journal must record the message's own internal order:
 *
 *   thinking, message, file.updated(x), tool_use(x), file.updated(y), tool_use(y)
 *
 * The regression this pins down: the runner used to pre-scan the whole message
 * for file tools before forwarding it, so every file.updated fired first —
 * file bodies appeared "before" the thinking/text that motivated them, and
 * sentinels matching on thinking/message observed file state from later items
 * in the same message. The fix routes each tool_use item through
 * CodonRunner.observeToolUse at its position inside the runtime's
 * handleAssistantMessage loop.
 *
 * Driven through replay mode so the real log parser → CodonRunner →
 * HankweaveRuntime → event pipeline runs exactly as in production, with no
 * LLM API calls.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type LaunchedServer, launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import {
  type BuiltReplayFixture,
  buildReplayFixture,
  type LogLine,
  successResultLine,
} from "../utils/replay-fixture-builder.js";
import { getFreePort } from "../utils/test-helpers.js";

const READY_TIMEOUT = 30_000;
const COMPLETE_TIMEOUT = 45_000;
const TEST_TIMEOUT = 60_000;

const CODON_ID = "mixed";
const SESSION_ID = "00000000-0000-4000-8000-000000000000";

/** One assistant message interleaving thinking, text, and two Write calls. */
function mixedContentAssistantLine(): LogLine {
  return {
    type: "assistant",
    message: {
      model: "claude-haiku-4-5",
      id: "msg_replayfixturemixed000",
      type: "message",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "I should write x, then y." },
        { type: "text", text: "Writing both files now." },
        {
          type: "tool_use",
          id: "toolu_replayfixture_x0000",
          name: "Write",
          input: { file_path: "x.txt", content: "x contents" },
        },
        {
          type: "tool_use",
          id: "toolu_replayfixture_y0000",
          name: "Write",
          input: { file_path: "y.txt", content: "y contents" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 3, output_tokens: 5 },
    },
    session_id: SESSION_ID,
  };
}

/** Compact label for the events this test is about; null for all others. */
function label(event: { type: string; data: unknown }): string | null {
  if (event.type === "file.updated") {
    const data = event.data as { path: string };
    return `file.updated(${data.path})`;
  }
  if (event.type === "assistant.action") {
    const data = event.data as {
      codonId: string;
      action: string;
      toolInput?: { file_path?: string };
    };
    if (data.codonId !== CODON_ID) return null;
    if (data.action === "tool_use") return `tool_use(${data.toolInput?.file_path})`;
    return data.action;
  }
  return null;
}

let fixture: BuiltReplayFixture | null = null;
let server: LaunchedServer | null = null;

afterEach(async () => {
  await server?.kill().catch(() => {});
  server = null;
  fixture?.cleanup();
  fixture = null;
});

describe("assistant message event ordering (replay)", () => {
  test(
    "file.updated stays adjacent to its own tool_use, after the message's thinking/text",
    async () => {
      fixture = buildReplayFixture({
        codons: [
          {
            id: CODON_ID,
            logLines: [mixedContentAssistantLine(), successResultLine("Done.")],
          },
        ],
        // hank.json override: the generated config cannot express
        // checkpointedFiles, and without watched patterns the file tracker
        // ignores Write calls entirely.
        hank: {
          hank: [
            {
              id: CODON_ID,
              name: CODON_ID,
              promptText: `Replay fixture codon ${CODON_ID}`,
              model: "haiku",
              continuationMode: "fresh",
              checkpointedFiles: ["*.txt"],
            },
          ],
        },
      });

      const port = await getFreePort();
      server = await launchHankweave({
        configPath: fixture.configPath,
        dataDir: fixture.dataPath,
        replayDir: fixture.execDir,
        port,
        logPrefix: "[assistant-message-event-ordering]",
        // --headless autostarts before any client connects; backfill (safe
        // against a buildReplayFixture journal, which starts empty) hands this
        // client the events it raced past.
        extraArgs: ["--force", "--headless"],
        sendPreviousEvents: true,
      });
      await server.waitForEvent("server.ready", READY_TIMEOUT);
      await server.waitForEvent(
        "codon.completed",
        COMPLETE_TIMEOUT,
        (e) => (e.data as { codonId?: string }).codonId === CODON_ID,
      );

      const labels = server
        .getEvents()
        .map(label)
        .filter((l): l is string => l !== null);

      // The message's internal narrative order, with each file.updated
      // immediately before its own tool's assistant.action.
      expect(labels).toEqual([
        "thinking",
        "message",
        "file.updated(x.txt)",
        "tool_use(x.txt)",
        "file.updated(y.txt)",
        "tool_use(y.txt)",
      ]);

      // Control for the coarse invariant on its own terms: every file.updated
      // precedes its file's tool_use, independent of the exact-order assertion
      // above (this half must survive any future reshuffling).
      for (const file of ["x.txt", "y.txt"]) {
        const updated = labels.indexOf(`file.updated(${file})`);
        const toolUse = labels.indexOf(`tool_use(${file})`);
        expect(updated).toBeGreaterThanOrEqual(0);
        expect(toolUse).toBeGreaterThan(updated);
      }
    },
    TEST_TIMEOUT,
  );
});
