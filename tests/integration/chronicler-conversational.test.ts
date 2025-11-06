import { describe, it, expect, beforeAll, afterEach } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import { chroniclerConfigSchema } from "../../server/config-validation/chronicler.schema.js";
import { ChroniclerManager } from "../../server/chroniclers/chronicler-manager.js";
import { Chronicler } from "../../server/chroniclers/chronicler.js";
import { HistoryManager } from "../../server/chroniclers/history-manager.js";
import { PhaseId } from "../../server/types/branded-types.js";
import type { ServerEvent } from "../../server/schemas/event-schemas.js";
import type { ChroniclerConfig } from "../../server/types/chronicler-types.js";
import type { TadpoleModelMessage } from "../../server/types/input-ai-types.js";
import type {
  TadpoleGenerateTextOptions,
  TadpoleGenerateTextResult,
} from "../../server/types/llm-call-types.js";
import { Logger } from "../../server/utils.js";
import { createMockLlm } from "../utils/mock-llm.js";

// --- Test Setup ---
const CHRONICLER_CONFIGS_DIR = path.resolve(process.cwd(), "tests/config/chronicler-triggers");
const TEMP_CHRONICLER_DIR = path.resolve(process.cwd(), "tests/test-area/temp-chroniclers");

// Helper to load a Chronicler config from our test files
function loadChroniclerConfig(fileName: string) {
  const filePath = path.join(CHRONICLER_CONFIGS_DIR, fileName);
  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const config = JSON.parse(fileContent);
  // Validate it before using to catch schema errors
  return chroniclerConfigSchema.parse(config);
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

// Helper function to create an LLM adapter for chroniclers
function createLlmAdapter(callTracker?: Array<{ id: string; options: TadpoleGenerateTextOptions }>) {
  return async (id: string, options: TadpoleGenerateTextOptions): Promise<TadpoleGenerateTextResult> => {
    // Track the call if a tracker is provided
    if (callTracker) {
      callTracker.push({ id, options });
    }

    // Use the mock LLM to generate the response
    const result = await mockLlmProvider.generateText(options);
    return result;
  };
}

// Ensure temp directories exist for test logs and chronicler data
beforeAll(() => {
  if (!fs.existsSync(TEMP_CHRONICLER_DIR)) {
    fs.mkdirSync(TEMP_CHRONICLER_DIR, { recursive: true });
  }
});

// Clean up temp chronicler directory after each test
afterEach(async () => {
  try {
    await fsPromises.rm(TEMP_CHRONICLER_DIR, { recursive: true, force: true });
    await fsPromises.mkdir(TEMP_CHRONICLER_DIR, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe("Conversational Chronicler Integration Tests", () => {

  describe("Conversational Configuration", () => {
    it("should load conversational configuration correctly", () => {
      const config = loadChroniclerConfig("conversational-narrator.json");

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
        trigger: { type: "event", on: ["phase.started"] },
        execution: { strategy: "immediate" },
        userPromptText: "Test prompt",
        conversational: {
          trimmingStrategy: { type: "maxTurns", maxTurns: 5 }
        }
      };

      expect(() => chroniclerConfigSchema.parse(invalidConfig)).toThrow(
        /Conversational chroniclers require a system prompt/
      );
    });
  });

  describe("HistoryManager Creation", () => {
    it("should create HistoryManager for conversational chroniclers", async () => {
      const logger = new TestLogger();
      const config = loadChroniclerConfig("conversational-narrator.json");

      // Create chronicler with test directory
      const chronicler = new Chronicler(
        config,
        PhaseId("test-phase"),
        createLlmAdapter(),
        logger,
        TEMP_CHRONICLER_DIR
      );

      // Check that HistoryManager was created
      const historyManager = chronicler.getHistoryManager();
      expect(historyManager).toBeInstanceOf(HistoryManager);

      // Check logs for initialization
      expect(logger.hasLog("Initialized conversational mode")).toBe(true);
      expect(logger.hasLog("maxTurns trimming")).toBe(true);
    });

    it("should not create HistoryManager for non-conversational chroniclers", async () => {
      const logger = new TestLogger();
      const config = loadChroniclerConfig("narrator.json");

      const chronicler = new Chronicler(
        config,
        PhaseId("test-phase"),
        createLlmAdapter(),
        logger,
        TEMP_CHRONICLER_DIR
      );

      // Check that HistoryManager was NOT created
      const historyManager = chronicler.getHistoryManager();
      expect(historyManager).toBeUndefined();

      // Should not have conversational logs
      expect(logger.hasLog("conversational mode")).toBe(false);
    });
  });

  describe("Persistence Across Triggers", () => {
    it("should persist history across multiple trigger executions", async () => {
      const logger = new TestLogger();
      const testChroniclerDir = path.join(TEMP_CHRONICLER_DIR, "test-persistence");
      await fsPromises.mkdir(testChroniclerDir, { recursive: true });

      const config = loadChroniclerConfig("conversational-narrator.json");

      // Track LLM calls
      const llmCalls: Array<{ id: string; options: TadpoleGenerateTextOptions }> = [];
      const mockLlm = createLlmAdapter(llmCalls);

      // Create first chronicler instance
      const chronicler1 = new Chronicler(config, PhaseId("test-phase"), mockLlm, logger, testChroniclerDir);
      const historyManager1 = chronicler1.getHistoryManager();
      expect(historyManager1).toBeDefined();

      // Simulate first batch of events
      if (historyManager1) {
        await historyManager1.addMessagePair("First batch of events", "First response");
      }

      // Check that history was saved (with phase-scoped naming)
      const historyPath = path.join(testChroniclerDir, "conversational-narrator-phase-test-phase.json");
      await new Promise(resolve => setTimeout(resolve, 100)); // Give time for async save
      expect(fs.existsSync(historyPath)).toBe(true);

      // Create second chronicler instance (simulating server restart)
      logger.clear();
      const chronicler2 = new Chronicler(config, PhaseId("test-phase"), mockLlm, logger, testChroniclerDir);
      const historyManager2 = chronicler2.getHistoryManager();
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
    it("should create chronicler directory when loading conversational chroniclers", async () => {
      const logger = new TestLogger();
      const manager = new ChroniclerManager({ logger, enablePersistence: true });

      const config = loadChroniclerConfig("conversational-narrator.json");

      await manager.loadChroniclersForPhase([config], PhaseId("test-phase"), {
        llmCallOverride: createLlmAdapter(),
      });

      // Check that manager logged directory creation
      expect(logger.hasLog("chronicler directory")).toBe(true);
    });

    it("should handle memory-only mode when persistence is disabled", async () => {
      const logger = new TestLogger();
      const manager = new ChroniclerManager({ logger, enablePersistence: false }); // Disable persistence

      const config = loadChroniclerConfig("conversational-narrator.json");

      await manager.loadChroniclersForPhase([config], PhaseId("test-phase"), {
        llmCallOverride: createLlmAdapter(),
      });

      // Check that chronicler runs in memory-only mode
      expect(logger.hasLog("memory-only mode")).toBe(true);
    });
  });

  describe("Trimming Strategies", () => {
    it("should apply maxTurns trimming correctly", async () => {
      const logger = new TestLogger();
      const config = loadChroniclerConfig("conversational-narrator.json");

      // Override config for testing with smaller maxTurns
      config.conversational = {
        trimmingStrategy: { type: "maxTurns", maxTurns: 2 }
      };

      const chronicler = new Chronicler(
        config,
        PhaseId("test-phase"),
        createLlmAdapter(),
        logger,
        TEMP_CHRONICLER_DIR
      );

      const historyManager = chronicler.getHistoryManager();
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
      const config: ChroniclerConfig = {
        id: "token-test",
        name: "Token Test",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: { type: "event", on: ["phase.started"] },
        execution: { strategy: "immediate" },
        systemPromptText: "System",
        userPromptText: "User",
        conversational: {
          trimmingStrategy: { type: "maxTokens", maxTokens: 10 } // ~40 chars
        }
      };

      const validatedConfig = chroniclerConfigSchema.parse(config);

      const chronicler = new Chronicler(
        validatedConfig,
        PhaseId("test-phase"),
        createLlmAdapter(),
        logger,
        TEMP_CHRONICLER_DIR
      );

      const historyManager = chronicler.getHistoryManager();
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
      const config = loadChroniclerConfig("conversational-narrator.json");

      const chronicler = new Chronicler(
        config,
        PhaseId("test-phase"),
        createLlmAdapter(),
        logger,
        TEMP_CHRONICLER_DIR
      );

      const historyManager = chronicler.getHistoryManager();
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
      const config = loadChroniclerConfig("conversational-narrator.json");

      const chronicler = new Chronicler(
        config,
        PhaseId("test-phase"),
        createLlmAdapter(),
        logger,
        TEMP_CHRONICLER_DIR
      );

      // Check initialization logs
      expect(logger.hasLog("[Chronicler:conversational-narrator]", "info")).toBe(true);
      expect(logger.hasLog("Initialized conversational mode", "info")).toBe(true);
      expect(logger.hasLog("maxTurns trimming", "info")).toBe(true);

      // Check persistence logs
      const historyManager = chronicler.getHistoryManager();
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
