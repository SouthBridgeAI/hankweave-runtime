import { describe, expect, it } from "bun:test";
import { type ServerEvent, serverEventDataSchemas } from "../../server/schemas/event-schemas";

describe("Event Schema Synchronization", () => {
  it("should have schemas for all event types", () => {
    // This test ensures we don't forget to update schemas when adding new events
    const eventTypes: ServerEvent["type"][] = [
      "server.ready",
      "state.snapshot",
      "codon.started",
      "codon.completed",
      "assistant.action",
      "token.usage",
      "tool.result",
      "file.updated",
      "filetree.updated",
      "rig.setup.completed",
      "rig.setup.failed",
      "rig.output",
      "error",
      "incomplete.codon",
      "info",
      "server.idle",
      "checkpoint.list",
      "rollback.started",
      "rollback.codonCheckpoint",
      "rollback.rigCleanup",
      "rollback.progress",
      "rollback.completed",
    ];

    for (const eventType of eventTypes) {
      expect(serverEventDataSchemas[eventType]).toBeDefined();
    }
  });

  it("should validate sample events correctly", () => {
    // Test a sample event
    const sampleEvent = {
      codonId: "test-codon",
      action: "message",
      content: "Test content",
    };

    const schema = serverEventDataSchemas["assistant.action"];
    const result = schema.safeParse(sampleEvent);
    expect(result.success).toBe(true);
  });

  it("requires join keys on tool_use assistant.action, presence-based", () => {
    const schema = serverEventDataSchemas["assistant.action"];
    const base = { codonId: "c1", action: "tool_use", content: "" };

    // Fingerprint events join to receipts via toolUseId — a tool_use without
    // it (or toolName) must fail validation.
    expect(schema.safeParse({ ...base, toolName: "Write" }).success).toBe(false);
    expect(schema.safeParse({ ...base, toolUseId: "toolu_1" }).success).toBe(false);
    expect(schema.safeParse({ ...base, toolName: "Write", toolUseId: "toolu_1" }).success).toBe(
      true,
    );
    // toolName is presence-based: the session-log parser accepts an empty
    // tool name, so the derived event must validate too. toolUseId is the
    // correlation key and must be non-empty.
    expect(schema.safeParse({ ...base, toolName: "", toolUseId: "toolu_1" }).success).toBe(true);
    expect(schema.safeParse({ ...base, toolName: "Write", toolUseId: "" }).success).toBe(false);
    // Non-tool actions need no join keys.
    expect(schema.safeParse({ codonId: "c1", action: "thinking", content: "x" }).success).toBe(
      true,
    );
  });

  it("file.updated is fingerprint-only", () => {
    const schema = serverEventDataSchemas["file.updated"];
    const fingerprint = {
      path: "notes/plan.md",
      filename: "plan.md",
      action: "modified",
      sha256: "a".repeat(64),
      bytes: 12,
      source: { kind: "tool_use", toolUseId: "toolu_1" },
    };
    expect(schema.safeParse(fingerprint).success).toBe(true);
    // The old inline-body and contentRef forms are gone.
    const { sha256: _s, bytes: _b, source: _src, ...bare } = fingerprint;
    expect(schema.safeParse({ ...bare, content: "body" }).success).toBe(false);
  });
});
