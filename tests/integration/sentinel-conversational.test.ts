import { describe, it, expect, beforeAll, afterEach } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import { sentinelConfigSchema } from "../../server/config-validation/sentinel.schema.js";
import { SentinelManager } from "../../server/sentinels/sentinel-manager.js";
import { Sentinel } from "../../server/sentinels/sentinel.js";
import { HistoryManager } from "../../server/sentinels/history-manager.js";
import { CodonId } from "../../server/types/branded-types.js";
import type { SentinelConfig } from "../../server/types/sentinel-types.js";
import type { StrandweaveModelMessage } from "../../server/types/input-ai-types.js";
import type {
  StrandweaveGenerateTextOptions,
  StrandweaveGenerateTextResult,
} from "../../server/types/llm-call-types.js";
import { Logger } from "../../server/utils.js";
import { createMockLlm } from "../utils/mock-llm.js";

// --- Test Setup ---
const SENTINEL_CONFIGS_DIR = path.resolve(process.cwd(), "tests/config/sentinel-triggers");
const TEMP_SENTINEL_DIR = path.resolve(process.cwd(), "tests/test-area/temp-sentinels");

// Helper to load a Sentinel config from our test files
function loadSentinelConfig(fileName: string) {
  const filePath = path.join(SENTINEL_CONFIGS_DIR, fileName);
  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const config = JSON.parse(fileContent);
  // Validate it before using to catch schema errors
  return sentinelConfigSchema.parse(config);
}

// Enhanced mock logger that tracks all log messages
class TestLogger extends Logger {
  public logs: Array<{ message: string; level: string }> = [];

  constructor() {
    super("/dev/null"); // Use a dummy file path
  }

  log(message: string, level: "info" | "error" | "debug" = "info"): void {
    this.logs.push({ message, level });
  }

  clear(): void {
    this.logs = [];
  }

  hasLog(pattern: string | RegExp, level?: string): boolean {
    return this.logs.some(log => {
      const messageMatches = typeof pattern === 'string'
        ? log.message.includes(pattern)
        : pattern.test(log.message);
      const levelMatches = level ? log.level === level : true;
      return messageMatches && levelMatches;
    });
  }

  getLogsContaining(pattern: string | RegExp): Array<{ message: string; level: string }> {
    return this.logs.filter(log => {
      return typeof pattern === 'string'
        ? log.message.includes(pattern)
        : pattern.test(log.message);
    });
  }
}

// Create a shared mock LLM instance for all tests
const mockLlmProvider = createMockLlm();

// Helper function to create an LLM adapter for sentinels
function createLlmAdapter(callTracker?: Array<{ id: string; options: StrandweaveGenerateTextOptions }>) {
  return async (id: string, options: StrandweaveGenerateTextOptions): Promise<StrandweaveGenerateTextResult> => {
    // Track the call if a tracker is provided
    if (callTracker) {
      callTracker.push({ id, options });
    }

    // Use the mock LLM to generate the response
    const result = await mockLlmProvider.generateText(options);
    return result;
  };
}

// Ensure temp directories exist for test logs and sentinel data
beforeAll(() => {
  if (!fs.existsSync(TEMP_SENTINEL_DIR)) {
    fs.mkdirSync(TEMP_SENTINEL_DIR, { recursive: true });
  }
});

