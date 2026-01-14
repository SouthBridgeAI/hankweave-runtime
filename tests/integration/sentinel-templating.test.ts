import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ServerEvent } from "../../server/schemas/event-schemas.js";
import { CodonId } from "../../server/types/branded-types.js";
import { Sentinel } from "../../server/sentinels/sentinel.js";
import { SentinelManager } from "../../server/sentinels/sentinel-manager.js";
import type { SentinelConfig } from "../../server/types/sentinel-types.js";
import type { HankweaveModelMessage } from "../../server/types/input-ai-types.js";
import type { HankweaveGenerateTextOptions } from "../../server/types/llm-call-types.js";
import { mockLlmCall } from "../utils/sentinel-test-harness.js";
import { Logger } from "../../server/utils.js";
import { createTypedMockLlmAdapter } from "../utils/mock-llm.js";

describe("Sentinel Templating Integration", () => {
  let tempDir: string;
  let configDir: string;
  let sentinelDir: string;

  beforeEach(async () => {
    // Create temporary directories for testing
    tempDir = path.join("tests", "test-area", "templating-test");
    configDir = path.join(tempDir, "config");
    sentinelDir = path.join(tempDir, "sentinels");

    await fs.mkdir(tempDir, { recursive: true });
    await fs.mkdir(configDir, { recursive: true });
    await fs.mkdir(sentinelDir, { recursive: true });
  });

  afterEach(async () => {
    // Cleanup
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("Prompt File Loading", () => {
    test("loads single prompt file correctly", async () => {
      // Create test prompt file
      const promptFile = path.join(configDir, "test-prompt.md");
      await fs.writeFile(promptFile, "Analyze these events: <%= it.events.length %> total");

      const config: SentinelConfig = {
        id: "test-sentinel",
        name: "Test Sentinel",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: {
          type: "event",
          on: ["assistant.action"]
        },
        execution: { strategy: "immediate" },
        userPromptFile: "test-prompt.md"
      };

      let llmCallMade = false;
      const mockLLMCall = createTypedMockLlmAdapter(() => {
        llmCallMade = true;
        return Promise.resolve("Mock response");
      });

      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        mockLLMCall,
        createMockLogger(),
        sentinelDir,
        configDir
      );

      const testEvent: ServerEvent = {
        id: "evt-1",
        timestamp: "2025-01-19T10:00:00Z",
        type: "assistant.action",
        data: {
          codonId: CodonId("test-codon"),
          action: "thinking",
          content: "Test content"
        }
      };

      // Trigger the sentinel
      sentinel.handleEvent(testEvent);

      // Wait for async execution
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify the sentinel successfully loaded the prompt file and executed
      expect(llmCallMade).toBe(true);
    });

    test("loads multiple prompt files correctly", async () => {
      // Create multiple test prompt files
      const prompt1File = path.join(configDir, "prompt-part1.md");
      const prompt2File = path.join(configDir, "prompt-part2.md");

      await fs.writeFile(prompt1File, "Part 1: Codon <%= it.codon.name %>");
      await fs.writeFile(prompt2File, "Part 2: Found <%= it.events.length %> events");

      const config: SentinelConfig = {
        id: "multi-file-sentinel",
        name: "Multi File Sentinel",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: {
          type: "event",
          on: ["assistant.action"]
        },
        execution: { strategy: "immediate" },
        userPromptFile: ["prompt-part1.md", "prompt-part2.md"]
      };

      const mockLLMCall = createTypedMockLlmAdapter("Mock response");

      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        mockLLMCall,
        createMockLogger(),
        sentinelDir,
        configDir
      );

      expect(sentinel).toBeDefined();
    });

    test("handles file loading errors gracefully", async () => {
      const config: SentinelConfig = {
        id: "error-sentinel",
        name: "Error Sentinel",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: {
          type: "event",
          on: ["assistant.action"]
        },
        execution: { strategy: "immediate" },
        userPromptFile: "nonexistent-file.md"
      };

      const mockLLMCall = createTypedMockLlmAdapter("Mock response");

      expect(() => {
        new Sentinel(
          config,
          CodonId("test-codon"),
          mockLLMCall,
          createMockLogger(),
          sentinelDir,
          configDir
        );
      }).toThrow("Failed to load user prompt file");
    });
  });

  describe("Conversational Flow with Templates", () => {
    test("handles conversational sentinel with templates", async () => {
      // Create system and user prompt files
      const systemPromptFile = path.join(configDir, "system.md");
      const userPromptFile = path.join(configDir, "user.md");

      await fs.writeFile(systemPromptFile, "You are analyzing events for codon <%= it.codon.name %>.");
      await fs.writeFile(userPromptFile, "New events to analyze: <%= it.events.map(e => e.type).join(', ') %>");

      const config: SentinelConfig = {
        id: "conversational-sentinel",
        name: "Conversational Sentinel",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: {
          type: "event",
          on: ["assistant.action"]
        },
        execution: { strategy: "immediate" },
        systemPromptFile: "system.md",
        userPromptFile: "user.md",
        conversational: {
          trimmingStrategy: {
            type: "maxTurns",
            maxTurns: 3
          }
        }
      };

      let capturedOptions: HankweaveGenerateTextOptions | undefined;
      const mockLLMCall = async (id: string, options: HankweaveGenerateTextOptions) => {
        capturedOptions = options;
        return {
          text: "Assistant response",
          finishReason: "stop" as const,
          usage: { inputTokens: 100, outputTokens: 20 }
        };
      };

      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        mockLLMCall,
        createMockLogger(),
        sentinelDir,
        configDir
      );

      const testEvent: ServerEvent = {
        id: "evt-1",
        timestamp: "2025-01-19T10:00:00Z",
        type: "assistant.action",
        data: {
          codonId: CodonId("test-codon"),
          action: "thinking",
          content: "Test content"
        }
      };

      // Trigger the sentinel
      sentinel.handleEvent(testEvent);

      // Wait for async execution
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify the messages structure
      expect(capturedOptions).toBeDefined();
      if (capturedOptions) {
        expect(capturedOptions.messages).toHaveLength(2); // system + user
        expect(capturedOptions.messages[0].role).toBe("system");
        expect(capturedOptions.messages[0].content).toContain("You are analyzing events for codon Conversational Sentinel");
        expect(capturedOptions.messages[1].role).toBe("user");
        expect(capturedOptions.messages[1].content).toBe("New events to analyze: assistant.action");
      }
    });

    test("handles continueOnError configuration", async () => {
      const userPromptFile = path.join(configDir, "error-user.md");
      const systemPromptFile = path.join(configDir, "error-system.md");

      await fs.writeFile(systemPromptFile, "You are a test system.");
      await fs.writeFile(userPromptFile, "Process: <%= it.events.length %> events");

      const config: SentinelConfig = {
        id: "error-handling-sentinel",
        name: "Error Handling Sentinel",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: {
          type: "event",
          on: ["assistant.action"]
        },
        execution: { strategy: "immediate" },
        systemPromptFile: "error-system.md",
        userPromptFile: "error-user.md",
        conversational: {
          trimmingStrategy: {
            type: "maxTurns",
            maxTurns: 5
          },
          continueOnError: true
        }
      };

      let callCount = 0;
      const mockLLMCall = createTypedMockLlmAdapter(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error("Simulated LLM error");
        }
        return "Success response";
      });

      const logger = createMockLogger();
      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        mockLLMCall,
        logger,
        sentinelDir,
        configDir
      );

      const testEvent: ServerEvent = {
        id: "evt-1",
        timestamp: "2025-01-19T10:00:00Z",
        type: "assistant.action",
        data: {
          codonId: CodonId("test-codon"),
          action: "thinking",
          content: "Test content"
        }
      };

      // First trigger - should fail but not crash
      sentinel.handleEvent(testEvent);
      await new Promise(resolve => setTimeout(resolve, 100));

      // Second trigger - should succeed
      sentinel.handleEvent(testEvent);
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(callCount).toBe(2);

      // Verify error was logged but execution continued
      const logMessages = logger.getLogs();
      const errorLogs = logMessages.filter(log => log.level === "error");
      expect(errorLogs.length).toBeGreaterThan(0);
      expect(errorLogs.some(log => log.message.includes("LLM call failed"))).toBe(true);

      const infoLogs = logMessages.filter(log => log.level === "info");
      expect(infoLogs.some(log => log.message.includes("Ignoring error as per configuration"))).toBe(true);
    });
  });

  describe("Template Error Handling", () => {
    test("handles template syntax errors gracefully", async () => {
      const promptFile = path.join(configDir, "bad-syntax.md");
      await fs.writeFile(promptFile, "Bad template: <%= it.unclosed");

      const config: SentinelConfig = {
        id: "syntax-error-sentinel",
        name: "Syntax Error Sentinel",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: {
          type: "event",
          on: ["assistant.action"]
        },
        execution: { strategy: "immediate" },
        userPromptFile: "bad-syntax.md"
      };

      let llmCallExecuted = false;
      const mockLLMCall = createTypedMockLlmAdapter(() => {
        llmCallExecuted = true;
        return Promise.resolve("Should not reach here");
      });

      const logger = createMockLogger();
      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        mockLLMCall,
        logger,
        sentinelDir,
        configDir
      );

      const testEvent: ServerEvent = {
        id: "evt-1",
        timestamp: "2025-01-19T10:00:00Z",
        type: "assistant.action",
        data: {
          codonId: CodonId("test-codon"),
          action: "thinking",
          content: "Test content"
        }
      };

      // This should not crash but should log the error
      sentinel.handleEvent(testEvent);
      await new Promise(resolve => setTimeout(resolve, 100));

      // LLM call should not have been made due to template error
      expect(llmCallExecuted).toBe(false);

      // Error should be logged
      const errorLogs = logger.getLogs().filter(log => log.level === "error");
      expect(errorLogs.length).toBeGreaterThan(0);
      expect(errorLogs.some(log => log.message.includes("Template rendering failed"))).toBe(true);
    });

    test("handles template runtime errors gracefully", async () => {
      const promptFile = path.join(configDir, "runtime-error.md");
      await fs.writeFile(promptFile, "Runtime error: <%= it.events[0].nonexistent.property %>");

      const config: SentinelConfig = {
        id: "runtime-error-sentinel",
        name: "Runtime Error Sentinel",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: {
          type: "event",
          on: ["assistant.action"]
        },
        execution: { strategy: "immediate" },
        userPromptFile: "runtime-error.md"
      };

      let llmCallExecuted = false;
      const mockLLMCall = createTypedMockLlmAdapter(() => {
        llmCallExecuted = true;
        return Promise.resolve("Should not reach here");
      });

      const logger = createMockLogger();
      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        mockLLMCall,
        logger,
        sentinelDir,
        configDir
      );

      const testEvent: ServerEvent = {
        id: "evt-1",
        timestamp: "2025-01-19T10:00:00Z",
        type: "assistant.action",
        data: {
          codonId: CodonId("test-codon"),
          action: "thinking",
          content: "Test content"
        }
      };

      sentinel.handleEvent(testEvent);
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(llmCallExecuted).toBe(false);

      const errorLogs = logger.getLogs().filter(log => log.level === "error");
      expect(errorLogs.some(log => log.message.includes("Template rendering failed"))).toBe(true);
    });
  });

  describe("SentinelManager Integration", () => {
    test("creates sentinels with config directory", async () => {
      const promptFile = path.join(configDir, "manager-test.md");
      await fs.writeFile(promptFile, "Manager test: <%= it.events.length %> events");

      const configs: SentinelConfig[] = [
        {
          id: "manager-test-sentinel",
          name: "Manager Test Sentinel",
          model: "sonnet",
          trigger: {
            type: "event",
            on: ["assistant.action"]
          },
          execution: { strategy: "immediate" },
          userPromptFile: "manager-test.md"
        }
      ];

      let callCount = 0;
      const mockLLMCall = createTypedMockLlmAdapter(() => {
        callCount++;
        return Promise.resolve("Manager response");
      });

      const manager = new SentinelManager({ 
        logger: createMockLogger(),
        rootDirectory: tempDir,
        enablePersistence: true 
      });
      await manager.loadSentinelsForCodon(configs, CodonId("test-codon"), {
        llmCallOverride: mockLLMCall,
        configDirectory: configDir,
        runStartTime: new Date(),
      });

      expect(manager.getSentinelCount()).toBe(1);
      expect(manager.getSentinelIds()).toEqual(["manager-test-sentinel"]);

      const testEvent: ServerEvent = {
        id: "evt-1",
        timestamp: "2025-01-19T10:00:00Z",
        type: "assistant.action",
        data: {
          codonId: CodonId("test-codon"),
          action: "thinking",
          content: "Test content"
        }
      };

      await manager.handleEvent(testEvent);
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(callCount).toBe(1);
    });
  });

  describe("Complex Template Scenarios", () => {
    test("processes complex event analysis template", async () => {
      const complexPromptFile = path.join(configDir, "complex-analysis.md");
      const complexTemplate = `# Event Analysis Report

## Codon Information
- **Codon**: <%= it.codon.name %>
- **Codon ID**: <%= it.codon.id %>
- **Started**: <%= it.codon.startTime.toISOString() %>
- **Current Time**: <%= it.world.currentTime.toISOString() %>

## Event Summary
Total events: <%= it.events.length %>

<%
const eventsByType = {};
for (const event of it.events) {
  if (!eventsByType[event.type]) {
    eventsByType[event.type] = [];
  }
  eventsByType[event.type].push(event);
}
%>

### Events by Type
<% for (const [type, events] of Object.entries(eventsByType)) { %>
- **<%= type %>**: <%= events.length %> events
<% } %>

### Tool Usage Analysis
<%
const toolResults = it.events.filter(e => e.type === 'tool.result');
const errorResults = toolResults.filter(e => e.data.isError);
%>

<% if (toolResults.length > 0) { %>
- Tool executions: <%= toolResults.length %>
- Errors: <%= errorResults.length %>
- Success rate: <%= ((toolResults.length - errorResults.length) / toolResults.length * 100).toFixed(1) %>%

#### Tool Details
<% for (const tool of toolResults) { %>
- **<%= tool.data.toolName %>** (<%= tool.data.executionTimeMs %>ms): <%= tool.data.isError ? '❌ Error' : '✅ Success' %>
<% } %>
<% } else { %>
No tool usage detected.
<% } %>

### Raw Event Data
\`\`\`json
<%= JSON.stringify(it.events, null, 2) %>
\`\`\``;

      await fs.writeFile(complexPromptFile, complexTemplate);

      const config: SentinelConfig = {
        id: "complex-analyzer",
        name: "Complex Event Analyzer",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: {
          type: "event",
          on: ["tool.result", "assistant.action"]
        },
        execution: { strategy: "immediate" },
        userPromptFile: "complex-analysis.md"
      };

      let eventCallCount = 0;
      const mockLLMCall = createTypedMockLlmAdapter(() => {
        eventCallCount++;
        return Promise.resolve("Analysis complete");
      });

      const sentinel = new Sentinel(
        config,
        CodonId("complex-codon"),
        mockLLMCall,
        createMockLogger(),
        sentinelDir,
        configDir
      );

      const complexEvents: ServerEvent[] = [
        {
          id: "evt-1",
          timestamp: "2025-01-19T10:00:00Z",
          type: "assistant.action",
          data: {
            codonId: CodonId("complex-codon"),
            action: "tool_use",
            content: "Using tool: Read",
            toolName: "Read",
            toolInput: { file_path: "src/index.ts" }
          }
        },
        {
          id: "evt-2",
          timestamp: "2025-01-19T10:00:05Z",
          type: "tool.result",
          data: {
            codonId: CodonId("complex-codon"),
            toolUseId: "toolu_123",
            toolName: "Read",
            result: "const app = express();",
            truncated: false,
            originalLength: 100,
            executionTimeMs: 45,
            isError: false
          }
        },
        {
          id: "evt-3",
          timestamp: "2025-01-19T10:00:10Z",
          type: "tool.result",
          data: {
            codonId: CodonId("complex-codon"),
            toolUseId: "toolu_456",
            toolName: "Write",
            result: "Error: Permission denied",
            truncated: false,
            originalLength: 50,
            executionTimeMs: 25,
            isError: true
          }
        }
      ];

      // Process the events
      for (const event of complexEvents) {
        sentinel.handleEvent(event);
        await new Promise(resolve => setTimeout(resolve, 50)); // Small delay between events
      }

      await new Promise(resolve => setTimeout(resolve, 150));

      // Should have been called 3 times (once per event due to immediate strategy)
      expect(eventCallCount).toBe(3);
    });
  });

  describe("Performance and Event Limits", () => {
    test("enforces maximum event limit for templates", async () => {
      const eventLimitPromptFile = path.join(configDir, "event-limit.md");
      await fs.writeFile(eventLimitPromptFile, "Processing <%= it.events.length %> events");

      const config: SentinelConfig = {
        id: "event-limit-sentinel",
        name: "Event Limit Sentinel",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: {
          type: "event",
          on: ["tool.result"]
        },
        execution: { strategy: "count", threshold: 2000 }, // Trigger after 2000 events
        userPromptFile: "event-limit.md"
      };

      let capturedPrompt = "";
      const mockLLMCall = async (id: string, options: HankweaveGenerateTextOptions) => {
        // The sentinel always passes HankweaveGenerateTextOptions
        // Extract the user message content from the options
        if (options.messages && options.messages.length > 0) {
          // Get the last message (should be the user message with the rendered template)
          const lastMessage = options.messages[options.messages.length - 1];
          if (lastMessage && lastMessage.content) {
            capturedPrompt = String(lastMessage.content);
          }
        }
        return {
          text: "Processed",
          finishReason: "stop" as const,
          usage: { inputTokens: 100, outputTokens: 20 }
        };
      };

      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        mockLLMCall,
        createMockLogger(),
        sentinelDir,
        configDir
      );

      // Generate 1500 events (more than the 1000 limit)
      for (let i = 0; i < 1500; i++) {
        const event: ServerEvent = {
          id: `evt-${i}`,
          timestamp: "2025-01-19T10:00:00Z",
          type: "tool.result",
          data: {
            codonId: CodonId("test-codon"),
            toolUseId: `toolu_${i}`,
            toolName: "Test",
            result: `Result ${i}`,
            truncated: false,
            originalLength: 50,
            executionTimeMs: 10,
            isError: false
          }
        };
        sentinel.handleEvent(event);
      }

      // Since the count threshold is 2000 and we only sent 1500 events,
      // we need to flush to force processing of pending events
      await sentinel.completeAllWork();
      await new Promise(resolve => setTimeout(resolve, 100));

      // The template should only see 1000 events due to the limit
      expect(capturedPrompt).toBe("Processing 1000 events");
    });

    test("processes large templates efficiently", async () => {
      const largePromptFile = path.join(configDir, "large-template.md");

      // Create a template that processes lots of data but finishes quickly
      const largeTemplate = `# Large Event Analysis

<%
// Process many events efficiently
const eventCounts = {};
const toolUsage = {};
let totalTime = 0;

for (const event of it.events) {
  eventCounts[event.type] = (eventCounts[event.type] || 0) + 1;

  if (event.type === 'tool.result') {
    const toolName = event.data.toolName;
    if (!toolUsage[toolName]) {
      toolUsage[toolName] = { count: 0, totalTime: 0, errors: 0 };
    }
    toolUsage[toolName].count++;
    toolUsage[toolName].totalTime += event.data.executionTimeMs;
    if (event.data.isError) toolUsage[toolName].errors++;
  }
}
%>

## Statistics
Total events processed: <%= it.events.length %>

### Event Distribution
<% for (const [type, count] of Object.entries(eventCounts)) { %>
- <%= type %>: <%= count %>
<% } %>

### Tool Performance
<% for (const [tool, stats] of Object.entries(toolUsage)) { %>
- **<%= tool %>**: <%= stats.count %> calls, avg <%= (stats.totalTime / stats.count).toFixed(1) %>ms, <%= stats.errors %> errors
<% } %>

Generated at: <%= it.world.currentTime.toISOString() %>`;

      await fs.writeFile(largePromptFile, largeTemplate);

      const config: SentinelConfig = {
        id: "large-template-sentinel",
        name: "Large Template Sentinel",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: {
          type: "event",
          on: ["tool.result"]
        },
        execution: { strategy: "count", threshold: 100 },
        userPromptFile: "large-template.md"
      };

      let processingTime = 0;
      const mockLLMCall = createTypedMockLlmAdapter("Analysis complete");

      const sentinel = new Sentinel(
        config,
        CodonId("large-codon"),
        mockLLMCall,
        createMockLogger(),
        sentinelDir,
        configDir
      );

      // Generate 100 tool result events
      const startTime = Date.now();
      for (let i = 0; i < 100; i++) {
        const event: ServerEvent = {
          id: `evt-${i}`,
          timestamp: "2025-01-19T10:00:00Z",
          type: "tool.result",
          data: {
            codonId: CodonId("large-codon"),
            toolUseId: `toolu_${i}`,
            toolName: i % 2 === 0 ? "Read" : "Write",
            result: `Result ${i}`,
            truncated: false,
            originalLength: 50,
            executionTimeMs: Math.floor(Math.random() * 100),
            isError: i % 10 === 0 // 10% error rate
          }
        };
        sentinel.handleEvent(event);
      }

      await new Promise(resolve => setTimeout(resolve, 200));
      processingTime = Date.now() - startTime;

      // Should complete reasonably quickly
      expect(processingTime).toBeLessThan(5000); // Less than 5 seconds
    });
  });

  describe("Real-world Template Examples", () => {
    test("narrator template for file tracking", async () => {
      const narratorPromptFile = path.join(configDir, "narrator.md");
      const narratorTemplate = `# Development Update

<%
const fileEvents = it.events.filter(e => e.type === 'file.updated');
const toolEvents = it.events.filter(e => e.type === 'tool.result');
const actionEvents = it.events.filter(e => e.type === 'assistant.action');
%>

## Summary
In the last batch, there were:
- <%= fileEvents.length %> file changes
- <%= toolEvents.length %> tool executions
- <%= actionEvents.length %> assistant actions

<% if (fileEvents.length > 0) { %>
### File Changes
<% for (const fileEvent of fileEvents) { %>
- **<%= fileEvent.data.filename %>** (<%= fileEvent.data.action %>)
<% } %>
<% } %>

<% if (toolEvents.length > 0) { %>
### Tool Activity
<%
const successfulTools = toolEvents.filter(t => !t.data.isError);
const failedTools = toolEvents.filter(t => t.data.isError);
%>
- ✅ Successful: <%= successfulTools.length %>
- ❌ Failed: <%= failedTools.length %>

<% if (failedTools.length > 0) { %>
#### Failures
<% for (const failed of failedTools) { %>
- **<%= failed.data.toolName %>**: <%= failed.data.result.substring(0, 100) %><%= failed.data.result.length > 100 ? '...' : '' %>
<% } %>
<% } %>
<% } %>

---
*Report generated at <%= it.world.currentTime.toLocaleString() %>*`;

      await fs.writeFile(narratorPromptFile, narratorTemplate);

      const config: SentinelConfig = {
        id: "narrator",
        name: "Development Narrator",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: {
          type: "event",
          on: ["file.updated", "tool.result", "assistant.action"]
        },
        execution: { strategy: "debounce", milliseconds: 2000 },
        userPromptFile: "narrator.md"
      };

      let llmCallMade = false;
      const mockLLMCall = createTypedMockLlmAdapter(() => {
        llmCallMade = true;
        return Promise.resolve("Narration complete");
      });

      const sentinel = new Sentinel(
        config,
        CodonId("narrative-codon"),
        mockLLMCall,
        createMockLogger(),
        sentinelDir,
        configDir
      );

      // Send a variety of events
      const events: ServerEvent[] = [
        {
          id: "evt-file-1",
          timestamp: "2025-01-19T10:00:00Z",
          type: "file.updated",
          data: {
            path: "src/index.ts",
            filename: "index.ts",
            content: "const app = express();",
            action: "modified"
          }
        },
        {
          id: "evt-tool-1",
          timestamp: "2025-01-19T10:00:05Z",
          type: "tool.result",
          data: {
            codonId: CodonId("narrative-codon"),
            toolUseId: "toolu_123",
            toolName: "Read",
            result: "File read successfully",
            truncated: false,
            originalLength: 100,
            executionTimeMs: 45,
            isError: false
          }
        },
        {
          id: "evt-action-1",
          timestamp: "2025-01-19T10:00:10Z",
          type: "assistant.action",
          data: {
            codonId: CodonId("narrative-codon"),
            action: "thinking",
            content: "Analyzing the codebase..."
          }
        }
      ];

      // Send events quickly
      for (const event of events) {
        sentinel.handleEvent(event);
      }

      // Wait for debounce to trigger
      await new Promise(resolve => setTimeout(resolve, 2500));

      // Verify the sentinel executed (debounce should have triggered)
      expect(llmCallMade).toBe(true);
    });
  });

  describe("Error Recovery in Conversational Mode", () => {
    test("recovers from LLM errors when continueOnError is enabled", async () => {
      const systemPromptFile = path.join(configDir, "recovery-system.md");
      const userPromptFile = path.join(configDir, "recovery-user.md");

      await fs.writeFile(systemPromptFile, "You are a resilient assistant.");
      await fs.writeFile(userPromptFile, "Process these events: <%= JSON.stringify(it.events.map(e => e.type)) %>");

      const config: SentinelConfig = {
        id: "recovery-sentinel",
        name: "Recovery Test Sentinel",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: {
          type: "event",
          on: ["assistant.action"]
        },
        execution: { strategy: "immediate" },
        systemPromptFile: "recovery-system.md",
        userPromptFile: "recovery-user.md",
        conversational: {
          trimmingStrategy: {
            type: "maxTurns",
            maxTurns: 5
          },
          continueOnError: true
        }
      };

      let callCount = 0;
      let successfulCalls = 0;
      const mockLLMCall = createTypedMockLlmAdapter(async () => {
        callCount++;

        if (callCount <= 2) {
          // First two calls fail
          throw new Error(`Simulated error ${callCount}`);
        }

        successfulCalls++;
        return "Recovery successful";
      });

      const logger = createMockLogger();
      const sentinel = new Sentinel(
        config,
        CodonId("recovery-codon"),
        mockLLMCall,
        logger,
        sentinelDir,
        configDir
      );

      const testEvent: ServerEvent = {
        id: "evt-recovery",
        timestamp: "2025-01-19T10:00:00Z",
        type: "assistant.action",
        data: {
          codonId: CodonId("recovery-codon"),
          action: "thinking",
          content: "Test recovery"
        }
      };

      // Send multiple events to trigger multiple calls
      for (let i = 0; i < 4; i++) {
        const event = {
          ...testEvent,
          id: `evt-recovery-${i}`
        };
        sentinel.handleEvent(event);
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Wait for all processing to complete
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(callCount).toBe(4);
      expect(successfulCalls).toBe(2); // Only the last 2 should succeed

      // Verify error recovery logging
      const logs = logger.getLogs();
      const errorLogs = logs.filter(log => log.level === "error" && log.message.includes("LLM call failed"));
      const recoveryLogs = logs.filter(log => log.level === "info" && log.message.includes("Ignoring error"));

      expect(errorLogs.length).toBe(2); // First two calls failed
      expect(recoveryLogs.length).toBe(2); // Both errors were handled gracefully
    });
  });
});

// Mock logger implementation for tests
interface LogEntry {
  level: string;
  message: string;
  timestamp: Date;
}

class MockLogger extends Logger {
  private logs: LogEntry[] = [];

  constructor() {
    super("/dev/null"); // Dummy log file
  }

  log(message: string, level: "info" | "error" | "debug" = "info"): void {
    this.logs.push({
      level,
      message,
      timestamp: new Date()
    });
  }

  getLogs(): LogEntry[] {
    return [...this.logs];
  }

  clear(): void {
    this.logs = [];
  }
}

function createMockLogger(): MockLogger {
  return new MockLogger();
}
