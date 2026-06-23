import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs, { rmSync } from "node:fs";
import path from "node:path";
import {
  ClaudeAgentSDKManager,
  DEFAULT_SDK_IDLE_TIMEOUT_SECONDS,
} from "../../server/claude-agent-sdk-manager";
import { ClaudeLogParser } from "../../server/claude-log-parser";
import { classifyApiErrorText } from "../../server/error-classification";
import { IdleTimeoutError, Logger } from "../../server/utils";

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

describe("ClaudeAgentSDKManager idle timeout", () => {
  let tempDir: string;
  let logger: Logger;
  let mockLogParser: ClaudeLogParser;

  beforeEach(async () => {
    tempDir = path.resolve("tests", "test-area", `temp-test-sdk-idle-${Date.now()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });
    logger = new Logger(path.join(tempDir, "test.log"));
    mockLogParser = new ClaudeLogParser({
      logPath: path.join(tempDir, "mock.log"),
      codonId: "test-codon",
      parsingInterval: 100,
    });
  });

  afterEach(async () => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("default is applied when neither codon nor runtime sets shimIdleTimeout", () => {
    const manager = new ClaudeAgentSDKManager(tempDir, tempDir, logger, mockLogParser);
    // biome-ignore lint/suspicious/noExplicitAny: accessing private field for unit test
    const defaultTimeout = (manager as any).defaultShimIdleTimeout;
    expect(defaultTimeout ?? DEFAULT_SDK_IDLE_TIMEOUT_SECONDS).toBe(
      DEFAULT_SDK_IDLE_TIMEOUT_SECONDS,
    );
    expect(DEFAULT_SDK_IDLE_TIMEOUT_SECONDS).toBe(180);
  });

  test("runtime default takes precedence over the built-in default", () => {
    const manager = new ClaudeAgentSDKManager(
      tempDir,
      tempDir,
      logger,
      mockLogParser,
      undefined,
      null,
      300,
    );
    // biome-ignore lint/suspicious/noExplicitAny: accessing private field for unit test
    expect((manager as any).defaultShimIdleTimeout).toBe(300);
  });

  test("writeSyntheticErrorResult writes a parseable, retriable error result", async () => {
    const logFilePath = path.join(tempDir, "synthetic-result.jsonl");
    const logStream = fs.createWriteStream(logFilePath);

    const manager = new ClaudeAgentSDKManager(tempDir, tempDir, logger, mockLogParser);
    // biome-ignore lint/suspicious/noExplicitAny: accessing private method for unit test
    (manager as any).logStream = logStream;
    // biome-ignore lint/suspicious/noExplicitAny: accessing private field for unit test
    (manager as any).sessionId = "session-123";

    const timeoutError = new IdleTimeoutError(DEFAULT_SDK_IDLE_TIMEOUT_SECONDS * 1000);
    // biome-ignore lint/suspicious/noExplicitAny: accessing private method for unit test
    await (manager as any).writeSyntheticErrorResult(timeoutError.message);

    logStream.end();
    await new Promise<void>((resolve) => logStream.on("finish", resolve));

    const parsed = JSON.parse(fs.readFileSync(logFilePath, "utf-8").trim());
    expect(parsed.type).toBe("result");
    expect(parsed.subtype).toBe("error");
    expect(parsed.is_error).toBe(true);
    expect(parsed.session_id).toBe("session-123");
    expect(parsed.result).toContain("Idle timeout");

    // The runtime classifies this result text — it must come out retriable
    // so onFailure: "retry" fires after an idle-timeout abort.
    const reason = classifyApiErrorText(parsed.result);
    expect(reason).toMatchObject({ type: "timeout", retriable: true });
  });

  test("writeSyntheticErrorResult is a no-op without a log stream", async () => {
    const manager = new ClaudeAgentSDKManager(tempDir, tempDir, logger, mockLogParser);
    // biome-ignore lint/suspicious/noExplicitAny: accessing private method for unit test
    await expect((manager as any).writeSyntheticErrorResult("boom")).resolves.toBeUndefined();
  });
});
