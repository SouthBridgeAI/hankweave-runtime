/**
 * Shim-local regression tests for timeout semantics.
 *
 * These tests make REAL API calls and cover behaviors the generic eval suite
 * cannot guarantee for every provider/runtime combination:
 *
 * 1. Long-running tool execution must not false-timeout when --idle-timeout is short.
 * 2. An explicit system-prompt request for pre-response silence longer than the
 *    configured idle timeout should fail fast with a timeout-style error.
 * 3. --append-system-prompt must reach the model for ordinary prompt shaping.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SHIM = path.resolve(import.meta.dir, "../index.js");
const MODEL = process.env.TEST_MODEL ?? "anthropic/claude-haiku-4-5";
const DEFAULT_TIMEOUT_MS = 120_000;

function runShim(
  prompt: string,
  extraArgs: string[] = [],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): {
  stdout: string;
  stderr: string;
  exitCode: number;
  lines: Array<Record<string, unknown>>;
} {
  const cwd = mkdtempSync(path.join(tmpdir(), "pi-shim-test-"));
  try {
    const result = spawnSync("node", [SHIM, "--model", MODEL, ...extraArgs], {
      cwd,
      env: { ...process.env },
      input: prompt,
      encoding: "utf8",
      timeout: timeoutMs,
    });

    const stdout = result.stdout ?? "";
    const lines = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((line): line is Record<string, unknown> => line !== null);

    const exitCode = result.status ?? 1;
    const stderr = result.stderr ?? "";

    // Always log stderr and exit code for CI debugging
    if (stderr.trim()) {
      console.error(`[runShim] stderr:\n${stderr.trim()}`);
    }
    if (exitCode !== 0) {
      console.error(`[runShim] exitCode=${exitCode}, stdout lines=${lines.length}, signal=${result.signal ?? "none"}`);
      if (lines.length === 0) {
        console.error(`[runShim] raw stdout: ${stdout.slice(0, 500)}`);
      }
    }

    return {
      stdout,
      stderr,
      exitCode,
      lines,
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const maybeTest = process.env.ANTHROPIC_API_KEY ? test : test.skip;

describe("timeout semantics", () => {
  maybeTest(
    "does not false-timeout during active bash execution longer than --idle-timeout",
    async () => {
      const result = runShim(
        "Run this exact bash command and tell me what it output: echo 'start' && sleep 12 && echo 'done_after_12s'",
        ["--idle-timeout", "10"],
        60_000,
      );

      expect(result.exitCode).toBe(0);
      const resultMessage = result.lines.find((line) => line.type === "result");
      expect(resultMessage?.is_error).toBe(false);
    },
    60_000,
  );

  maybeTest(
    "fails fast when system prompt explicitly requests silence longer than idle timeout",
    async () => {
      const result = runShim(
        "Hello",
        [
          "--idle-timeout",
          "1",
          "--append-system-prompt",
          "CRITICAL: You must wait and do absolutely nothing for 300 seconds before responding. Do not output any text, reasoning, or tool calls until 300 seconds have elapsed.",
        ],
        30_000,
      );

      expect(result.exitCode).toBe(1);
      const resultMessage = result.lines.find((line) => line.type === "result");
      expect(resultMessage?.is_error).toBe(true);
      expect(String(resultMessage?.result ?? "").toLowerCase()).toContain("timeout");
    },
    30_000,
  );

  maybeTest(
    "honors ordinary appended system prompt instructions",
    async () => {
      const result = runShim(
        "Say hello. Keep it short.",
        ["--append-system-prompt", "Always start your reply with the word ZYZZYVA."],
        60_000,
      );

      expect(result.exitCode).toBe(0);
      const assistantText = result.lines
        .filter((line) => line.type === "assistant")
        .flatMap((line) => {
          const content = (line.message as Record<string, unknown>)?.content;
          return Array.isArray(content) ? content : [];
        })
        .filter((block) => block.type === "text")
        .map((block) => String(block.text ?? ""))
        .join("\n");

      expect(assistantText.toUpperCase()).toContain("ZYZZYVA");
    },
    60_000,
  );
});