// Clean up temp sentinel directory after each test
afterEach(async () => {
  try {
    await fsPromises.rm(TEMP_SENTINEL_DIR, { recursive: true, force: true });
    await fsPromises.mkdir(TEMP_SENTINEL_DIR, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe("Conversational Sentinel Integration Tests", () => {

  describe("Conversational Configuration", () => {
    it("should load conversational configuration correctly", () => {
      const config = loadSentinelConfig("conversational-narrator.json");

      expect(config.conversational).toBeDefined();
      expect(config.conversational?.trimmingStrategy.type).toBe("maxTurns");
      if (config.conversational?.trimmingStrategy.type === "maxTurns") {
        expect(config.conversational.trimmingStrategy.maxTurns).toBe(5);
      }
      expect(config.systemPromptText).toBeDefined();
    });

    it("should reject conversational config without system prompt", () => {
      const invalidConfig = {
        id: "invalid-conversational",
        name: "Invalid Conversational",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: { type: "event", on: ["codon.started"] },
        execution: { strategy: "immediate" },
        userPromptText: "Test prompt",
        conversational: {
          trimmingStrategy: { type: "maxTurns", maxTurns: 5 }
        }
      };

      expect(() => sentinelConfigSchema.parse(invalidConfig)).toThrow(
        /Conversational sentinels require a system prompt/
      );
    });
  });

  describe("HistoryManager Creation", () => {
    it("should create HistoryManager for conversational sentinels", async () => {
      const logger = new TestLogger();
      const config = loadSentinelConfig("conversational-narrator.json");

      // Create sentinel with test directory
      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        createLlmAdapter(),
        logger,
        TEMP_SENTINEL_DIR
      );

      // Check that HistoryManager was created
      const historyManager = sentinel.getHistoryManager();
      expect(historyManager).toBeInstanceOf(HistoryManager);

      // Check logs for initialization
      expect(logger.hasLog("Initialized conversational mode")).toBe(true);
      expect(logger.hasLog("maxTurns trimming")).toBe(true);
    });

    it("should not create HistoryManager for non-conversational sentinels", async () => {
      const logger = new TestLogger();
      const config = loadSentinelConfig("narrator.json");

      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        createLlmAdapter(),
        logger,
        TEMP_SENTINEL_DIR
      );

      // Check that HistoryManager was NOT created
      const historyManager = sentinel.getHistoryManager();
      expect(historyManager).toBeUndefined();

      // Should not have conversational logs
      expect(logger.hasLog("conversational mode")).toBe(false);
    });
  });

  describe("Persistence Across Triggers", () => {
    it("should persist history across multiple trigger executions", async () => {
      const logger = new TestLogger();
      const testSentinelDir = path.join(TEMP_SENTINEL_DIR, "test-persistence");
      await fsPromises.mkdir(testSentinelDir, { recursive: true });

      const config = loadSentinelConfig("conversational-narrator.json");

      // Track LLM calls
      const llmCalls: Array<{ id: string; options: StrandweaveGenerateTextOptions }> = [];
      const mockLlm = createLlmAdapter(llmCalls);

      // Create first sentinel instance
      const sentinel1 = new Sentinel(config, CodonId("test-codon"), mockLlm, logger, testSentinelDir);
      const historyManager1 = sentinel1.getHistoryManager();
      expect(historyManager1).toBeDefined();

      // Simulate first batch of events
      if (historyManager1) {
        await historyManager1.addMessagePair("First batch of events", "First response");
      }

      // Check that history was saved (with codon-scoped naming)
      const historyPath = path.join(testSentinelDir, "conversational-narrator-codon-test-codon.json");
      await new Promise(resolve => setTimeout(resolve, 100)); // Give time for async save
      expect(fs.existsSync(historyPath)).toBe(true);

      // Create second sentinel instance (simulating server restart)
      logger.clear();
      const sentinel2 = new Sentinel(config, CodonId("test-codon"), mockLlm, logger, testSentinelDir);
      const historyManager2 = sentinel2.getHistoryManager();
      expect(historyManager2).toBeDefined();

      // Check that history was loaded
      if (historyManager2) {
        const messages = await historyManager2.getMessagesToSend("System prompt");
        expect(messages.length).toBe(3); // system + user + assistant
        expect(messages[1].content).toBe("First batch of events");
        expect(messages[2].content).toBe("First response");
      }

      // Verify logs
      expect(logger.hasLog("Loaded 2 messages from file")).toBe(true);
    });
  });

  describe("Directory Management", () => {
    it("should create sentinel directory when loading conversational sentinels", async () => {
      const logger = new TestLogger();
      const manager = new SentinelManager({ 
        logger, 
        enablePersistence: true,
        rootDirectory: TEMP_SENTINEL_DIR 
      });

      const config = loadSentinelConfig("conversational-narrator.json");

      await manager.loadSentinelsForCodon([config], CodonId("test-codon"), {
        llmCallOverride: createLlmAdapter(),
      });

      // Check that manager logged directory creation
      expect(logger.hasLog("sentinel directory")).toBe(true);
    });

    it("should handle memory-only mode when persistence is disabled", async () => {
      const logger = new TestLogger();
      const manager = new SentinelManager({ 
        logger, 
        enablePersistence: false,
        rootDirectory: TEMP_SENTINEL_DIR 
      }); // Disable persistence

      const config = loadSentinelConfig("conversational-narrator.json");

      await manager.loadSentinelsForCodon([config], CodonId("test-codon"), {
        llmCallOverride: createLlmAdapter(),
      });

      // Check that sentinel runs in memory-only mode
      expect(logger.hasLog("memory-only mode")).toBe(true);
    });
  });

  describe("Trimming Strategies", () => {
    it("should apply maxTurns trimming correctly", async () => {
      const logger = new TestLogger();
      const config = loadSentinelConfig("conversational-narrator.json");

      // Override config for testing with smaller maxTurns
      config.conversational = {
        trimmingStrategy: { type: "maxTurns", maxTurns: 2 }
      };

      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        createLlmAdapter(),
        logger,
        TEMP_SENTINEL_DIR
      );

      const historyManager = sentinel.getHistoryManager();
      if (historyManager) {
        // Add 3 turns
        await historyManager.addMessagePair("Turn 1", "Response 1");
        await historyManager.addMessagePair("Turn 2", "Response 2");
        await historyManager.addMessagePair("Turn 3", "Response 3");

        // Get messages and verify pruning
        const messages = await historyManager.getMessagesToSend("System prompt");

        // Should have system + 2 most recent turns (5 messages)
        expect(messages.length).toBe(5); // system + 2 turns * 2
        expect(messages[1].content).toBe("Turn 2"); // First turn should be pruned
      }

      // Check pruning log
      expect(logger.hasLog("Pruned")).toBe(true);
      expect(logger.hasLog("maxTurns=2")).toBe(true);
    });

    it("should apply maxTokens trimming correctly", async () => {
      const logger = new TestLogger();

      // Create config with maxTokens
      const config: SentinelConfig = {
        id: "token-test",
        name: "Token Test",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: { type: "event", on: ["codon.started"] },
        execution: { strategy: "immediate" },
        systemPromptText: "System",
        userPromptText: "User",
        conversational: {
          trimmingStrategy: { type: "maxTokens", maxTokens: 10 } // ~40 chars
        }
      };

      const validatedConfig = sentinelConfigSchema.parse(config);

      const sentinel = new Sentinel(
        validatedConfig,
        CodonId("test-codon"),
        createLlmAdapter(),
        logger,
        TEMP_SENTINEL_DIR
      );

      const historyManager = sentinel.getHistoryManager();
      if (historyManager) {
        // Add messages that exceed token limit
        // First pair total ~24 tokens (96 chars)
        await historyManager.addMessagePair(
          "This is a very long message that will exceed token limits",
          "Another very long response message"
        );
        // Last pair total ~3 tokens (10 chars)
        await historyManager.addMessagePair("Short", "Brief");

        // Get messages and verify pruning
        const messages = await historyManager.getMessagesToSend("System");

        // With maxTokens=10, the first two long messages should be pruned
        // Should have system + the last 2 short messages
        expect(messages.length).toBe(3); // System + "Short" + "Brief"

        // Verify the messages are the most recent ones
        expect(messages[1].content).toBe("Short");
        expect(messages[2].content).toBe("Brief");
      }

      // Check pruning log
      expect(logger.hasLog("Pruned")).toBe(true);
      expect(logger.hasLog("maxTokens=10")).toBe(true);
    });
  });

  describe("Atomic Message Pair API", () => {
    it("should use atomic message pairs to prevent corruption", async () => {
      const logger = new TestLogger();
      const config = loadSentinelConfig("conversational-narrator.json");

      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        createLlmAdapter(),
        logger,
        TEMP_SENTINEL_DIR
      );

      const historyManager = sentinel.getHistoryManager();
      if (historyManager) {
        // Add multiple conversation turns atomically
        await historyManager.addMessagePair("Question 1", "Answer 1");
        await historyManager.addMessagePair("Question 2", "Answer 2");

        const messages = await historyManager.getMessagesToSend("System prompt");

        // Should have perfectly paired user/assistant messages
        expect(messages).toHaveLength(5); // system + 2 pairs
        expect(messages[1].role).toBe("user");
        expect(messages[2].role).toBe("assistant");
        expect(messages[3].role).toBe("user");
        expect(messages[4].role).toBe("assistant");
      }

      // Check logging
      expect(logger.hasLog("Added message pair")).toBe(true);
    });
  });

  describe("Logging Validation", () => {
    it("should log all expected lifecycle events", async () => {
      const logger = new TestLogger();
      const config = loadSentinelConfig("conversational-narrator.json");

      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        createLlmAdapter(),
        logger,
        TEMP_SENTINEL_DIR
      );

      // Check initialization logs
      expect(logger.hasLog("[Sentinel:conversational-narrator]", "info")).toBe(true);
      expect(logger.hasLog("Initialized conversational mode", "info")).toBe(true);
      expect(logger.hasLog("maxTurns trimming", "info")).toBe(true);

      // Check persistence logs
      const historyManager = sentinel.getHistoryManager();
      if (historyManager) {
        logger.clear();

        await historyManager.addMessagePair("Test message", "Test response");
        expect(logger.hasLog("Added message pair", "debug")).toBe(true);
        expect(logger.hasLog("Total messages: 2", "debug")).toBe(true);

        // Check save log
        const saveLogs = logger.getLogsContaining("Saved");
        expect(saveLogs.length).toBeGreaterThan(0);
      }
    });
  });
});
