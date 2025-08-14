import { describe, expect, it } from "bun:test";
import { type ServerEvent, serverEventDataSchemas } from "../../server/schemas/event-schemas.js";

describe("Event Schema Synchronization", () => {
  it("should have schemas for all event types", () => {
    // This test ensures we don't forget to update schemas when adding new events
    const eventTypes: ServerEvent["type"][] = [
      "server.ready",
      "state.snapshot",
      "phase.started",
      "phase.completed",
      "assistant.action",
      "token.usage",
      "tool.result",
      "file.updated",
      "filetree.updated",
      "error",
      "incomplete.phase",
      "info",
      "server.idle",
      "checkpoint.list",
      "rollback.started",
      "rollback.phaseCheckpoint",
      "rollback.workspaceCleanup",
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
      phaseId: "test-phase",
      action: "message",
      content: "Test content",
    };

    const schema = serverEventDataSchemas["assistant.action"];
    const result = schema.safeParse(sampleEvent);
    expect(result.success).toBe(true);
  });
});
