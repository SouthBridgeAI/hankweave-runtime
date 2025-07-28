import { describe, expect, test } from "bun:test";
import { PhaseId } from "../../server/branded-types";
import { clientCommandSchema } from "../../server/command-schemas";

describe("Rollback Command Schemas", () => {
  describe("checkpoint.list command", () => {
    test("validates checkpoint.list with no data", () => {
      const command = {
        id: "test-123",
        type: "checkpoint.list",
      };

      const result = clientCommandSchema.safeParse(command);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe("checkpoint.list");
      }
    });

    test("validates checkpoint.list with runId", () => {
      const command = {
        id: "test-123",
        type: "checkpoint.list",
        data: {
          runId: "1234567890-abc",
        },
      };

      const result = clientCommandSchema.safeParse(command);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe("checkpoint.list");
        if (result.data.type === "checkpoint.list") {
          expect(result.data.data?.runId).toBe("1234567890-abc");
        }
      }
    });

    test("validates checkpoint.list with empty data object", () => {
      const command = {
        id: "test-123",
        type: "checkpoint.list",
        data: {},
      };

      const result = clientCommandSchema.safeParse(command);
      expect(result.success).toBe(true);
    });
  });

  describe("phase.forceStop command", () => {
    test("validates phase.forceStop with no data", () => {
      const command = {
        id: "test-123",
        type: "phase.forceStop",
      };

      const result = clientCommandSchema.safeParse(command);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe("phase.forceStop");
      }
    });

    test("validates phase.forceStop with reason", () => {
      const command = {
        id: "test-123",
        type: "phase.forceStop",
        data: {
          reason: "User requested stop",
        },
      };

      const result = clientCommandSchema.safeParse(command);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe("phase.forceStop");
        if (result.data.type === "phase.forceStop") {
          expect(result.data.data?.reason).toBe("User requested stop");
        }
      }
    });
  });

  describe("rollback.toCheckpoint command", () => {
    test("validates rollback.toCheckpoint with required fields", () => {
      const command = {
        id: "test-123",
        type: "rollback.toCheckpoint",
        data: {
          checkpointSha: "abc123def",
        },
      };

      const result = clientCommandSchema.safeParse(command);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe("rollback.toCheckpoint");
        if (result.data.type === "rollback.toCheckpoint") {
          expect(result.data.data.checkpointSha).toBe("abc123def");
          expect(result.data.data.autoRestart).toBe(false); // default
        }
      }
    });

    test("validates rollback.toCheckpoint with autoRestart", () => {
      const command = {
        id: "test-123",
        type: "rollback.toCheckpoint",
        data: {
          checkpointSha: "abc123def",
          autoRestart: true,
        },
      };

      const result = clientCommandSchema.safeParse(command);
      expect(result.success).toBe(true);
      if (result.success && result.data.type === "rollback.toCheckpoint") {
        expect(result.data.data.autoRestart).toBe(true);
      }
    });

    test("rejects rollback.toCheckpoint without checkpointSha", () => {
      const command = {
        id: "test-123",
        type: "rollback.toCheckpoint",
        data: {},
      };

      const result = clientCommandSchema.safeParse(command);
      expect(result.success).toBe(false);
    });
  });

  describe("rollback.toPhase command", () => {
    test("validates rollback.toPhase with all checkpoint types", () => {
      const checkpointTypes: Array<
        "start" | "end" | "workspace-setup" | "completed" | "error" | "skipped"
      > = ["start", "end", "workspace-setup", "completed", "error", "skipped"];

      for (const checkpointType of checkpointTypes) {
        const command = {
          id: "test-123",
          type: "rollback.toPhase",
          data: {
            phaseId: "phase-1",
            checkpointType,
          },
        };

        const result = clientCommandSchema.safeParse(command);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.type).toBe("rollback.toPhase");
          if (result.data.type === "rollback.toPhase") {
            expect(result.data.data.phaseId).toBe(PhaseId("phase-1"));
            expect(result.data.data.checkpointType).toBe(checkpointType);
            expect(result.data.data.autoRestart).toBe(false); // default
          }
        }
      }
    });

    test("validates rollback.toPhase with autoRestart", () => {
      const command = {
        id: "test-123",
        type: "rollback.toPhase",
        data: {
          phaseId: "phase-1",
          checkpointType: "completed",
          autoRestart: true,
        },
      };

      const result = clientCommandSchema.safeParse(command);
      expect(result.success).toBe(true);
      if (result.success && result.data.type === "rollback.toPhase") {
        expect(result.data.data.autoRestart).toBe(true);
      }
    });

    test("rejects rollback.toPhase with invalid checkpoint type", () => {
      const command = {
        id: "test-123",
        type: "rollback.toPhase",
        data: {
          phaseId: "phase-1",
          checkpointType: "invalid-type",
        },
      };

      const result = clientCommandSchema.safeParse(command);
      expect(result.success).toBe(false);
    });

    test("rejects rollback.toPhase without required fields", () => {
      const command = {
        id: "test-123",
        type: "rollback.toPhase",
        data: {
          phaseId: "phase-1",
          // missing checkpointType
        },
      };

      const result = clientCommandSchema.safeParse(command);
      expect(result.success).toBe(false);
    });
  });

  describe("rollback.toLastSuccess command", () => {
    test("validates rollback.toLastSuccess with no data", () => {
      const command = {
        id: "test-123",
        type: "rollback.toLastSuccess",
      };

      const result = clientCommandSchema.safeParse(command);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe("rollback.toLastSuccess");
      }
    });

    test("validates rollback.toLastSuccess with autoRestart false", () => {
      const command = {
        id: "test-123",
        type: "rollback.toLastSuccess",
        data: {
          autoRestart: false,
        },
      };

      const result = clientCommandSchema.safeParse(command);
      expect(result.success).toBe(true);
      if (result.success && result.data.type === "rollback.toLastSuccess") {
        expect(result.data.data?.autoRestart).toBe(false);
      }
    });

    test("validates rollback.toLastSuccess with autoRestart true", () => {
      const command = {
        id: "test-123",
        type: "rollback.toLastSuccess",
        data: {
          autoRestart: true,
        },
      };

      const result = clientCommandSchema.safeParse(command);
      expect(result.success).toBe(true);
      if (result.success && result.data.type === "rollback.toLastSuccess") {
        expect(result.data.data?.autoRestart).toBe(true);
      }
    });

    test("validates rollback.toLastSuccess with empty data object", () => {
      const command = {
        id: "test-123",
        type: "rollback.toLastSuccess",
        data: {},
      };

      const result = clientCommandSchema.safeParse(command);
      expect(result.success).toBe(true);
      if (result.success && result.data.type === "rollback.toLastSuccess") {
        // Should use default value
        expect(result.data.data?.autoRestart).toBe(false);
      }
    });
  });

  describe("Command ID validation", () => {
    test("rejects commands without id", () => {
      const command = {
        type: "checkpoint.list",
      };

      const result = clientCommandSchema.safeParse(command);
      expect(result.success).toBe(false);
    });

    test("rejects commands with non-string id", () => {
      const command = {
        id: 123,
        type: "checkpoint.list",
      };

      const result = clientCommandSchema.safeParse(command);
      expect(result.success).toBe(false);
    });
  });

  describe("Unknown command types", () => {
    test("rejects unknown command types", () => {
      const command = {
        id: "test-123",
        type: "unknown.command",
      };

      const result = clientCommandSchema.safeParse(command);
      expect(result.success).toBe(false);
    });
  });
});
