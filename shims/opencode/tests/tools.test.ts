import { describe, expect, test } from "bun:test";
import { extractToolResultContent, normalizeToolInput, normalizeToolName } from "../src/utils/tools.js";

describe("tool normalization", () => {
  test("normalizes known tool names", () => {
    expect(normalizeToolName("write")).toBe("Write");
    expect(normalizeToolName("ls")).toBe("LS");
  });

  test("converts camelCase tool input to snake_case", () => {
    expect(normalizeToolInput("Write", { filePath: "a.txt", content: "hello" })).toEqual({
      file_path: "a.txt",
      content: "hello",
    });
  });

  test("never emits empty bash result text", () => {
    expect(
      extractToolResultContent("Bash", {
        status: "completed",
        output: "",
        metadata: { exit: 0, output: "" },
      }),
    ).toBe("Command completed successfully with no output.");
  });

  test("turns non-zero bash exits into error tool results", () => {
    expect(
      extractToolResultContent("Bash", {
        status: "completed",
        output: "boom",
        metadata: { exit: 2 },
      }),
    ).toEqual({ is_error: true, error: "Exit code 2: boom" });
  });
});
