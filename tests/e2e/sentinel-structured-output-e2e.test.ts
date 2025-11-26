import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { LlmProviderRegistry } from "../../server/llm/llm-provider-registry.js";
import { PROVIDER_DEFINITIONS } from "../../server/llm/provider-config.js";
import type { ServerEvent } from "../../server/schemas/event-schemas.js";
import { SentinelManager } from "../../server/sentinels/sentinel-manager.js";
import { CodonId, EventId } from "../../server/types/branded-types.js";
import type { SentinelConfig } from "../../server/types/sentinel-types.js";
import { Logger } from "../../server/utils.js";

describe("Structured Output E2E (Real Providers)", () => {
  let tempDir: string | undefined;
  let configDir: string;
  let logs: string[] = [];
  let mockLogger: Logger;

  const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
  const hasOpenAIKey = !!process.env.OPENAI_API_KEY;

  beforeEach(async () => {
    logs = [];
    mockLogger = new Logger("/tmp/test-structured-output-e2e.log");

    // Override log method to capture logs
    const originalLog = mockLogger.log.bind(mockLogger);
    mockLogger.log = (message: string, level = "info") => {
      logs.push(`[${level}] ${message}`);
      originalLog(message, level);
    };

    // Create temporary directories
    tempDir = path.join("tests", "test-area", "structured-output-e2e");
    configDir = path.join(tempDir, "config");
    await fs.mkdir(tempDir, { recursive: true });
    await fs.mkdir(configDir, { recursive: true });
  });

  afterEach(async () => {
    if (tempDir) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it.if(hasAnthropicKey)(
    "Anthropic - complex nested object",
    async () => {
      const realRegistry = new LlmProviderRegistry({
        logger: mockLogger,
        performHealthCheckOnInit: true,
      });

      // Wait for health checks to complete
      await realRegistry.performHealthChecks();

      const testModel = "anthropic/claude-haiku-4-5";
      console.log(`Testing with ${testModel}`);

      // Define the expected schema for validation
      const entitySchema = z.object({
        entities: z.array(
          z.object({
            name: z.string(),
            type: z.enum(["person", "place", "organization"]),
          }),
        ),
        sentiment: z.enum(["positive", "neutral", "negative"]),
      });

      let generatedObject: unknown;

      const config: SentinelConfig = {
        id: "anthropic-object-test",
        name: "Anthropic Object Test",
        model: testModel,
        trigger: { type: "event", on: ["file.updated"] },
        execution: { strategy: "immediate" },
        userPromptText: 'Extract entities from this text: "Alice visited Paris with Bob"',
        structuredOutput: {
          schemaStr:
            'z.object({ entities: z.array(z.object({ name: z.string(), type: z.enum(["person", "place", "organization"]) })), sentiment: z.enum(["positive", "neutral", "negative"]) })',
          output: "object",
        },
        llmParams: {
          temperature: 0,
          maxOutputTokens: 500,
        },
      };

      const manager = new SentinelManager({
        logger: mockLogger,
        enablePersistence: false,
        providerRegistry: realRegistry,
      });

      await manager.loadSentinelsForCodon([config], CodonId("test-codon"), {
        configDirectory: configDir,
        runStartTime: new Date(),
        executionPath: tempDir,
        // No llmCallOverride - we want to use real providers
      });

      const event: ServerEvent = {
        id: EventId("test-1"),
        timestamp: new Date().toISOString(),
        type: "file.updated",
        data: {
          path: "test.txt",
          filename: "test.txt",
          content: "test content",
          action: "created",
        },
      };

      manager.handleEvent(event);
      await manager.completeAllWork();

      // Extract generated object from logs AFTER execution completes
      const objectLog = logs.find((l) => l.includes("Generated object"));
      if (objectLog) {
        const match = objectLog.match(/Generated object: (.+)/);
        if (match) {
          try {
            generatedObject = JSON.parse(match[1]);
          } catch (_err) {
            console.log("Failed to parse object from log:", match[1]);
          }
        }
      }

      // Verify LLM call was made
      const llmCallLogs = logs.filter((l) => l.includes("LLM call cost"));
      expect(llmCallLogs.length).toBeGreaterThan(0);

      // CRITICAL: Validate the generated object matches schema
      expect(generatedObject).toBeDefined();
      const validationResult = entitySchema.safeParse(generatedObject);
      expect(validationResult.success).toBe(true);

      if (validationResult.success) {
        // Verify structure
        expect(Array.isArray(validationResult.data.entities)).toBe(true);
        expect(validationResult.data.entities.length).toBeGreaterThan(0);
        expect(["positive", "neutral", "negative"]).toContain(validationResult.data.sentiment);
        console.log(`✅ Anthropic nested object: ${JSON.stringify(validationResult.data)}`);
      }
    },
    15000,
  );

  it.if(hasOpenAIKey)(
    "OpenAI - array output",
    async () => {
      const realRegistry = new LlmProviderRegistry({
        logger: mockLogger,
        performHealthCheckOnInit: true,
      });

      // Wait for health checks to complete
      await realRegistry.performHealthChecks();

      // Find cheapest OpenAI chat model with structured output support
      const openaiModels = realRegistry
        .getAvailableModels()
        .filter((m) => m.startsWith("openai/"))
        .map((fullId) => {
          const info = realRegistry.getModelInfo(fullId);
          if (!info.success) return null;
          // Must support tool_call for structured output (excludes embeddings)
          if (info.info.tool_call === false) return null;
          return { fullId, inputCost: info.info.cost?.input || Infinity };
        })
        .filter((m): m is { fullId: string; inputCost: number } => m !== null)
        .sort((a, b) => a.inputCost - b.inputCost);

      if (openaiModels.length === 0) {
        console.log("⚠️ No OpenAI models available");
        return;
      }

      const testModel = openaiModels[0].fullId;
      console.log(`Testing with ${testModel} (cheapest, $${openaiModels[0].inputCost}/M input)`);

      // Define expected schema for validation
      const taskSchema = z.object({
        task: z.string(),
        priority: z.enum(["high", "medium", "low"]),
      });
      const arraySchema = z.array(taskSchema);

      let generatedArray: unknown;

      const config: SentinelConfig = {
        id: "openai-array-test",
        name: "OpenAI Array Test",
        model: testModel,
        trigger: { type: "event", on: ["tool.result"] },
        execution: { strategy: "immediate" },
        userPromptText: "Generate 2 simple tasks",
        structuredOutput: {
          schemaStr: 'z.object({ task: z.string(), priority: z.enum(["high", "medium", "low"]) })',
          output: "array",
        },
        llmParams: {
          temperature: 0,
          maxOutputTokens: 300,
        },
      };

      const manager = new SentinelManager({
        logger: mockLogger,
        enablePersistence: false,
        providerRegistry: realRegistry,
      });

      await manager.loadSentinelsForCodon([config], CodonId("test-codon"), {
        configDirectory: configDir,
        runStartTime: new Date(),
        executionPath: tempDir,
        // No llmCallOverride - we want to use real providers
      });

      const event: ServerEvent = {
        id: EventId("test-1"),
        timestamp: new Date().toISOString(),
        type: "tool.result",
        data: {
          codonId: "test-codon",
          toolUseId: "tool-1",
          toolName: "Read",
          result: "file content",
          truncated: false,
          originalLength: 12,
          executionTimeMs: 100,
          isError: false,
        },
      };

      manager.handleEvent(event);
      await manager.completeAllWork();

      // Extract generated array from logs AFTER execution completes
      const objectLog = logs.find((l) => l.includes("Generated object"));
      if (objectLog) {
        const match = objectLog.match(/Generated object: (.+)/);
        if (match) {
          try {
            generatedArray = JSON.parse(match[1]);
          } catch (_err) {
            console.log("Failed to parse array from log:", match[1]);
          }
        }
      }

      // Verify LLM call was made
      const llmCallLogs = logs.filter((l) => l.includes("LLM call cost"));
      expect(llmCallLogs.length).toBeGreaterThan(0);

      // CRITICAL: Validate generated array
      expect(generatedArray).toBeDefined();
      const validationResult = arraySchema.safeParse(generatedArray);
      expect(validationResult.success).toBe(true);

      if (validationResult.success) {
        expect(Array.isArray(validationResult.data)).toBe(true);
        expect(validationResult.data.length).toBeGreaterThanOrEqual(1);
        // Validate each item has required fields
        for (const item of validationResult.data) {
          expect(typeof item.task).toBe("string");
          expect(["high", "medium", "low"]).toContain(item.priority);
        }
        console.log(
          `✅ OpenAI array (${validationResult.data.length} items): ${JSON.stringify(validationResult.data)}`,
        );
      }
    },
    15000,
  );

  it.if(hasAnthropicKey)(
    "Enum output - plain strings",
    async () => {
      const realRegistry = new LlmProviderRegistry({
        logger: mockLogger,
        performHealthCheckOnInit: true,
      });

      // Wait for health checks to complete
      await realRegistry.performHealthChecks();

      const testModel = "anthropic/claude-haiku-4-5";
      console.log(`Testing with ${testModel}`);

      const allowedValues = ["bug", "feature", "documentation", "test"];
      let generatedEnum: unknown;

      const config: SentinelConfig = {
        id: "enum-test",
        name: "Enum Test",
        model: testModel,
        trigger: { type: "event", on: ["codon.completed"] },
        execution: { strategy: "immediate" },
        userPromptText: 'Classify this task: "Fix memory leak". Answer with just: bug or feature',
        structuredOutput: {
          output: "enum",
          enumValues: allowedValues,
        },
        llmParams: {
          temperature: 0,
          maxOutputTokens: 50,
        },
      };

      const manager = new SentinelManager({
        logger: mockLogger,
        enablePersistence: false,
        providerRegistry: realRegistry,
      });

      await manager.loadSentinelsForCodon([config], CodonId("test-codon"), {
        configDirectory: configDir,
        runStartTime: new Date(),
        executionPath: tempDir,
        // No llmCallOverride - we want to use real providers
      });

      const event: ServerEvent = {
        id: EventId("test-1"),
        timestamp: new Date().toISOString(),
        type: "codon.completed",
        data: {
          codonId: "test-codon",
          success: true,
          cost: 0.01,
          duration: 1000,
          exitStatus: { type: "success" },
        },
      };

      manager.handleEvent(event);
      await manager.completeAllWork();

      // Extract enum value from logs AFTER execution completes
      const objectLog = logs.find((l) => l.includes("Generated object"));
      if (objectLog) {
        const match = objectLog.match(/Generated object: "?([^"]+)"?$/);
        if (match) {
          generatedEnum = match[1];
        } else {
          console.log("Could not extract enum from log:", objectLog);
        }
      }

      // Verify LLM call was made
      const llmCallLogs = logs.filter((l) => l.includes("LLM call cost"));
      expect(llmCallLogs.length).toBeGreaterThan(0);

      // Check for generated object log
      const objectLogs = logs.filter((l) => l.includes("Generated object"));
      expect(objectLogs.length).toBeGreaterThan(0);

      // CRITICAL: Validate enum value is from allowed set
      expect(generatedEnum).toBeDefined();
      expect(typeof generatedEnum).toBe("string");
      expect(allowedValues).toContain(generatedEnum);

      console.log(`✅ Enum output: "${generatedEnum}"`);
    },
    15000,
  );

  it.if(hasAnthropicKey)(
    "Conversational mode with structured output",
    async () => {
      const realRegistry = new LlmProviderRegistry({
        logger: mockLogger,
        performHealthCheckOnInit: true,
      });

      // Wait for health checks to complete
      await realRegistry.performHealthChecks();

      const testModel = "anthropic/claude-haiku-4-5";
      console.log(`Testing with ${testModel}`);

      const systemPromptFile = path.join(configDir, "conv-system.md");
      const userPromptFile = path.join(configDir, "conv-user.md");

      await fs.writeFile(
        systemPromptFile,
        "You track file counts across events. Maintain a running total. IMPORTANT: Respond ONLY with valid JSON matching the exact schema. No other text.",
      );
      await fs.writeFile(
        userPromptFile,
        "Update counts: <%= it.events.length %> new file(s) changed",
      );

      // Schema for validation
      const metricsSchema = z.object({
        filesChanged: z.number(),
        total: z.number(),
      });

      const generatedObjects: unknown[] = [];

      const config: SentinelConfig = {
        id: "conv-structured",
        name: "Conversational Structured",
        model: testModel,
        trigger: { type: "event", on: ["file.updated"] },
        execution: { strategy: "immediate" },
        systemPromptFile: "conv-system.md",
        userPromptFile: "conv-user.md",
        conversational: {
          trimmingStrategy: { type: "maxTurns", maxTurns: 5 },
        },
        structuredOutput: {
          schemaStr: "z.object({ filesChanged: z.number(), total: z.number() })",
          output: "object",
        },
        llmParams: {
          temperature: 0,
          maxOutputTokens: 200,
        },
      };

      const manager = new SentinelManager({
        logger: mockLogger,
        enablePersistence: false,
        providerRegistry: realRegistry,
      });

      await manager.loadSentinelsForCodon([config], CodonId("conv-codon"), {
        configDirectory: configDir,
        runStartTime: new Date(),
        executionPath: tempDir,
        // No llmCallOverride - we want to use real providers
      });

      // Send 3 events to create 3 conversation turns
      for (let i = 1; i <= 3; i++) {
        const event: ServerEvent = {
          id: EventId(`test-${i}`),
          timestamp: new Date().toISOString(),
          type: "file.updated",
          data: {
            path: `test${i}.txt`,
            filename: `test${i}.txt`,
            content: "content",
            action: "created",
          },
        };
        manager.handleEvent(event);
        // For conversational mode, wait between events to ensure each completes
        await new Promise((r) => setTimeout(r, 100));
      }

      await manager.completeAllWork();

      // Extract ALL generated objects from logs AFTER execution completes
      const allObjectLogs = logs.filter((l) => l.includes("Generated object"));
      console.log(`Found ${allObjectLogs.length} object logs in conversational test`);
      for (const log of allObjectLogs) {
        const match = log.match(/Generated object: (.+)/);
        if (match) {
          try {
            const parsed = JSON.parse(match[1]);
            generatedObjects.push(parsed);
            console.log(`Parsed conversational object ${generatedObjects.length}:`, parsed);
          } catch (err) {
            console.log("Failed to parse object from log:", match[1], err);
          }
        }
      }

      // Should have 3 LLM calls
      const llmCallLogs = logs.filter((l) => l.includes("LLM call cost"));
      expect(llmCallLogs.length).toBe(3);

      // CRITICAL: Validate all 3 generated objects
      expect(generatedObjects.length).toBe(3);
      for (let i = 0; i < 3; i++) {
        const result = metricsSchema.safeParse(generatedObjects[i]);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(typeof result.data.filesChanged).toBe("number");
          expect(typeof result.data.total).toBe("number");
        }
      }

      console.log(`✅ Conversational mode (3 turns): ${JSON.stringify(generatedObjects)}`);
    },
    20000,
  );

  it.if(hasAnthropicKey)(
    "Full sentinel flow with real provider",
    async () => {
      const realRegistry = new LlmProviderRegistry({
        logger: mockLogger,
        performHealthCheckOnInit: true,
      });

      // Wait for health checks to complete
      await realRegistry.performHealthChecks();

      const testModel = "anthropic/claude-haiku-4-5";
      console.log(`Testing with ${testModel}`);

      // Schema for validation
      const analysisSchema = z.object({
        eventCount: z.number(),
        mainAction: z.string(),
        timestamp: z.string(),
      });

      let generatedObject: unknown;

      // Test with debounce to verify batching works
      const config: SentinelConfig = {
        id: "full-flow-test",
        name: "Full Flow Test",
        model: testModel,
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "debounce", milliseconds: 500 },
        userPromptText: "Analyze these <%= it.events.length %> events and extract key information",
        structuredOutput: {
          schemaStr:
            "z.object({ eventCount: z.number(), mainAction: z.string(), timestamp: z.string() })",
          output: "object",
        },
        llmParams: {
          temperature: 0,
          maxOutputTokens: 300,
        },
      };

      const manager = new SentinelManager({
        logger: mockLogger,
        enablePersistence: false,
        providerRegistry: realRegistry,
      });

      await manager.loadSentinelsForCodon([config], CodonId("full-flow-codon"), {
        configDirectory: configDir,
        runStartTime: new Date(),
        executionPath: tempDir,
        // No llmCallOverride - we want to use real providers
      });

      // Send multiple events quickly (should be batched by debounce)
      for (let i = 1; i <= 3; i++) {
        const event: ServerEvent = {
          id: EventId(`evt-${i}`),
          timestamp: new Date().toISOString(),
          type: "assistant.action",
          data: {
            codonId: CodonId("full-flow-codon"),
            action: "thinking",
            content: `Event ${i} content`,
          },
        };
        manager.handleEvent(event);
      }

      await manager.completeAllWork();

      // Extract generated object from logs AFTER execution completes
      const objectLog = logs.find((l) => l.includes("Generated object"));
      if (objectLog) {
        const match = objectLog.match(/Generated object: (.+)/);
        if (match) {
          try {
            generatedObject = JSON.parse(match[1]);
          } catch (_err) {
            console.log("Failed to parse object from log:", match[1]);
          }
        }
      }

      // Should have made exactly 1 call (debounced)
      const llmCallLogs = logs.filter((l) => l.includes("LLM call cost"));
      expect(llmCallLogs.length).toBe(1);

      // Check for generated object log
      const objectLogs = logs.filter((l) => l.includes("Generated object"));
      expect(objectLogs.length).toBeGreaterThan(0);

      // CRITICAL: Validate debounced batch object
      expect(generatedObject).toBeDefined();
      const validationResult = analysisSchema.safeParse(generatedObject);
      expect(validationResult.success).toBe(true);

      if (validationResult.success) {
        expect(validationResult.data.eventCount).toBe(3); // Should have counted 3 events
        expect(typeof validationResult.data.mainAction).toBe("string");
        expect(typeof validationResult.data.timestamp).toBe("string");
        console.log(`✅ Debounced batch object: ${JSON.stringify(validationResult.data)}`);
      }
    },
    15000,
  );

  it.if(hasOpenAIKey)(
    "OpenAI - simple object generation",
    async () => {
      const realRegistry = new LlmProviderRegistry({
        logger: mockLogger,
        performHealthCheckOnInit: true,
      });

      // Wait for health checks to complete
      await realRegistry.performHealthChecks();

      // Find cheapest OpenAI chat model with structured output support
      const openaiModels = realRegistry
        .getAvailableModels()
        .filter((m) => m.startsWith("openai/"))
        .map((fullId) => {
          const info = realRegistry.getModelInfo(fullId);
          if (!info.success) return null;
          // Must support tool_call for structured output (excludes embeddings)
          if (info.info.tool_call === false) return null;
          return { fullId, inputCost: info.info.cost?.input || Infinity };
        })
        .filter((m): m is { fullId: string; inputCost: number } => m !== null)
        .sort((a, b) => a.inputCost - b.inputCost);

      if (openaiModels.length === 0) {
        console.log("⚠️ No OpenAI models available");
        return;
      }

      const testModel = openaiModels[0].fullId;
      console.log(`Testing with ${testModel} (cheapest, $${openaiModels[0].inputCost}/M input)`);

      const metricsSchema = z.object({
        inputTokens: z.number(),
        outputTokens: z.number(),
      });

      let generatedObject: unknown;

      const config: SentinelConfig = {
        id: "openai-object-test",
        name: "OpenAI Object Test",
        model: testModel,
        trigger: { type: "event", on: ["token.usage"] },
        execution: { strategy: "immediate" },
        userPromptText: "Extract metrics",
        structuredOutput: {
          schemaStr: "z.object({ inputTokens: z.number(), outputTokens: z.number() })",
          output: "object",
        },
        llmParams: {
          temperature: 0,
          maxOutputTokens: 200,
        },
      };

      const manager = new SentinelManager({
        logger: mockLogger,
        enablePersistence: false,
        providerRegistry: realRegistry,
      });

      await manager.loadSentinelsForCodon([config], CodonId("test-codon"), {
        configDirectory: configDir,
        runStartTime: new Date(),
        executionPath: tempDir,
        // No llmCallOverride - we want to use real providers
      });

      const event: ServerEvent = {
        id: EventId("test-1"),
        timestamp: new Date().toISOString(),
        type: "token.usage",
        data: {
          codonId: "test-codon",
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalCost: 0.001,
        },
      };

      manager.handleEvent(event);
      await manager.completeAllWork();

      // Extract generated object from logs AFTER execution completes
      const objectLog = logs.find((l) => l.includes("Generated object"));
      if (objectLog) {
        const match = objectLog.match(/Generated object: (.+)/);
        if (match) {
          try {
            generatedObject = JSON.parse(match[1]);
          } catch (_err) {
            console.log("Failed to parse object from log:", match[1]);
          }
        }
      }

      // Verify LLM call was made
      const llmCallLogs = logs.filter((l) => l.includes("LLM call cost"));
      expect(llmCallLogs.length).toBeGreaterThan(0);

      // CRITICAL: Validate generated object
      expect(generatedObject).toBeDefined();
      const validationResult = metricsSchema.safeParse(generatedObject);
      expect(validationResult.success).toBe(true);

      if (validationResult.success) {
        expect(typeof validationResult.data.inputTokens).toBe("number");
        expect(typeof validationResult.data.outputTokens).toBe("number");
        console.log(`✅ OpenAI object: ${JSON.stringify(validationResult.data)}`);
      }
    },
    15000,
  );

  it.if(hasAnthropicKey || hasOpenAIKey)(
    "Schema file loading with real provider",
    async () => {
      const realRegistry = new LlmProviderRegistry({
        logger: mockLogger,
        performHealthCheckOnInit: true,
      });

      // Wait for health checks to complete
      await realRegistry.performHealthChecks();

      // Find any available model
      let testModel: string | null = null;
      for (const def of PROVIDER_DEFINITIONS) {
        if (process.env[def.apiKeyEnvVar]) {
          const models = realRegistry
            .getAvailableModels()
            .filter((m) => m.startsWith(`${def.id}/`));
          if (models.length > 0) {
            testModel = models[0];
            break;
          }
        }
      }

      if (!testModel) {
        console.log("⚠️ No models available");
        return;
      }

      console.log(`Testing with ${testModel}`);

      // Create schema file
      const schemaFile = path.join(configDir, "test-schema.ts");
      await fs.writeFile(
        schemaFile,
        "z.object({ category: z.string(), confidence: z.number().min(0).max(1) })",
      );

      const categorySchema = z.object({
        category: z.string(),
        confidence: z.number().min(0).max(1),
      });

      let generatedObject: unknown;

      const config: SentinelConfig = {
        id: "schema-file-test",
        name: "Schema File Test",
        model: testModel,
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "Categorize this",
        structuredOutput: {
          schemaFile: "test-schema.ts",
          output: "object",
        },
        llmParams: {
          temperature: 0,
          maxOutputTokens: 200,
        },
      };

      const manager = new SentinelManager({
        logger: mockLogger,
        enablePersistence: false,
        providerRegistry: realRegistry,
      });

      await manager.loadSentinelsForCodon([config], CodonId("test-codon"), {
        configDirectory: configDir,
        runStartTime: new Date(),
        executionPath: tempDir,
        // No llmCallOverride - we want to use real providers
      });

      const event: ServerEvent = {
        id: EventId("test-1"),
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: {
          codonId: CodonId("test-codon"),
          action: "message",
          content: "Test message",
        },
      };

      manager.handleEvent(event);
      await manager.completeAllWork();

      // Extract generated object from logs AFTER execution completes
      const objectLog = logs.find((l) => l.includes("Generated object"));
      if (objectLog) {
        const match = objectLog.match(/Generated object: (.+)/);
        if (match) {
          try {
            generatedObject = JSON.parse(match[1]);
          } catch (_err) {
            console.log("Failed to parse object from log:", match[1]);
          }
        }
      }

      // Verify LLM call was made
      const llmCallLogs = logs.filter((l) => l.includes("LLM call cost"));
      expect(llmCallLogs.length).toBeGreaterThan(0);

      // CRITICAL: Validate schema file was loaded and used correctly
      expect(generatedObject).toBeDefined();
      const validationResult = categorySchema.safeParse(generatedObject);
      expect(validationResult.success).toBe(true);

      if (validationResult.success) {
        expect(typeof validationResult.data.category).toBe("string");
        expect(validationResult.data.confidence).toBeGreaterThanOrEqual(0);
        expect(validationResult.data.confidence).toBeLessThanOrEqual(1);
        console.log(`✅ Schema file object: ${JSON.stringify(validationResult.data)}`);
      }
    },
    15000,
  );

  it.if(hasAnthropicKey || hasOpenAIKey)(
    "Cost tracking with structured output",
    async () => {
      const realRegistry = new LlmProviderRegistry({
        logger: mockLogger,
        performHealthCheckOnInit: true,
      });

      // Wait for health checks to complete
      await realRegistry.performHealthChecks();

      // Find any available model
      let testModel: string | null = null;
      for (const def of PROVIDER_DEFINITIONS) {
        if (process.env[def.apiKeyEnvVar]) {
          const models = realRegistry
            .getAvailableModels()
            .filter((m) => m.startsWith(`${def.id}/`));
          if (models.length > 0) {
            testModel = models[0];
            break;
          }
        }
      }

      if (!testModel) {
        console.log("⚠️ No models available");
        return;
      }

      console.log(`Testing with ${testModel}`);

      const valueSchema = z.object({
        value: z.number(),
      });

      let generatedObject: unknown;

      const config: SentinelConfig = {
        id: "cost-tracking-test",
        name: "Cost Tracking Test",
        model: testModel,
        trigger: { type: "event", on: ["file.updated"] },
        execution: { strategy: "immediate" },
        userPromptText: "Extract simple data",
        structuredOutput: {
          schemaStr: "z.object({ value: z.number() })",
          output: "object",
        },
        llmParams: {
          temperature: 0,
          maxOutputTokens: 100,
        },
      };

      const manager = new SentinelManager({
        logger: mockLogger,
        enablePersistence: false,
        providerRegistry: realRegistry,
      });

      await manager.loadSentinelsForCodon([config], CodonId("test-codon"), {
        configDirectory: configDir,
        runStartTime: new Date(),
        executionPath: tempDir,
        // No llmCallOverride - we want to use real providers
      });

      const event: ServerEvent = {
        id: EventId("test-1"),
        timestamp: new Date().toISOString(),
        type: "file.updated",
        data: {
          path: "test.txt",
          filename: "test.txt",
          content: "42",
          action: "created",
        },
      };

      manager.handleEvent(event);
      await manager.completeAllWork();

      // Extract generated object from logs AFTER execution completes
      const objectLog = logs.find((l) => l.includes("Generated object"));
      if (objectLog) {
        const match = objectLog.match(/Generated object: (.+)/);
        if (match) {
          try {
            generatedObject = JSON.parse(match[1]);
          } catch (_err) {
            console.log("Failed to parse object from log:", match[1]);
          }
        }
      }

      // Verify cost was tracked and logged
      const costLogs = logs.filter((l) => l.includes("LLM call cost") && l.includes("total:"));
      expect(costLogs.length).toBeGreaterThan(0);

      // Extract and verify cost format
      const costLog = costLogs[0];
      expect(costLog).toMatch(/\$\d+\.\d{6}/); // Should have $X.XXXXXX format

      // CRITICAL: Validate generated object
      expect(generatedObject).toBeDefined();
      const validationResult = valueSchema.safeParse(generatedObject);
      expect(validationResult.success).toBe(true);

      if (validationResult.success) {
        expect(typeof validationResult.data.value).toBe("number");
        console.log(`✅ Cost tracking object: ${JSON.stringify(validationResult.data)}`);
      }

      console.log(`   Cost log: ${costLog}`);
    },
    15000,
  );
});
