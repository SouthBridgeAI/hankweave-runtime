import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ErrorEvent,
  PhaseCompletedEvent,
  PhaseStartedEvent,
  ServerEvent,
} from "../../../server/types/types.js";
import type { WebSocketLogEntry } from "../../../server/types/websocket-log-types.js";
import { WebSocketLogReader } from "../../../server/websocket-log-reader.js";

interface TestState {
  executionPath?: string;
  events: ServerEvent[];
  phase1Started: PhaseStartedEvent | null;
  phase1Completed: PhaseCompletedEvent | null;
  phase2Started: PhaseStartedEvent | null;
  phase2Completed: PhaseCompletedEvent | null;
  phase3Started: PhaseStartedEvent | null;
  phase3Completed: PhaseCompletedEvent | null;
  errorEvents: ErrorEvent[];
}

export function runWebSocketLoggingTests(testState: TestState): void {
  const getWebSocketLogPath = () => {
    if (!testState.executionPath) {
      throw new Error("Execution path not available");
    }
    return path.join(testState.executionPath, ".tadpole/logs/websocket.log");
  };

  it("should create websocket.log file", () => {
    const logPath = getWebSocketLogPath();
    expect(fs.existsSync(logPath)).toBe(true);
  });

  it("should log messages in JSONL format", async () => {
    const logPath = getWebSocketLogPath();
    const reader = new WebSocketLogReader(logPath);
    const entries = await reader.readLog();

    // Should have entries
    expect(entries.length).toBeGreaterThan(0);

    // Each entry should be valid
    entries.forEach((entry) => {
      expect(entry).toHaveProperty("loggedAt");
      expect(entry).toHaveProperty("direction");
      expect(entry).toHaveProperty("message");
      expect(["in", "out"]).toContain(entry.direction);
    });
  });

  it("should log server.ready event", async () => {
    const logPath = getWebSocketLogPath();
    const reader = new WebSocketLogReader(logPath);
    await reader.readLog();

    const serverReadyEvents = reader.filterByMessageType("server.ready");
    expect(serverReadyEvents.length).toBeGreaterThan(0);

    const serverReady = serverReadyEvents[0];
    expect(serverReady.direction).toBe("out");
    expect(serverReady.message.type).toBe("server.ready");
  });

  it("should log phase.start commands", async () => {
    const logPath = getWebSocketLogPath();
    const reader = new WebSocketLogReader(logPath);
    await reader.readLog();

    const phaseStartCommands = reader.filterByMessageType("phase.start");
    // May have phase.start commands if not using autostart
    if (phaseStartCommands.length > 0) {
      phaseStartCommands.forEach((cmd) => {
        expect(cmd.direction).toBe("in");
        expect(cmd.message.type).toBe("phase.start");
      });
    }
  });

  it("should log phase lifecycle events", async () => {
    const logPath = getWebSocketLogPath();
    const reader = new WebSocketLogReader(logPath);
    await reader.readLog();

    // Check phase.started events
    const phaseStartedEvents = reader.filterByMessageType("phase.started");
    expect(phaseStartedEvents.length).toBe(3); // 3 phases

    phaseStartedEvents.forEach((event) => {
      expect(event.direction).toBe("out");
      expect(event.message.type).toBe("phase.started");
    });

    // Check phase.completed events
    const phaseCompletedEvents = reader.filterByMessageType("phase.completed");
    expect(phaseCompletedEvents.length).toBe(3); // 3 phases

    phaseCompletedEvents.forEach((event) => {
      expect(event.direction).toBe("out");
      expect(event.message.type).toBe("phase.completed");
    });
  });

  it("should track messages for each phase", async () => {
    const logPath = getWebSocketLogPath();
    const reader = new WebSocketLogReader(logPath);
    await reader.readLog();

    // Phase 1 messages
    const phase1Messages = reader.getPhaseMessages("phase-1");
    expect(phase1Messages.length).toBeGreaterThan(0);

    // Phase 2 messages
    const phase2Messages = reader.getPhaseMessages("phase-2");
    expect(phase2Messages.length).toBeGreaterThan(0);

    // Phase 3 messages
    const phase3Messages = reader.getPhaseMessages("phase-3");
    expect(phase3Messages.length).toBeGreaterThan(0);
  });

  it("should track session IDs", async () => {
    const logPath = getWebSocketLogPath();
    const reader = new WebSocketLogReader(logPath);
    await reader.readLog();

    // Get session IDs from phase started events
    const phaseStartedEvents = reader.filterByMessageType("phase.started");
    const sessionIds = new Set<string>();

    phaseStartedEvents.forEach((event) => {
      if (event.message.type === "phase.started") {
        const data = event.message.data;
        if (data?.sessionId) {
          sessionIds.add(data.sessionId);
        }
      }
    });

    // Should have at least one session ID
    expect(sessionIds.size).toBeGreaterThan(0);

    // Check messages for each session
    sessionIds.forEach((sessionId) => {
      const sessionMessages = reader.getSessionMessages(sessionId);
      expect(sessionMessages.length).toBeGreaterThan(0);
    });
  });

  it("should log assistant.action events", async () => {
    const logPath = getWebSocketLogPath();
    const reader = new WebSocketLogReader(logPath);
    await reader.readLog();

    const assistantActions = reader.filterByMessageType("assistant.action");
    expect(assistantActions.length).toBeGreaterThan(0);

    assistantActions.forEach((action) => {
      expect(action.direction).toBe("out");
      expect(action.message.type).toBe("assistant.action");
    });
  });

  it("should log token.usage events", async () => {
    const logPath = getWebSocketLogPath();
    const reader = new WebSocketLogReader(logPath);
    await reader.readLog();

    const tokenUsageEvents = reader.filterByMessageType("token.usage");
    expect(tokenUsageEvents.length).toBeGreaterThan(0);

    tokenUsageEvents.forEach((event) => {
      expect(event.direction).toBe("out");
      expect(event.message.type).toBe("token.usage");
    });
  });

  it("should log tool.result events", async () => {
    const logPath = getWebSocketLogPath();
    const reader = new WebSocketLogReader(logPath);
    await reader.readLog();

    const toolResultEvents = reader.filterByMessageType("tool.result");
    // Tool results are expected in this test
    expect(toolResultEvents.length).toBeGreaterThan(0);

    toolResultEvents.forEach((event) => {
      expect(event.direction).toBe("out");
      expect(event.message.type).toBe("tool.result");

      if (event.message.type === "tool.result") {
        const data = event.message.data;
        expect(data).toHaveProperty("toolUseId");
        expect(data).toHaveProperty("toolName");
        expect(data).toHaveProperty("executionTimeMs");
      }
    });
  });

  it("should log file.updated events", async () => {
    const logPath = getWebSocketLogPath();
    const reader = new WebSocketLogReader(logPath);
    await reader.readLog();

    const fileUpdatedEvents = reader.filterByMessageType("file.updated");
    // File updates are expected when Claude creates files
    expect(fileUpdatedEvents.length).toBeGreaterThan(0);

    fileUpdatedEvents.forEach((event) => {
      expect(event.direction).toBe("out");
      expect(event.message.type).toBe("file.updated");

      if (event.message.type === "file.updated") {
        const data = event.message.data;
        expect(data).toHaveProperty("path");
        expect(data).toHaveProperty("action");
        expect(["created", "modified", "deleted"]).toContain(data.action);
      }
    });
  });

  it("should include metadata with message sizes", async () => {
    const logPath = getWebSocketLogPath();
    const reader = new WebSocketLogReader(logPath);
    await reader.readLog();

    const stats = reader.getStatistics();

    // Should have calculated average message size
    expect(stats.averageMessageSize).toBeGreaterThan(0);

    // Check some entries have metadata
    const entries = reader.getEntries();
    const entriesWithMetadata = entries.filter((e) => e.metadata?.size);
    expect(entriesWithMetadata.length).toBeGreaterThan(0);
  });

  it("should maintain chronological order", async () => {
    const logPath = getWebSocketLogPath();
    const reader = new WebSocketLogReader(logPath);
    const entries = await reader.readLog();

    // Check that timestamps are in order
    for (let i = 1; i < entries.length; i++) {
      const prevTime = new Date(entries[i - 1].loggedAt).getTime();
      const currTime = new Date(entries[i].loggedAt).getTime();
      expect(currTime).toBeGreaterThanOrEqual(prevTime);
    }
  });

  it("should calculate statistics correctly", async () => {
    const logPath = getWebSocketLogPath();
    const reader = new WebSocketLogReader(logPath);
    await reader.readLog();

    const stats = reader.getStatistics();

    expect(stats.totalEntries).toBeGreaterThan(0);
    expect(stats.incomingCount).toBeGreaterThanOrEqual(0);
    expect(stats.outgoingCount).toBeGreaterThan(0);
    expect(stats.messageTypes).toBeDefined();

    // Should have various message types
    expect(Object.keys(stats.messageTypes).length).toBeGreaterThan(0);

    // Time range should be set
    expect(stats.timeRange.start).toBeDefined();
    expect(stats.timeRange.end).toBeDefined();

    if (stats.timeRange.start && stats.timeRange.end) {
      const duration =
        new Date(stats.timeRange.end).getTime() - new Date(stats.timeRange.start).getTime();
      expect(duration).toBeGreaterThan(0);
    }
  });

  it("should separate client commands and server events", async () => {
    const logPath = getWebSocketLogPath();
    const reader = new WebSocketLogReader(logPath);
    await reader.readLog();

    const clientCommands = reader.getClientCommands();
    const serverEvents = reader.getServerEvents();

    // All client commands should be incoming
    clientCommands.forEach((cmd) => {
      expect(cmd.direction).toBe("in");
    });

    // All server events should be outgoing
    serverEvents.forEach((event) => {
      expect(event.direction).toBe("out");
    });

    // Should have more server events than client commands (due to streaming events)
    expect(serverEvents.length).toBeGreaterThan(clientCommands.length);
  });

  it("should be able to export filtered logs", async () => {
    const logPath = getWebSocketLogPath();
    const reader = new WebSocketLogReader(logPath);
    await reader.readLog();

    // Export phase 1 messages
    const phase1Messages = reader.getPhaseMessages("phase-1");
    if (!testState.executionPath) {
      throw new Error("Execution path not available");
    }
    const exportPath = path.join(testState.executionPath, ".tadpole/logs/phase-1-export.jsonl");

    reader.exportToFile(phase1Messages, exportPath);

    // Verify export file exists and is valid
    expect(fs.existsSync(exportPath)).toBe(true);

    // Read exported file
    const exportedContent = fs.readFileSync(exportPath, "utf-8");
    const exportedLines = exportedContent.trim().split("\n");

    expect(exportedLines.length).toBe(phase1Messages.length);

    // Each line should be valid JSON
    exportedLines.forEach((line) => {
      const entry = JSON.parse(line) as WebSocketLogEntry;
      expect(entry).toHaveProperty("loggedAt");
      expect(entry).toHaveProperty("direction");
      expect(entry).toHaveProperty("message");
    });
  });

  it("should handle streaming read for large logs", async () => {
    const logPath = getWebSocketLogPath();
    const reader = new WebSocketLogReader(logPath);

    let streamedCount = 0;
    const messageTypes = new Set<string>();

    await reader.streamRead(async (entry) => {
      streamedCount++;
      messageTypes.add(entry.message.type);
    });

    // Should have processed entries
    expect(streamedCount).toBeGreaterThan(0);
    expect(messageTypes.size).toBeGreaterThan(0);

    // Streamed count should match total entries
    const entries = await reader.readLog();
    expect(streamedCount).toBe(entries.length);
  });

  it("should track message flow for complete phase execution", async () => {
    const logPath = getWebSocketLogPath();
    const reader = new WebSocketLogReader(logPath);
    await reader.readLog();

    // For each phase, verify the expected message flow
    ["phase-1", "phase-2", "phase-3"].forEach((phaseId) => {
      const phaseMessages = reader.getPhaseMessages(phaseId);

      // Should have phase.started
      const started = phaseMessages.find((m) => {
        if (m.message.type === "phase.started") {
          return m.message.data?.phaseId === phaseId;
        }
        return false;
      });
      expect(started).toBeDefined();

      // Should have phase.completed
      const completed = phaseMessages.find((m) => {
        if (m.message.type === "phase.completed") {
          return m.message.data?.phaseId === phaseId;
        }
        return false;
      });
      expect(completed).toBeDefined();

      // Should have some activity between start and complete
      const activityMessages = phaseMessages.filter(
        (m) =>
          m.message.type === "assistant.action" ||
          m.message.type === "token.usage" ||
          m.message.type === "tool.result",
      );
      expect(activityMessages.length).toBeGreaterThan(0);
    });
  });

  it("should not contain old format markers", async () => {
    const logPath = getWebSocketLogPath();
    const content = fs.readFileSync(logPath, "utf-8");

    // Should not contain old format markers
    expect(content).not.toContain("[IN]");
    expect(content).not.toContain("[OUT]");

    // Should be valid JSONL (each line is valid JSON)
    const lines = content.trim().split("\n");
    lines.forEach((line) => {
      expect(() => JSON.parse(line)).not.toThrow();
    });
  });
}
