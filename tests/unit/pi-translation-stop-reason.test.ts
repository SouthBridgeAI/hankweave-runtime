/**
 * Pi emits stopReason "stop" | "length" | "toolUse" | "error" | "aborted".
 * The translation layer once matched claude-style names instead, so every
 * assistant message fell through to "end_turn" — tool-call and token-limit
 * messages logged incorrect JSONL events. These tests pin the mapping the
 * removed shim's translator used: stop→end_turn, length→max_tokens,
 * toolUse→tool_use, error/aborted/unknown→null.
 */

import { describe, expect, test } from "bun:test";
import { makeAssistantMessage, type PiAssistantMessage } from "../../server/pi-translation.js";

function translate(stopReason: string | undefined) {
  const message: PiAssistantMessage = { role: "assistant", content: [], stopReason };
  return makeAssistantMessage(message, "pi/fake-model", new Map()).message.stop_reason;
}

describe("pi stop reason translation", () => {
  test("maps pi's native stop reasons to claude-schema vocabulary", () => {
    expect(translate("stop")).toBe("end_turn");
    expect(translate("length")).toBe("max_tokens");
    expect(translate("toolUse")).toBe("tool_use");
  });

  test("error, aborted, and unknown reasons map to null", () => {
    expect(translate("error")).toBeNull();
    expect(translate("aborted")).toBeNull();
    expect(translate("something-new")).toBeNull();
    expect(translate(undefined)).toBeNull();
  });
});
