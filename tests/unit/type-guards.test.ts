import { describe, test, expect } from "bun:test";
import { EventId } from "../../server/branded-types.js";
import {
  isPhaseStartedEvent,
  isPhaseCompletedEvent,
  isErrorEvent,
  isTokenUsageEvent,
  isAssistantActionEvent,
  isFileUpdatedEvent,
  isServerReadyEvent,
  isStateSnapshotEvent,
  isStartPhaseCommand,
  isSkipPhaseCommand,
  isRedoPhaseCommand,
  isNextPhaseCommand,
  isShutdownCommand,
} from "../../server/type-guards";

describe("Event type guards", () => {
  // Helper to create a valid event with required fields
  const createEvent = (type: string, data?: any) => ({
    id: EventId("test-id"),
    timestamp: new Date().toISOString(),
    type,
    data,
  });

  describe("isPhaseStartedEvent", () => {
    test("returns true for valid phase started event", () => {
      const event = createEvent("phase.started", {
        phaseId: "test-phase",
        phaseName: "Test Phase",
        phaseDescription: "Description",
      });
      expect(isPhaseStartedEvent(event)).toBe(true);
    });

    test("returns false for missing data", () => {
      const event = createEvent("phase.started");
      expect(isPhaseStartedEvent(event)).toBe(false);
    });

    test("returns false for missing phaseId", () => {
      const event = createEvent("phase.started", {
        phaseName: "Test Phase",
      });
      expect(isPhaseStartedEvent(event)).toBe(false);
    });

    test("returns false for wrong event type", () => {
      const event = createEvent("phase.completed", {
        phaseId: "test-phase",
        phaseName: "Test Phase",
      });
      expect(isPhaseStartedEvent(event)).toBe(false);
    });
  });

  describe("isErrorEvent", () => {
    test("returns true for valid error event", () => {
      const event = createEvent("error", {
        message: "Error occurred",
        fatal: false,
      });
      expect(isErrorEvent(event)).toBe(true);
    });

    test("returns false for missing message", () => {
      const event = createEvent("error", {
        fatal: false,
      });
      expect(isErrorEvent(event)).toBe(false);
    });

    test("handles events with null data", () => {
      const event = createEvent("error", null);
      expect(isErrorEvent(event)).toBe(false);
    });
  });

  describe("isPhaseCompletedEvent", () => {
    test("returns true for valid phase completed event", () => {
      const event = createEvent("phase.completed", {
        phaseId: "test-phase",
        phaseName: "Test Phase",
        success: true,
        skipped: false,
        duration: 1000,
      });
      expect(isPhaseCompletedEvent(event)).toBe(true);
    });

    test("returns false for missing required fields", () => {
      const event = createEvent("phase.completed", {
        phaseId: "test-phase",
        // Missing success field which is required
      });
      expect(isPhaseCompletedEvent(event)).toBe(false);
    });
  });

  describe("isTokenUsageEvent", () => {
    test("returns true for valid token usage event", () => {
      const event = createEvent("token.usage", {
        phaseId: "test-phase",
        inputTokens: 100, // Changed from 'input' to 'inputTokens'
        output: 200,
        cache: 50,
        total: 350,
        cost: 0.05,
      });
      expect(isTokenUsageEvent(event)).toBe(true);
    });

    test("returns false for missing cost", () => {
      const event = createEvent("token.usage", {
        phaseId: "test-phase",
        input: 100,
        output: 200,
        total: 300,
      });
      expect(isTokenUsageEvent(event)).toBe(false);
    });
  });

  describe("isAssistantActionEvent", () => {
    test("returns true for valid assistant action event", () => {
      const event = createEvent("assistant.action", {
        action: "write",
        params: { file: "test.txt" },
        result: "success",
      });
      expect(isAssistantActionEvent(event)).toBe(true);
    });

    test("returns false for missing action", () => {
      const event = createEvent("assistant.action", {
        params: {},
        result: "success",
      });
      expect(isAssistantActionEvent(event)).toBe(false);
    });
  });

  describe("isFileUpdatedEvent", () => {
    test("returns true for valid file updated event", () => {
      const event = createEvent("file.updated", {
        path: "/path/to/file.txt",
        changeType: "added",
        lastModified: "2024-01-01T00:00:00Z",
      });
      expect(isFileUpdatedEvent(event)).toBe(true);
    });

    test("returns false for invalid changeType", () => {
      const event = createEvent("file.updated", {
        // Missing required 'path' field
        changeType: "invalid",
        lastModified: "2024-01-01T00:00:00Z",
      });
      expect(isFileUpdatedEvent(event)).toBe(false);
    });
  });

  describe("isServerReadyEvent", () => {
    test("returns true for valid server ready event", () => {
      const event = createEvent("server.ready", {
        version: "1.0.0",
        projectPath: "/project",
      });
      expect(isServerReadyEvent(event)).toBe(true);
    });
  });

  describe("isStateSnapshotEvent", () => {
    test("returns true for valid state snapshot event", () => {
      const event = createEvent("state.snapshot", {
        phases: [],
        currentPhase: null,
        completedPhases: [],
        totalCost: 0,
        logs: [],
      });
      expect(isStateSnapshotEvent(event)).toBe(true);
    });

    test("returns false for missing required fields", () => {
      // isStateSnapshotEvent only checks the type, not data fields
      const event = createEvent("wrong.type", {
        phases: [],
        currentPhase: null,
      });
      expect(isStateSnapshotEvent(event)).toBe(false);
    });
  });
});

describe("Command type guards", () => {
  // Helper to create a valid command with required id
  const createCommand = (type: string, data?: any) => ({
    id: "test-command-id",
    type,
    data,
  });

  describe("isStartPhaseCommand", () => {
    test("returns true for valid start command", () => {
      const command = createCommand("phase.start", {
        phaseId: "test-phase",
      });
      expect(isStartPhaseCommand(command)).toBe(true);
    });

    test("returns false for missing phaseId", () => {
      const command = createCommand("phase.start", {});
      expect(isStartPhaseCommand(command)).toBe(false);
    });

    test("returns false for non-object data", () => {
      const command = createCommand("phase.start", "string");
      expect(isStartPhaseCommand(command)).toBe(false);
    });

    test("handles skipPreCommands field", () => {
      const command = createCommand("phase.start", {
        phaseId: "test-phase",
        skipPreCommands: true,
      });
      expect(isStartPhaseCommand(command)).toBe(true);
    });
  });

  describe("isSkipPhaseCommand", () => {
    test("returns true for valid skip command", () => {
      const command = createCommand("phase.skip");
      expect(isSkipPhaseCommand(command)).toBe(true);
    });

    test("returns false for wrong type", () => {
      const command = createCommand("phase.start");
      expect(isSkipPhaseCommand(command)).toBe(false);
    });
  });

  describe("isRedoPhaseCommand", () => {
    test("returns true for valid redo command", () => {
      const command = createCommand("phase.redo");
      expect(isRedoPhaseCommand(command)).toBe(true);
    });
  });

  describe("isNextPhaseCommand", () => {
    test("returns true for valid next command", () => {
      const command = createCommand("phase.next");
      expect(isNextPhaseCommand(command)).toBe(true);
    });
  });

  describe("isShutdownCommand", () => {
    test("returns true for valid shutdown command", () => {
      const command = createCommand("server.shutdown");
      expect(isShutdownCommand(command)).toBe(true);
    });
  });
});
