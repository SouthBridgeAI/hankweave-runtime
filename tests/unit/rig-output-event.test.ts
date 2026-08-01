import { describe, expect, test } from "bun:test";
import { rigOutputEventDataSchema } from "../../server/schemas/event-schemas";

describe("rig.output event", () => {
  test("schema validates a well-formed stdout event", () => {
    const data = {
      codonId: "generate-and-review#0",
      stream: "stdout",
      line: "[3/16] panel-02  Saved: panel-02.png (9.8MB)",
      commandIndex: 0,
    };
    const result = rigOutputEventDataSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  test("schema validates a stderr event", () => {
    const data = {
      codonId: "read-and-explore",
      stream: "stderr",
      line: "Warning: both GOOGLE_API_KEY and GEMINI_API_KEY are set",
      commandIndex: 1,
    };
    const result = rigOutputEventDataSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  test("schema rejects invalid stream value", () => {
    const data = {
      codonId: "test",
      stream: "stdin",
      line: "hello",
      commandIndex: 0,
    };
    const result = rigOutputEventDataSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  test("schema rejects missing codonId", () => {
    const data = {
      stream: "stdout",
      line: "hello",
      commandIndex: 0,
    };
    const result = rigOutputEventDataSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  test("schema rejects negative commandIndex", () => {
    const data = {
      codonId: "test",
      stream: "stdout",
      line: "hello",
      commandIndex: -1,
    };
    const result = rigOutputEventDataSchema.safeParse(data);
    expect(result.success).toBe(false);
  });
});
