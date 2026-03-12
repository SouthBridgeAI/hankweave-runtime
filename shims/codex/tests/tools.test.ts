import { describe, expect, test } from "bun:test";
import type { CommandExecutionItem, FileChangeItem } from "@openai/codex-sdk";
import { normalizeToolResult, normalizeToolUse } from "../src/tools.js";

describe("tool normalization", () => {
  test("maps cat command to Read tool", () => {
    const item: CommandExecutionItem = {
      id: "item_1",
      type: "command_execution",
      command: "/bin/zsh -lc 'cat hello.txt'",
      aggregated_output: "hello world",
      exit_code: 0,
      status: "completed",
    };

    expect(normalizeToolUse(item, process.cwd())).toEqual({
      name: "Read",
      input: { file_path: "hello.txt" },
    });
  });

  test("maps simple shell writes to Write tool with content", () => {
    const item: CommandExecutionItem = {
      id: "item_write_1",
      type: "command_execution",
      command: "/bin/zsh -lc \"printf 'hello world' > hello.txt\"",
      aggregated_output: "",
      exit_code: 0,
      status: "completed",
    };

    expect(normalizeToolUse(item, process.cwd())).toEqual({
      name: "Write",
      input: { file_path: "hello.txt", content: "hello world" },
    });
    expect(normalizeToolResult(item, process.cwd())).toEqual({
      isError: false,
      content: "Wrote hello.txt",
    });
  });

  test("maps heredoc writes to Write tool with content", () => {
    const item: CommandExecutionItem = {
      id: "item_write_2",
      type: "command_execution",
      command: "/bin/zsh -lc \"cat > hello.txt <<'EOF'\nhello world\nEOF\"",
      aggregated_output: "",
      exit_code: 0,
      status: "completed",
    };

    expect(normalizeToolUse(item, process.cwd())).toEqual({
      name: "Write",
      input: { file_path: "hello.txt", content: "hello world\n" },
    });
    expect(normalizeToolResult(item, process.cwd())).toEqual({
      isError: false,
      content: "Wrote hello.txt",
    });
  });

  test("maps cd-wrapped cat command to Read tool", () => {
    const item: CommandExecutionItem = {
      id: "item_1b",
      type: "command_execution",
      command: `cd ${process.cwd()} && cat hello.txt`,
      aggregated_output: "hello world",
      exit_code: 0,
      status: "completed",
    };

    expect(normalizeToolUse(item, process.cwd())).toEqual({
      name: "Read",
      input: { file_path: "hello.txt" },
    });
  });

  test("maps file additions to Write tool", () => {
    const item: FileChangeItem = {
      id: "item_2",
      type: "file_change",
      changes: [{ path: `${process.cwd()}/hello.txt`, kind: "add" }],
      status: "completed",
    };

    expect(normalizeToolUse(item, process.cwd())).toEqual({
      name: "Write",
      input: { file_path: "hello.txt" },
    });
    expect(normalizeToolResult(item, process.cwd())).toEqual({
      isError: false,
      content: "Applied file change: add hello.txt",
    });
  });

  test("synthesizes non-empty command results when stdout is empty", () => {
    const item: CommandExecutionItem = {
      id: "item_3",
      type: "command_execution",
      command: "/bin/zsh -lc 'touch hello.txt'",
      aggregated_output: "",
      exit_code: 0,
      status: "completed",
    };

    expect(normalizeToolResult(item, process.cwd())).toEqual({
      isError: false,
      content: "Command completed with exit code 0 (no output).",
    });
  });
});
