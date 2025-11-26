import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { HistoryManager, simpleTokenCounter } from "../../server/sentinels/history-manager";
import { CodonId } from "../../server/types/branded-types";
import { Logger } from "../../server/utils";

// Mock logger for testing
class MockLogger extends Logger {
  logs: Array<{ message: string; level: string }> = [];

  constructor() {
    super("/dev/null"); // Use a dummy file path
  }

  log(message: string, level: "info" | "error" | "debug" = "info"): void {
    this.logs.push({ message, level });
  }
}

describe("HistoryManager", () => {
  let testDir: string;
  let logger: MockLogger;

  beforeEach(async () => {
    // Create a temporary directory for testing
    const tempBase = tmpdir();
    testDir = path.join(tempBase, `test-sentinels-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    logger = new MockLogger();
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("Basic Operations", () => {
    test("should create a HistoryManager and add message pairs", async () => {
      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 10 },
        testDir,
        logger,
      );

      await historyManager.addMessagePair("Hello, how are you?", "I'm doing well, thank you!");
      const messages = await historyManager.getMessagesToSend("You are a helpful assistant.");

      expect(messages).toHaveLength(3);
      expect(messages[0]).toEqual({
        role: "system",
        content: "You are a helpful assistant.",
      });
      expect(messages[1]).toEqual({
        role: "user",
        content: "Hello, how are you?",
      });
      expect(messages[2]).toEqual({
        role: "assistant",
        content: "I'm doing well, thank you!",
      });
    });

    test("should handle multiple conversation turns", async () => {
      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 10 },
        testDir,
        logger,
      );

      await historyManager.addMessagePair("First question", "First answer");
      await historyManager.addMessagePair("Second question", "Second answer");

      const messages = await historyManager.getMessagesToSend("System prompt");
      expect(messages).toHaveLength(5); // system + 2 pairs
    });
  });

  describe("History Loading", () => {
    test("should load history from existing file", async () => {
      // Create a pre-populated history file with codon-scoped naming
      const historyPath = path.join(testDir, "test-sentinel-codon-test-codon.json");
      const existingHistory = [
        { role: "user", content: "Previous question" },
        { role: "assistant", content: "Previous answer" },
      ];
      await fs.writeFile(historyPath, JSON.stringify(existingHistory, null, 2));

      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 10 },
        testDir,
        logger,
      );

      const messages = await historyManager.getMessagesToSend("System prompt");
      expect(messages).toHaveLength(3); // system + user + assistant
      expect(messages[1]).toEqual({
        role: "user",
        content: "Previous question",
      });
      expect(messages[2]).toEqual({
        role: "assistant",
        content: "Previous answer",
      });
    });

    test("should handle invalid history file", async () => {
      const historyPath = path.join(testDir, "test-sentinel-codon-test-codon.json");
      await fs.writeFile(historyPath, "invalid json");

      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 10 },
        testDir,
        logger,
      );

      // Should start fresh
      const messages = await historyManager.getMessagesToSend("System prompt");
      expect(messages).toHaveLength(1); // Only system prompt
    });
  });

  describe("maxTurns Pruning", () => {
    test("should prune old turns when exceeding maxTurns", async () => {
      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 2 },
        testDir,
        logger,
      );

      // Add 3 turns
      await historyManager.addMessagePair("Turn 1 user", "Turn 1 assistant");
      await historyManager.addMessagePair("Turn 2 user", "Turn 2 assistant");
      await historyManager.addMessagePair("Turn 3 user", "Turn 3 assistant");

      const messages = await historyManager.getMessagesToSend("System prompt");

      // Should only have system + 2 most recent turns (5 messages total)
      expect(messages).toHaveLength(5); // system + 2 turns * 2
      expect(messages[1]).toEqual({
        role: "user",
        content: "Turn 2 user",
      });
      expect(messages[3]).toEqual({
        role: "user",
        content: "Turn 3 user",
      });
    });
  });

  describe("maxTokens Pruning", () => {
    test("should prune old messages when exceeding maxTokens", async () => {
      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTokens", maxTokens: 20 }, // ~80 chars
        testDir,
        logger,
      );

      // Add messages that exceed token limit
      await historyManager.addMessagePair(
        "This is a very long message with many characters that will exceed our limit",
        "This is another very long message with even more characters",
      );
      await historyManager.addMessagePair("Short msg", "Another short");

      const messages = await historyManager.getMessagesToSend("System prompt");

      // Should have pruned oldest messages to stay under limit
      expect(messages.length).toBeLessThanOrEqual(3); // System + some recent messages

      // Verify last message is the most recent
      const lastMessage = messages[messages.length - 1];
      expect(lastMessage.content).toBe("Another short");
    });

    test("should calculate tokens correctly", () => {
      expect(simpleTokenCounter("1234")).toBe(1);
      expect(simpleTokenCounter("12345")).toBe(2);
      expect(simpleTokenCounter("12345678")).toBe(2);
      expect(simpleTokenCounter("123456789")).toBe(3);
    });
  });

  describe("Memory-Only Mode", () => {
    test("should work without directory (memory-only mode)", async () => {
      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 10 },
        undefined, // No directory
        logger,
      );

      await historyManager.addMessagePair("Message 1", "Response 1");

      const messages = await historyManager.getMessagesToSend("System prompt");
      expect(messages).toHaveLength(3);

      // Check that no file was created (using codon-scoped naming)
      const historyPath = path.join(testDir, "test-sentinel-codon-test-codon.json");
      await expect(fs.access(historyPath)).rejects.toThrow();
    });
  });

  describe("Persistence and Recovery", () => {
    test("should save history after message pair addition", async () => {
      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 10 },
        testDir,
        logger,
      );

      await historyManager.addMessagePair("Question", "Answer");

      // Check that file was created (with codon-scoped naming)
      const historyPath = path.join(testDir, "test-sentinel-codon-test-codon.json");
      const content = await fs.readFile(historyPath, "utf-8");
      const savedHistory = JSON.parse(content);

      expect(savedHistory).toHaveLength(2);
      // New format stores {message, tokens} objects
      expect(savedHistory[0]).toEqual({
        message: {
          role: "user",
          content: "Question",
        },
        tokens: undefined,
      });
      expect(savedHistory[1]).toEqual({
        message: {
          role: "assistant",
          content: "Answer",
        },
        tokens: undefined,
      });
    });

    test("should use atomic writes", async () => {
      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 10 },
        testDir,
        logger,
      );

      await historyManager.addMessagePair("Question", "Answer");

      // Temp file should not exist after successful write (codon-scoped naming)
      const tempPath = path.join(testDir, "test-sentinel-codon-test-codon.json.tmp");
      await expect(fs.access(tempPath)).rejects.toThrow();
    });

    test("should recover history across instances", async () => {
      // First instance
      const historyManager1 = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 10 },
        testDir,
        logger,
      );

      await historyManager1.addMessagePair("Question 1", "Answer 1");

      // Second instance
      const historyManager2 = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 10 },
        testDir,
        logger,
      );

      const messages = await historyManager2.getMessagesToSend("System prompt");
      expect(messages).toHaveLength(3);
      expect(messages[1].content).toBe("Question 1");
      expect(messages[2].content).toBe("Answer 1");
    });
  });

  describe("Message Type Validation", () => {
    test("should filter out invalid messages when loading", async () => {
      const historyPath = path.join(testDir, "test-sentinel-codon-test-codon.json");
      // Use only 1 invalid message (< 20% corruption threshold: 1/9 = 11%)
      const mixedHistory = [
        { role: "user", content: "Valid user message 1" },
        { role: "assistant", content: "Valid assistant message 1" },
        { role: "user", content: "Valid user message 2" },
        { role: "assistant", content: "Valid assistant message 2" },
        { role: "user", content: "Valid user message 3" },
        { role: "assistant", content: "Valid assistant message 3" },
        { role: "user", content: "Valid user message 4" },
        { role: "assistant", content: "Valid assistant message 4" },
        { invalid: "structure" }, // Only 1 invalid message = 11% corruption
      ];
      await fs.writeFile(historyPath, JSON.stringify(mixedHistory, null, 2));

      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 10 },
        testDir,
        logger,
      );

      const messages = await historyManager.getMessagesToSend("System prompt");
      // Should have system + 8 valid messages (1 invalid filtered out)
      expect(messages).toHaveLength(9); // system + 4 valid turns
      expect(messages[1].role).toBe("user");
      expect(messages[2].role).toBe("assistant");

      // Verify error logging occurred for invalid messages
      const errorLogs = logger.logs.filter((log) => log.level === "error");
      expect(errorLogs.length).toBeGreaterThan(0);
    });
  });

  describe("System Prompt Handling", () => {
    test("should always include fresh system prompt as first message", async () => {
      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 10 },
        testDir,
        logger,
      );

      await historyManager.addMessagePair("Question", "Answer");

      // First call with one system prompt
      const messages1 = await historyManager.getMessagesToSend("System prompt 1");
      expect(messages1[0]).toEqual({
        role: "system",
        content: "System prompt 1",
      });

      // Second call with different system prompt
      const messages2 = await historyManager.getMessagesToSend("System prompt 2");
      expect(messages2[0]).toEqual({
        role: "system",
        content: "System prompt 2",
      });
    });
  });

  describe("Skip Pruning Option", () => {
    test("should skip pruning when requested", async () => {
      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 1 },
        testDir,
        logger,
      );

      // Add 2 turns (exceeds max)
      await historyManager.addMessagePair("Turn 1 user", "Turn 1 assistant");
      await historyManager.addMessagePair("Turn 2 user", "Turn 2 assistant");

      // Get messages without pruning
      const messages = await historyManager.getMessagesToSend("System prompt", true);

      // Should have all messages
      expect(messages).toHaveLength(5); // system + 2 complete turns
    });
  });

  describe("Token Count Storage", () => {
    test("should store actual token counts when provided", async () => {
      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 10 },
        testDir,
        logger,
      );

      // Add message pair with token counts
      await historyManager.addMessagePair("Question", "Answer", 100, 50);

      // Verify tokens were saved in file
      const historyPath = path.join(testDir, "test-sentinel-codon-test-codon.json");
      const content = await fs.readFile(historyPath, "utf-8");
      const savedHistory = JSON.parse(content);

      expect(savedHistory[0].tokens).toBe(100);
      expect(savedHistory[1].tokens).toBe(50);
    });

    test("should use actual token counts for pruning when available", async () => {
      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTokens", maxTokens: 40 }, // Threshold to trigger pruning
        testDir,
        logger,
      );

      // Add messages with explicit token counts
      await historyManager.addMessagePair("Message 1", "Response 1", 60, 50); // 110 total - way over
      await historyManager.addMessagePair("Message 2", "Response 2", 15, 10); // 25 total - fits

      const messages = await historyManager.getMessagesToSend("System prompt");

      // With 135 tokens total and maxTokens of 40:
      // - Prunes until under 40
      // - Removes Message 1 (60 tokens) → 75 tokens remaining
      // - Removes Response 1 (50 tokens) → 25 tokens remaining
      // - Keeps Message 2 (15) + Response 2 (10) = 25 tokens ✓
      expect(messages).toHaveLength(3); // system + 1 pair
      expect(messages[1].content).toBe("Message 2");
      expect(messages[2].content).toBe("Response 2");
    });

    test("should handle backward compatibility with old format (no tokens)", async () => {
      const historyPath = path.join(testDir, "test-sentinel-codon-test-codon.json");
      const oldFormatHistory = [
        { role: "user", content: "Old format user" },
        { role: "assistant", content: "Old format assistant" },
      ];
      await fs.writeFile(historyPath, JSON.stringify(oldFormatHistory, null, 2));

      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 10 },
        testDir,
        logger,
      );

      const messages = await historyManager.getMessagesToSend("System prompt");
      expect(messages).toHaveLength(3);
      expect(messages[1].content).toBe("Old format user");
    });
  });

  describe("Corruption Detection", () => {
    test("should detect and handle high corruption rate (>20%)", async () => {
      const historyPath = path.join(testDir, "test-sentinel-codon-test-codon.json");
      // 3 invalid out of 5 = 60% corruption (exceeds 20% threshold)
      const corruptHistory = [
        { role: "user", content: "Valid message" },
        { invalid: "structure 1" },
        { invalid: "structure 2" },
        { role: "assistant", content: "Valid response" },
        { invalid: "structure 3" },
      ];
      await fs.writeFile(historyPath, JSON.stringify(corruptHistory, null, 2));

      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 10 },
        testDir,
        logger,
      );

      const messages = await historyManager.getMessagesToSend("System prompt");
      // Should start fresh due to high corruption
      expect(messages).toHaveLength(1); // Only system prompt

      // Verify corruption was logged
      const corruptionLogs = logger.logs.filter(
        (log) => log.level === "error" && log.message.includes("60.0%"),
      );
      expect(corruptionLogs.length).toBeGreaterThan(0);
    });

    test("should handle low corruption rate (<20%) gracefully", async () => {
      const historyPath = path.join(testDir, "test-sentinel-codon-test-codon.json");
      // 1 invalid out of 10 = 10% corruption (under threshold)
      const slightlyCorruptHistory = [
        { role: "user", content: "Message 1" },
        { role: "assistant", content: "Response 1" },
        { role: "user", content: "Message 2" },
        { role: "assistant", content: "Response 2" },
        { role: "user", content: "Message 3" },
        { role: "assistant", content: "Response 3" },
        { role: "user", content: "Message 4" },
        { role: "assistant", content: "Response 4" },
        { role: "user", content: "Message 5" },
        { invalid: "one bad message" }, // 10% corruption
      ];
      await fs.writeFile(historyPath, JSON.stringify(slightlyCorruptHistory, null, 2));

      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 10 },
        testDir,
        logger,
      );

      const messages = await historyManager.getMessagesToSend("System prompt");
      // Should load valid messages despite corruption
      expect(messages).toHaveLength(10); // system + 9 valid messages (1 filtered)

      // Verify corruption percentage was logged at "error" level (not "info")
      const corruptionLogs = logger.logs.filter(
        (log) => log.level === "error" && log.message.includes("10.0%"),
      );
      expect(corruptionLogs.length).toBeGreaterThan(0);
    });
  });

  describe("Structured Output Support", () => {
    test("should accept objects in addMessagePair and stringify them", async () => {
      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 10 },
        testDir,
        logger,
      );

      const userObj = { query: "test" };
      const assistantObj = { result: "success", count: 42 };

      await historyManager.addMessagePair(userObj, assistantObj, 10, 20);

      const messages = await historyManager.getMessagesToSend("System");
      expect(messages[1].content).toBe(JSON.stringify(userObj));
      expect(messages[2].content).toBe(JSON.stringify(assistantObj));
    });

    test("should handle mixed string and object history", async () => {
      const historyManager = new HistoryManager(
        "test-sentinel",
        CodonId("test-codon"),
        { type: "maxTurns", maxTurns: 10 },
        testDir,
        logger,
      );

      await historyManager.addMessagePair("string user", "string assistant");
      await historyManager.addMessagePair({ obj: "user" }, { obj: "assistant" });

      const messages = await historyManager.getMessagesToSend("System");
      expect(messages[1].content).toBe("string user");
      expect(messages[3].content).toBe('{"obj":"user"}');
    });
  });
});
