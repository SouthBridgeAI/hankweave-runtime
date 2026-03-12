import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  IdleTimeoutError,
  countNumberedSteps,
  extractToolFilePath,
  findInvalidJsonFiles,
  formatGeminiOutputModel,
  normalizeModelForGeminiCli,
  normalizeToolInput,
  normalizeToolName,
  parseArgs,
  shouldRetrySilentSuccessTurn,
  sleep,
  trackChildExit,
  withAdaptiveTimeout,
} from "../src/utils.js";

describe("arg parsing", () => {
  test("parses repeated model with last value winning", () => {
    const args = parseArgs(["--model", "gemini-2.5-pro", "--model=gemini-2.5-flash"]);
    expect(args.model).toBe("gemini-2.5-flash");
  });

  test("parses sandbox and idle timeout", () => {
    const args = parseArgs(["--sandbox", "strict", "--idle-timeout", "30"]);
    expect(args.sandbox).toBe("strict");
    expect(args.idleTimeout).toBe(30);
  });
});

describe("model normalization", () => {
  test("strips provider prefix for Gemini CLI", () => {
    expect(normalizeModelForGeminiCli("google/gemini-2.5-flash").geminiModel).toBe(
      "gemini-2.5-flash",
    );
  });

  test("normalizes Gemini output models to google-prefixed IDs", () => {
    expect(normalizeModelForGeminiCli("flash")).toMatchObject({
      outputModel: "google/gemini-2.5-flash",
      geminiModel: "gemini-2.5-flash",
    });
    expect(normalizeModelForGeminiCli("gemini-2.5-pro").outputModel).toBe(
      "google/gemini-2.5-pro",
    );
    expect(formatGeminiOutputModel("gemini-2.5-flash")).toBe("google/gemini-2.5-flash");
  });
});

class FakeChildProcess extends EventEmitter {
  exitCode: number | null = null;
}

describe("child exit tracking", () => {
  test("resolves immediately when the child already exited", async () => {
    const child = new FakeChildProcess();
    child.exitCode = 1;

    await expect(trackChildExit(child as any)).resolves.toBe(1);
  });

  test("resolves when a close event arrives later", async () => {
    const child = new FakeChildProcess();
    const exitPromise = trackChildExit(child as any);

    child.exitCode = 1;
    child.emit("close", 1);

    await expect(exitPromise).resolves.toBe(1);
  });
});

describe("tool normalization", () => {
  test("maps Gemini tool names to shim names", () => {
    expect(normalizeToolName("read_file")).toBe("Read");
    expect(normalizeToolName("run_shell_command")).toBe("Bash");
  });

  test("normalizes read input", () => {
    expect(normalizeToolInput("Read", { path: "hello.txt", limit: 5 })).toEqual({
      file_path: "hello.txt",
      limit: 5,
    });
  });

  test("extracts tool file paths from normalized inputs", () => {
    expect(extractToolFilePath({ file_path: "package.json" })).toBe("package.json");
    expect(extractToolFilePath({ path: "tsconfig.json" })).toBe("tsconfig.json");
    expect(extractToolFilePath({ command: "ls" })).toBeUndefined();
  });

  test("detects invalid json files that need repair", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "gemini-cli-shim-json-"));
    const validPath = path.join(tempDir, "valid.json");
    const invalidPath = path.join(tempDir, "invalid.json");

    try {
      await writeFile(validPath, '{"ok":true}\n', "utf8");
      await writeFile(invalidPath, '{"broken":"yes"oops}\n', "utf8");

      await expect(findInvalidJsonFiles([validPath])).resolves.toEqual([]);
      await expect(findInvalidJsonFiles([validPath, invalidPath])).resolves.toEqual([
        expect.objectContaining({ filePath: invalidPath }),
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("silent-success detection", () => {
  test("flags success turns with no visible assistant or tool activity", () => {
    expect(
      shouldRetrySilentSuccessTurn({
        isError: false,
        sawAssistantText: false,
        sawToolUse: false,
        sawToolResult: false,
      }),
    ).toBe(true);

    expect(
      shouldRetrySilentSuccessTurn({
        isError: false,
        sawAssistantText: true,
        sawToolUse: false,
        sawToolResult: false,
      }),
    ).toBe(false);
  });

  test("counts numbered steps for completion-check heuristics", () => {
    expect(
      countNumberedSteps(`Please do this in order:\n1. Write a file\n2. Read the file\n3. Summarize it`),
    ).toBe(3);
    expect(countNumberedSteps(`- bullet one\n- bullet two`)).toBe(0);
  });
});

describe("adaptive timeout semantics", () => {
  test("allows a quiet busy step longer than idle timeout once work has started", async () => {
    async function* events() {
      yield { type: "tool_use" };
      await sleep(75);
      yield { type: "result" };
    }

    const collected: string[] = [];
    for await (const event of withAdaptiveTimeout(events(), {
      idleTimeoutMs: 25,
      busyTimeoutMs: 150,
      onEvent(event, controller) {
        if (event.type === "tool_use") controller.markBusy();
        if (event.type === "result") controller.markIdle();
      },
    })) {
      collected.push(event.type);
    }

    expect(collected).toEqual(["tool_use", "result"]);
  });

  test("resets the busy timeout on assistant message deltas", async () => {
    async function* events() {
      yield { type: "message", role: "assistant", content: "Thinking", delta: true };
      await sleep(60);
      yield { type: "message", role: "assistant", content: "...still thinking", delta: true };
      await sleep(60);
      yield { type: "result" };
    }

    const collected: string[] = [];
    for await (const event of withAdaptiveTimeout(events(), {
      idleTimeoutMs: 25,
      busyTimeoutMs: 150,
      onEvent(event, controller) {
        if (event.type === "message" && event.role === "assistant" && event.content.length > 0) {
          controller.markBusy();
        }
        if (event.type === "result") controller.markIdle();
      },
    })) {
      collected.push(event.type);
    }

    expect(collected).toEqual(["message", "message", "result"]);
  });

  test("still times out on pre-work silence", async () => {
    async function* events() {
      await sleep(50);
      yield { type: "message" };
    }

    await expect(
      (async () => {
        for await (const _event of withAdaptiveTimeout(events(), {
          idleTimeoutMs: 20,
          busyTimeoutMs: 100,
        })) {
          // consume
        }
      })(),
    ).rejects.toBeInstanceOf(IdleTimeoutError);
  });
});
