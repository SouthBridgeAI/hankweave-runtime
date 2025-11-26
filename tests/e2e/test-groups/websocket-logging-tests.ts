import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  CodonCompletedEvent,
  CodonStartedEvent,
  ErrorEvent,
  ServerEvent,
} from "../../../server/types/types.js";
import type { WebSocketLogEntry } from "../../../server/types/websocket-log-types.js";
import { WebSocketLogReader } from "../../../server/websocket-log-reader.js";

interface TestState {
  executionPath?: string;
  events: ServerEvent[];
  codon1Started: CodonStartedEvent | null;
  codon1Completed: CodonCompletedEvent | null;
  codon2Started: CodonStartedEvent | null;
  codon2Completed: CodonCompletedEvent | null;
  codon3Started: CodonStartedEvent | null;
  codon3Completed: CodonCompletedEvent | null;
  errorEvents: ErrorEvent[];
}

export function runWebSocketLoggingTests(testState: TestState): void {
  const getWebSocketLogPath = () => {
    if (!testState.executionPath) {
      throw new Error("Execution path not available");
    }
    return path.join(testState.executionPath, ".strandweave/logs/websocket.log");
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

  it("should log codon.start commands", async () => {
    const logPath = getWebSocketLogPath();
    const reader = new WebSocketLogReader(logPath);
    await reader.readLog();

    const codonStartCommands = reader.filterByMessageType("codon.start");
    // May have codon.start commands if not using autostart
    if (codonStartCommands.length > 0) {
      codonStartCommands.forEach((cmd) => {
        expect(cmd.direction).toBe("in");
        expect(cmd.message.type).toBe("codon.start");
      });
    }
  });

  it("should log codon lifecycle events", async () => {
    const logPath = getWebSocketLogPath();
    const reader = new WebSocketLogReader(logPath);
    await reader.readLog();

    // Check codon.started events
    const codonStartedEvents = reader.filterByMessageType("codon.started");
    expect(codonStartedEvents.length).toBe(3); // 3 codons

    codonStartedEvents.forEach((event) => {
      expect(event.direction).toBe("out");
      expect(event.message.type).toBe("codon.started");
    });

    // Check codon.completed events
    const codonCompletedEvents = reader.filterByMessageType("codon.completed");
    expect(codonCompletedEvents.length).toBe(3); // 3 codons

    codonCompletedEvents.forEach((event) => {
      expect(event.direction).toBe("out");
      expect(event.message.type).toBe("codon.completed");
    });
  });

  it("should track messages for each codon", async () => {
    const logPath = getWebSocketLogPath();
    const reader = new WebSocketLogReader(logPath);
    await reader.readLog();

    // Codon 1 messages
    const codon1Messages = reader.getCodonMessages("codon-1");
    expect(codon1Messages.length).toBeGreaterThan(0);

    // Codon 2 messages
    const codon2Messages = reader.getCodonMessages("codon-2");
    expect(codon2Messages.length).toBeGreaterThan(0);

    // Codon 3 messages
    const codon3Messages = reader.getCodonMessages("codon-3");
    expect(codon3Messages.length).toBeGreaterThan(0);
  });

  it("should track session IDs", async () => {
    const logPath = getWebSocketLogPath();
    const reader = new WebSocketLogReader(logPath);
    await reader.readLog();

    // Get session IDs from codon started events
    const codonStartedEvents = reader.filterByMessageType("codon.started");
    const sessionIds = new Set<string>();

    codonStartedEvents.forEach((event) => {
      if (event.message.type === "codon.started") {
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

    // Export codon 1 messages
    const codon1Messages = reader.getCodonMessages("codon-1");
    if (!testState.executionPath) {
      throw new Error("Execution path not available");
    }
    const exportPath = path.join(testState.executionPath, ".strandweave/logs/codon-1-export.jsonl");

    reader.exportToFile(codon1Messages, exportPath);

    // Verify export file exists and is valid
    expect(fs.existsSync(exportPath)).toBe(true);

    // Read exported file
    const exportedContent = fs.readFileSync(exportPath, "utf-8");
    const exportedLines = exportedContent.trim().split("\n");

    expect(exportedLines.length).toBe(codon1Messages.length);

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

  it("should track message flow for complete codon execution", async () => {
    const logPath = getWebSocketLogPath();
    const reader = new WebSocketLogReader(logPath);
    await reader.readLog();

    // For each codon, verify the expected message flow
    ["codon-1", "codon-2", "codon-3"].forEach((codonId) => {
      const codonMessages = reader.getCodonMessages(codonId);

      // Should have codon.started
      const started = codonMessages.find((m) => {
        if (m.message.type === "codon.started") {
          return m.message.data?.codonId === codonId;
        }
        return false;
      });
      expect(started).toBeDefined();

      // Should have codon.completed
      const completed = codonMessages.find((m) => {
        if (m.message.type === "codon.completed") {
          return m.message.data?.codonId === codonId;
        }
        return false;
      });
      expect(completed).toBeDefined();

      // Should have some activity between start and complete
      const activityMessages = codonMessages.filter(
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
