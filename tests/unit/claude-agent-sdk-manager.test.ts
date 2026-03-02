import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs, { rmSync } from "node:fs";
import path from "node:path";
import { ClaudeAgentSDKManager } from "../../server/claude-agent-sdk-manager";
import { ClaudeLogParser } from "../../server/claude-log-parser";
import { Logger } from "../../server/utils";

describe("ClaudeAgentSDKManager writeToLog timestamps", () => {
  let tempDir: string;
  let logger: Logger;
  let mockLogParser: ClaudeLogParser;

  beforeEach(async () => {
    tempDir = path.resolve("tests", "test-area", `temp-test-sdk-${Date.now()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });

    const logPath = path.join(tempDir, "test.log");
    logger = new Logger(logPath);

    mockLogParser = new ClaudeLogParser({
      logPath: path.join(tempDir, "mock.log"),
      codonId: "test-codon",
      parsingInterval: 100,
    });
  });

  afterEach(async () => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("writeToLog adds ISO 8601 timestamp to messages", async () => {
    const logFilePath = path.join(tempDir, "test-timestamps.jsonl");
    const logStream = fs.createWriteStream(logFilePath);

    const manager = new ClaudeAgentSDKManager(tempDir, tempDir, logger, mockLogParser);

    // Access private logStream and writeToLog via bracket notation
    // biome-ignore lint/suspicious/noExplicitAny: accessing private method for unit test
    (manager as any).logStream = logStream;

    const message = { type: "assistant", message: { id: "msg_test", role: "assistant" } };
    // biome-ignore lint/suspicious/noExplicitAny: accessing private method for unit test
    (manager as any).writeToLog(message);

    logStream.end();
    await new Promise<void>((resolve) => logStream.on("finish", resolve));

    const content = fs.readFileSync(logFilePath, "utf-8");
    const parsed = JSON.parse(content.trim());

    expect(parsed.timestamp).toBeDefined();
    expect(parsed.type).toBe("assistant");
    expect(parsed.message.id).toBe("msg_test");
    // Verify it's a valid ISO 8601 timestamp
    expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
  });

  test("writeToLog does not mutate the original message object", async () => {
    const logFilePath = path.join(tempDir, "test-no-mutation.jsonl");
    const logStream = fs.createWriteStream(logFilePath);

    const manager = new ClaudeAgentSDKManager(tempDir, tempDir, logger, mockLogParser);
    // biome-ignore lint/suspicious/noExplicitAny: accessing private method for unit test
    (manager as any).logStream = logStream;

    const message: Record<string, unknown> = { type: "system", subtype: "init" };
    // biome-ignore lint/suspicious/noExplicitAny: accessing private method for unit test
    (manager as any).writeToLog(message);

    // Original should not have timestamp added
    expect(message.timestamp).toBeUndefined();

    logStream.end();
    await new Promise<void>((resolve) => logStream.on("finish", resolve));
  });

  test("writeToLog writes multiple messages with distinct timestamps", async () => {
    const logFilePath = path.join(tempDir, "test-multi-timestamps.jsonl");
    const logStream = fs.createWriteStream(logFilePath);

    const manager = new ClaudeAgentSDKManager(tempDir, tempDir, logger, mockLogParser);
    // biome-ignore lint/suspicious/noExplicitAny: accessing private method for unit test
    (manager as any).logStream = logStream;

    const msg1 = { type: "system", subtype: "init" };
    const msg2 = { type: "assistant", message: { id: "msg_1" } };
    const msg3 = { type: "result", subtype: "success" };

    // biome-ignore lint/suspicious/noExplicitAny: accessing private method for unit test
    (manager as any).writeToLog(msg1);
    // biome-ignore lint/suspicious/noExplicitAny: accessing private method for unit test
    (manager as any).writeToLog(msg2);
    // biome-ignore lint/suspicious/noExplicitAny: accessing private method for unit test
    (manager as any).writeToLog(msg3);

    logStream.end();
    await new Promise<void>((resolve) => logStream.on("finish", resolve));

    const lines = fs.readFileSync(logFilePath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(3);

    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.timestamp).toBeDefined();
      expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
    }
  });
});
