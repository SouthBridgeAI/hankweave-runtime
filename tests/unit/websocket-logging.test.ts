import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { rmSync } from "node:fs";
import * as path from "node:path";
import { EventId } from "../../server/types/branded-types";
import type { ClientCommand, ServerEvent } from "../../server/types/types";
import type { WebSocketLogEntry } from "../../server/types/websocket-log-types";
import { Logger } from "../../server/utils";
import {
  getWebSocketLogStats,
  readWebSocketLog,
  WebSocketLogReader,
} from "../../server/websocket-log-reader";

describe("WebSocket Logging", () => {
  let tempDir: string;
  let logPath: string;
  let logger: Logger;

  beforeEach(async () => {
    tempDir = path.resolve("tests", "test-area", `temp-test-ws-log-${Date.now()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });
    logPath = path.join(tempDir, "websocket.log");
    logger = new Logger(path.join(tempDir, "main.log"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("Logger.logSocketTraffic", () => {
    test("logs incoming messages in JSONL format", () => {
      const message: ClientCommand = {
        id: "cmd-123",
        type: "codon.start",
        data: { codonId: "codon-1" },
      };

      logger.logSocketTraffic(logPath, "in", message);

      const content = fs.readFileSync(logPath, "utf-8");
      const entry = JSON.parse(content.trim()) as WebSocketLogEntry;

      expect(entry.direction).toBe("in");
      expect(entry.message).toEqual(message);
      expect(entry.metadata?.size).toBe(JSON.stringify(message).length);
      expect(entry.loggedAt).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    });

    test("logs outgoing messages in JSONL format", () => {
      const message: ServerEvent = {
        id: EventId("evt-456"),
        timestamp: new Date().toISOString(),
        type: "server.ready",
        data: {
          serverVersion: "1.0.0",
          executionPath: "/path/to/execution",
          agentRootPath: "/path/to/execution/agentRoot",
          dataPath: "/path/to/execution/agentRoot/read_only_data_source",
        },
      };

      logger.logSocketTraffic(logPath, "out", message);

      const content = fs.readFileSync(logPath, "utf-8");
      const entry = JSON.parse(content.trim()) as WebSocketLogEntry;

      expect(entry.direction).toBe("out");
      expect(entry.message).toEqual(message);
      expect(entry.metadata?.size).toBe(JSON.stringify(message).length);
    });

    test("appends multiple messages as separate JSONL lines", () => {
      const message1: ClientCommand = {
        id: "cmd-1",
        type: "codon.start",
        data: { codonId: "codon-1" },
      };

      const message2: ServerEvent = {
        id: EventId("evt-1"),
        timestamp: new Date().toISOString(),
        type: "codon.started",
        data: {
          codonId: "codon-1",
          codonName: "Test Codon",
          sessionId: "session-123",
          startTime: new Date().toISOString(),
        },
      };

      logger.logSocketTraffic(logPath, "in", message1);
      logger.logSocketTraffic(logPath, "out", message2);

      const content = fs.readFileSync(logPath, "utf-8");
      const lines = content.trim().split("\n");

      expect(lines.length).toBe(2);

      const entry1 = JSON.parse(lines[0]) as WebSocketLogEntry;
      const entry2 = JSON.parse(lines[1]) as WebSocketLogEntry;

      expect(entry1.direction).toBe("in");
      expect(entry1.message.type).toBe("codon.start");

      expect(entry2.direction).toBe("out");
      expect(entry2.message.type).toBe("codon.started");
    });

    test("handles large messages", () => {
      const largeData = "x".repeat(10000);
      const message: ServerEvent = {
        id: EventId("evt-large"),
        timestamp: new Date().toISOString(),
        type: "file.updated",
        data: {
          path: "test.txt",
          filename: "test.txt",
          content: largeData,
          action: "modified" as const,
        },
      };

      logger.logSocketTraffic(logPath, "out", message);

      const content = fs.readFileSync(logPath, "utf-8");
      const entry = JSON.parse(content.trim()) as WebSocketLogEntry;

      expect(entry.message).toEqual(message);
      expect(entry.metadata?.size).toBeGreaterThan(10000);
    });

    test("handles special characters in messages", () => {
      const message: ServerEvent = {
        id: EventId("evt-special"),
        timestamp: new Date().toISOString(),
        type: "info",
        data: {
          message: 'Test with "quotes", \nnewlines, and \t\ttabs',
        },
      };

      logger.logSocketTraffic(logPath, "out", message);

      const content = fs.readFileSync(logPath, "utf-8");
      const entry = JSON.parse(content.trim()) as WebSocketLogEntry;

      expect(entry.message).toEqual(message);
    });
  });

  describe("WebSocketLogReader", () => {
    let reader: WebSocketLogReader;

    beforeEach(() => {
      reader = new WebSocketLogReader(logPath);
    });

    test("reads empty log file", async () => {
      fs.writeFileSync(logPath, "");
      const entries = await reader.readLog();
      expect(entries).toEqual([]);
    });

    test("reads non-existent log file", async () => {
      const entries = await reader.readLog();
      expect(entries).toEqual([]);
    });

    test("reads single entry", async () => {
      const entry: WebSocketLogEntry = {
        loggedAt: new Date().toISOString(),
        direction: "in",
        message: {
          id: "cmd-1",
          type: "codon.start",
          data: { codonId: "codon-1" },
          // biome-ignore lint/suspicious/noExplicitAny: Test mock data
        } as any,
        metadata: { size: 100 },
      };

      fs.writeFileSync(logPath, `${JSON.stringify(entry)}\n`);

      const entries = await reader.readLog();
      expect(entries.length).toBe(1);
      expect(entries[0]).toEqual(entry);
    });

    test("reads multiple entries", async () => {
      const entries: WebSocketLogEntry[] = [
        {
          loggedAt: "2025-01-19T10:00:00.000Z",
          direction: "in",
          // biome-ignore lint/suspicious/noExplicitAny: Test mock data
          message: { id: "cmd-1", type: "codon.start" } as any,
        },
        {
          loggedAt: "2025-01-19T10:00:01.000Z",
          direction: "out",
          message: {
            id: "evt-1",
            timestamp: "2025-01-19T10:00:01.000Z",
            type: "codon.started",
            // biome-ignore lint/suspicious/noExplicitAny: Test mock data
          } as any,
        },
        {
          loggedAt: "2025-01-19T10:00:02.000Z",
          direction: "out",
          message: {
            id: "evt-2",
            timestamp: "2025-01-19T10:00:02.000Z",
            type: "codon.completed",
            // biome-ignore lint/suspicious/noExplicitAny: Test mock data
          } as any,
        },
      ];

      const content = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
      fs.writeFileSync(logPath, content);

      const readEntries = await reader.readLog();
      expect(readEntries.length).toBe(3);
      expect(readEntries).toEqual(entries);
    });

    test("handles malformed lines gracefully", async () => {
      const validEntry: WebSocketLogEntry = {
        loggedAt: new Date().toISOString(),
        direction: "in",
        // biome-ignore lint/suspicious/noExplicitAny: Test mock data
        message: { id: "cmd-1", type: "codon.start" } as any,
      };

      const content = [
        "not valid json",
        JSON.stringify(validEntry),
        "{ broken json",
        "",
        JSON.stringify(validEntry),
      ].join("\n");

      fs.writeFileSync(logPath, content);

      const entries = await reader.readLog();
      expect(entries.length).toBe(2);
      expect(entries[0]).toEqual(validEntry);
      expect(entries[1]).toEqual(validEntry);
    });

    test("readLogSync works correctly", () => {
      const entry: WebSocketLogEntry = {
        loggedAt: new Date().toISOString(),
        direction: "out",
        message: {
          id: "evt-1",
          timestamp: new Date().toISOString(),
          type: "server.ready",
          // biome-ignore lint/suspicious/noExplicitAny: Test mock data
        } as any,
      };

      fs.writeFileSync(logPath, `${JSON.stringify(entry)}\n`);

      const entries = reader.readLogSync();
      expect(entries.length).toBe(1);
      expect(entries[0]).toEqual(entry);
    });
  });

  describe("WebSocketLogReader filtering", () => {
    let reader: WebSocketLogReader;

    beforeEach(async () => {
      reader = new WebSocketLogReader(logPath);

      const entries: WebSocketLogEntry[] = [
        {
          loggedAt: "2025-01-19T10:00:00.000Z",
          direction: "in",
          message: {
            id: "cmd-1",
            type: "codon.start",
            data: { codonId: "codon-1" },
            // biome-ignore lint/suspicious/noExplicitAny: Test mock data
          } as any,
        },
        {
          loggedAt: "2025-01-19T10:00:01.000Z",
          direction: "out",
          message: {
            id: "evt-1",
            timestamp: "2025-01-19T10:00:01.000Z",
            type: "codon.started",
            data: { codonId: "codon-1", sessionId: "session-123" },
            // biome-ignore lint/suspicious/noExplicitAny: Test mock data
          } as any,
        },
        {
          loggedAt: "2025-01-19T10:00:02.000Z",
          direction: "in",
          message: {
            id: "cmd-2",
            type: "codon.skip",
            // biome-ignore lint/suspicious/noExplicitAny: Test mock data
          } as any,
        },
        {
          loggedAt: "2025-01-19T10:00:03.000Z",
          direction: "out",
          message: {
            id: "evt-2",
            timestamp: "2025-01-19T10:00:03.000Z",
            type: "codon.completed",
            data: { codonId: "codon-1", success: false },
            // biome-ignore lint/suspicious/noExplicitAny: Test mock data
          } as any,
        },
        {
          loggedAt: "2025-01-19T10:00:04.000Z",
          direction: "in",
          message: {
            id: "cmd-3",
            type: "codon.start",
            data: { codonId: "codon-2" },
            // biome-ignore lint/suspicious/noExplicitAny: Test mock data
          } as any,
        },
        {
          loggedAt: "2025-01-19T10:00:05.000Z",
          direction: "out",
          message: {
            id: "evt-3",
            timestamp: "2025-01-19T10:00:05.000Z",
            type: "error",
            data: { message: "Test error", fatal: false },
            // biome-ignore lint/suspicious/noExplicitAny: Test mock data
          } as any,
        },
      ];

      const content = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
      fs.writeFileSync(logPath, content);
      await reader.readLog();
    });

    test("filterByDirection", () => {
      const incoming = reader.filterByDirection("in");
      const outgoing = reader.filterByDirection("out");

      expect(incoming.length).toBe(3);
      expect(outgoing.length).toBe(3);

      expect(incoming.every((e) => e.direction === "in")).toBe(true);
      expect(outgoing.every((e) => e.direction === "out")).toBe(true);
    });

    test("filterByMessageType", () => {
      const codonStarts = reader.filterByMessageType("codon.start");
      const errors = reader.filterByMessageType("error");

      expect(codonStarts.length).toBe(2);
      expect(errors.length).toBe(1);

      expect(codonStarts[0].message.type).toBe("codon.start");
      expect(errors[0].message.type).toBe("error");
    });

    test("filterByTimeRange", () => {
      const filtered = reader.filterByTimeRange(
        "2025-01-19T10:00:01.000Z",
        "2025-01-19T10:00:03.000Z",
      );

      expect(filtered.length).toBe(3);
      expect(filtered[0].loggedAt).toBe("2025-01-19T10:00:01.000Z");
      expect(filtered[2].loggedAt).toBe("2025-01-19T10:00:03.000Z");
    });

    test("getCodonMessages", () => {
      const codon1Messages = reader.getCodonMessages("codon-1");
      const codon2Messages = reader.getCodonMessages("codon-2");

      expect(codon1Messages.length).toBe(3);
      expect(codon2Messages.length).toBe(1);
    });

    test("getSessionMessages", () => {
      const sessionMessages = reader.getSessionMessages("session-123");
      expect(sessionMessages.length).toBe(1);
      expect(sessionMessages[0].message.type).toBe("codon.started");
    });

    test("getServerEvents", () => {
      const serverEvents = reader.getServerEvents();
      expect(serverEvents.length).toBe(3);
      expect(serverEvents.every((e) => e.direction === "out")).toBe(true);
    });

    test("getClientCommands", () => {
      const clientCommands = reader.getClientCommands();
      expect(clientCommands.length).toBe(3);
      expect(clientCommands.every((e) => e.direction === "in")).toBe(true);
    });
  });

  describe("WebSocketLogReader statistics", () => {
    let reader: WebSocketLogReader;

    beforeEach(async () => {
      reader = new WebSocketLogReader(logPath);

      const entries: WebSocketLogEntry[] = [
        {
          loggedAt: "2025-01-19T10:00:00.000Z",
          direction: "in",
          // biome-ignore lint/suspicious/noExplicitAny: Test mock data
          message: { id: "cmd-1", type: "codon.start" } as any,
          metadata: { size: 50 },
        },
        {
          loggedAt: "2025-01-19T10:00:01.000Z",
          direction: "out",
          message: {
            id: "evt-1",
            timestamp: "2025-01-19T10:00:01.000Z",
            type: "codon.started",
            // biome-ignore lint/suspicious/noExplicitAny: Test mock data
          } as any,
          metadata: { size: 100 },
        },
        {
          loggedAt: "2025-01-19T10:00:02.000Z",
          direction: "in",
          // biome-ignore lint/suspicious/noExplicitAny: Test mock data
          message: { id: "cmd-2", type: "codon.start" } as any,
          metadata: { size: 50 },
        },
        {
          loggedAt: "2025-01-19T10:00:03.000Z",
          direction: "out",
          message: {
            id: "evt-2",
            timestamp: "2025-01-19T10:00:03.000Z",
            type: "error",
            // biome-ignore lint/suspicious/noExplicitAny: Test mock data
          } as any,
          metadata: { size: 200 },
        },
      ];

      const content = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
      fs.writeFileSync(logPath, content);
      await reader.readLog();
    });

    test("calculates statistics correctly", () => {
      const stats = reader.getStatistics();

      expect(stats.totalEntries).toBe(4);
      expect(stats.incomingCount).toBe(2);
      expect(stats.outgoingCount).toBe(2);
      expect(stats.messageTypes["codon.start"]).toBe(2);
      expect(stats.messageTypes["codon.started"]).toBe(1);
      expect(stats.messageTypes.error).toBe(1);
      expect(stats.averageMessageSize).toBe(100);
      expect(stats.timeRange.start).toBe("2025-01-19T10:00:00.000Z");
      expect(stats.timeRange.end).toBe("2025-01-19T10:00:03.000Z");
    });

    test("handles empty log statistics", async () => {
      const emptyReader = new WebSocketLogReader(path.join(tempDir, "empty.log"));
      await emptyReader.readLog();
      const stats = emptyReader.getStatistics();

      expect(stats.totalEntries).toBe(0);
      expect(stats.incomingCount).toBe(0);
      expect(stats.outgoingCount).toBe(0);
      expect(stats.messageTypes).toEqual({});
      expect(stats.averageMessageSize).toBe(0);
      expect(stats.timeRange.start).toBeNull();
      expect(stats.timeRange.end).toBeNull();
    });
  });

  describe("WebSocketLogReader export", () => {
    let reader: WebSocketLogReader;

    beforeEach(async () => {
      reader = new WebSocketLogReader(logPath);

      const entries: WebSocketLogEntry[] = [
        {
          loggedAt: "2025-01-19T10:00:00.000Z",
          direction: "in",
          // biome-ignore lint/suspicious/noExplicitAny: Test mock data
          message: { id: "cmd-1", type: "codon.start" } as any,
        },
        {
          loggedAt: "2025-01-19T10:00:01.000Z",
          direction: "out",
          message: {
            id: "evt-1",
            timestamp: "2025-01-19T10:00:01.000Z",
            type: "error",
            data: { message: "Test error" },
            // biome-ignore lint/suspicious/noExplicitAny: Test mock data
          } as any,
        },
      ];

      const content = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
      fs.writeFileSync(logPath, content);
      await reader.readLog();
    });

    test("exports filtered entries to file", () => {
      const exportPath = path.join(tempDir, "export.jsonl");
      const errors = reader.filterByMessageType("error");

      reader.exportToFile(errors, exportPath);

      const exportedContent = fs.readFileSync(exportPath, "utf-8");
      const lines = exportedContent.trim().split("\n");

      expect(lines.length).toBe(1);
      const exported = JSON.parse(lines[0]) as WebSocketLogEntry;
      expect(exported.message.type).toBe("error");
    });
  });

  describe("WebSocketLogReader streaming", () => {
    test("streams large log files efficiently", async () => {
      // Create a large log file
      const entries: WebSocketLogEntry[] = [];
      for (let i = 0; i < 1000; i++) {
        entries.push({
          loggedAt: new Date(Date.now() + i * 1000).toISOString(),
          direction: i % 2 === 0 ? "in" : "out",
          message: {
            id: `msg-${i}`,
            type: i % 3 === 0 ? "error" : "info",
            ...(i % 2 === 1 ? { timestamp: new Date().toISOString() } : {}),
            // biome-ignore lint/suspicious/noExplicitAny: Test mock data
          } as any,
        });
      }

      const content = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
      fs.writeFileSync(logPath, content);

      const reader = new WebSocketLogReader(logPath);
      let errorCount = 0;
      let totalCount = 0;

      await reader.streamRead(async (entry) => {
        totalCount++;
        if (entry.message.type === "error") {
          errorCount++;
        }
      });

      expect(totalCount).toBe(1000);
      expect(errorCount).toBe(334); // Every 3rd entry is an error
    });

    test("handles stream errors gracefully", async () => {
      const content = [
        JSON.stringify({
          loggedAt: "2025-01-19T10:00:00.000Z",
          direction: "in",
          message: { id: "1", type: "test" },
        }),
        "invalid json line",
        JSON.stringify({
          loggedAt: "2025-01-19T10:00:01.000Z",
          direction: "out",
          message: {
            id: "2",
            type: "test",
            timestamp: "2025-01-19T10:00:01.000Z",
          },
        }),
      ].join("\n");

      fs.writeFileSync(logPath, content);

      const reader = new WebSocketLogReader(logPath);
      let count = 0;

      await reader.streamRead(async (_entry) => {
        count++;
      });

      expect(count).toBe(2); // Should process 2 valid entries
    });
  });

  describe("Helper functions", () => {
    test("readWebSocketLog helper", async () => {
      const entry: WebSocketLogEntry = {
        loggedAt: new Date().toISOString(),
        direction: "in",
        // biome-ignore lint/suspicious/noExplicitAny: Test mock data
        message: { id: "cmd-1", type: "codon.start" } as any,
      };

      fs.writeFileSync(logPath, `${JSON.stringify(entry)}\n`);

      const entries = await readWebSocketLog(logPath);
      expect(entries.length).toBe(1);
      expect(entries[0]).toEqual(entry);
    });

    test("getWebSocketLogStats helper", async () => {
      const entries: WebSocketLogEntry[] = [
        {
          loggedAt: "2025-01-19T10:00:00.000Z",
          direction: "in",
          // biome-ignore lint/suspicious/noExplicitAny: Test mock data
          message: { id: "cmd-1", type: "codon.start" } as any,
          metadata: { size: 100 },
        },
        {
          loggedAt: "2025-01-19T10:00:01.000Z",
          direction: "out",
          message: {
            id: "evt-1",
            timestamp: "2025-01-19T10:00:01.000Z",
            type: "codon.started",
            // biome-ignore lint/suspicious/noExplicitAny: Test mock data
          } as any,
          metadata: { size: 200 },
        },
      ];

      const content = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
      fs.writeFileSync(logPath, content);

      const stats = await getWebSocketLogStats(logPath);
      expect(stats.totalEntries).toBe(2);
      expect(stats.incomingCount).toBe(1);
      expect(stats.outgoingCount).toBe(1);
      expect(stats.averageMessageSize).toBe(150);
    });
  });

  describe("Real-world scenarios", () => {
    test("handles complete codon execution flow", async () => {
      const logger = new Logger(path.join(tempDir, "main.log"));
      const wsLogPath = path.join(tempDir, "websocket.log");

      // Simulate a complete codon execution
      // biome-ignore lint/suspicious/noExplicitAny: Test mock data array
      const messages: Array<[string, any]> = [
        ["in", { id: "cmd-1", type: "codon.start", data: { codonId: "codon-1" } }],
        [
          "out",
          {
            id: "evt-1",
            timestamp: new Date().toISOString(),
            type: "codon.started",
            data: {
              codonId: "codon-1",
              codonName: "Analysis",
              sessionId: "session-123",
              startTime: new Date().toISOString(),
            },
          },
        ],
        [
          "out",
          {
            id: "evt-2",
            timestamp: new Date().toISOString(),
            type: "assistant.action",
            data: {
              codonId: "codon-1",
              action: "tool_use" as const,
              content: "",
              toolName: "Read",
            },
          },
        ],
        [
          "out",
          {
            id: "evt-3",
            timestamp: new Date().toISOString(),
            type: "tool.result",
            data: {
              codonId: "codon-1",
              toolUseId: "tool-1",
              toolName: "Read",
              result: "File content",
              truncated: false,
              originalLength: 12,
              executionTimeMs: 45,
              isError: false,
            },
          },
        ],
        [
          "out",
          {
            id: "evt-4",
            timestamp: new Date().toISOString(),
            type: "token.usage",
            data: {
              codonId: "codon-1",
              inputTokens: 1000,
              outputTokens: 500,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              totalCost: 0.0045,
            },
          },
        ],
        [
          "out",
          {
            id: "evt-5",
            timestamp: new Date().toISOString(),
            type: "codon.completed",
            data: {
              codonId: "codon-1",
              success: true,
              cost: 0.0045,
              duration: 5000,
              exitStatus: { type: "success" },
            },
          },
        ],
      ];

      // Log all messages
      for (const [direction, message] of messages) {
        logger.logSocketTraffic(wsLogPath, direction as "in" | "out", message);
      }

      // Read and analyze the log
      const reader = new WebSocketLogReader(wsLogPath);
      await reader.readLog();

      // Verify the flow
      const codonMessages = reader.getCodonMessages("codon-1");
      expect(codonMessages.length).toBe(6);

      const stats = reader.getStatistics();
      expect(stats.totalEntries).toBe(6);
      expect(stats.messageTypes["codon.start"]).toBe(1);
      expect(stats.messageTypes["codon.completed"]).toBe(1);
      expect(stats.messageTypes["tool.result"]).toBe(1);

      // Check session tracking
      const sessionMessages = reader.getSessionMessages("session-123");
      expect(sessionMessages.length).toBe(1);
      expect(sessionMessages[0].message.type).toBe("codon.started");

      // Export codon messages for debugging
      const exportPath = path.join(tempDir, "codon-1-export.jsonl");
      reader.exportToFile(codonMessages, exportPath);
      expect(fs.existsSync(exportPath)).toBe(true);
    });

    test("handles error recovery scenario", async () => {
      const logger = new Logger(path.join(tempDir, "main.log"));
      const wsLogPath = path.join(tempDir, "websocket.log");

      // Simulate an error scenario with recovery
      // biome-ignore lint/suspicious/noExplicitAny: Test mock data array
      const messages: Array<[string, any]> = [
        ["in", { id: "cmd-1", type: "codon.start", data: { codonId: "codon-1" } }],
        [
          "out",
          {
            id: "evt-1",
            timestamp: new Date().toISOString(),
            type: "error",
            data: { message: "API timeout", fatal: false },
          },
        ],
        ["in", { id: "cmd-2", type: "codon.redo" }],
        [
          "out",
          {
            id: "evt-2",
            timestamp: new Date().toISOString(),
            type: "codon.started",
            data: {
              codonId: "codon-1",
              codonName: "Retry",
              sessionId: "session-456",
              startTime: new Date().toISOString(),
            },
          },
        ],
        [
          "out",
          {
            id: "evt-3",
            timestamp: new Date().toISOString(),
            type: "codon.completed",
            data: {
              codonId: "codon-1",
              success: true,
              cost: 0.001,
              duration: 3000,
              exitStatus: { type: "success" },
            },
          },
        ],
      ];

      for (const [direction, message] of messages) {
        logger.logSocketTraffic(wsLogPath, direction as "in" | "out", message);
      }

      const reader = new WebSocketLogReader(wsLogPath);
      await reader.readLog();

      // Analyze error recovery
      const errors = reader.filterByMessageType("error");
      expect(errors.length).toBe(1);

      const redoCommands = reader.filterByMessageType("codon.redo");
      expect(redoCommands.length).toBe(1);

      const completions = reader.filterByMessageType("codon.completed");
      expect(completions.length).toBe(1);

      // biome-ignore lint/suspicious/noExplicitAny: Test data access
      const completionData = (completions[0].message as any).data;
      expect(completionData?.success).toBe(true);
    });

    test("validates format migration from old format", async () => {
      const logger = new Logger(path.join(tempDir, "main.log"));
      const wsLogPath = path.join(tempDir, "websocket.log");

      // Log a message using the new format
      const message: ClientCommand = {
        id: "cmd-1",
        type: "codon.start",
        data: { codonId: "codon-1" },
      };

      logger.logSocketTraffic(wsLogPath, "in", message);

      // Verify the new format doesn't contain old markers
      const content = fs.readFileSync(wsLogPath, "utf-8");
      expect(content).not.toContain("[IN]");
      expect(content).not.toContain("[OUT]");

      // Verify it's valid JSONL
      const lines = content.trim().split("\n");
      expect(lines.length).toBe(1);
      expect(() => JSON.parse(lines[0])).not.toThrow();

      const entry = JSON.parse(lines[0]) as WebSocketLogEntry;
      expect(entry.direction).toBe("in");
      expect(entry.message).toEqual(message);
      expect(entry.loggedAt).toBeDefined();
      expect(entry.metadata?.size).toBe(JSON.stringify(message).length);
    });
  });
});
