import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type TemplateContext,
  TemplateRenderer,
} from "../../server/chroniclers/prompt-templating-engine.js";
import type { ServerEvent } from "../../server/schemas/event-schemas.js";
import { PhaseId } from "../../server/types/branded-types.js";

describe("TemplateRenderer", () => {
  let mockContext: TemplateContext;

  beforeEach(() => {
    // Create realistic mock context
    const mockEvents: ServerEvent[] = [
      {
        id: "evt-1",
        timestamp: "2025-01-19T10:00:00Z",
        type: "assistant.action",
        data: {
          phaseId: PhaseId("test-phase"),
          action: "tool_use",
          content: "Using tool: Read",
          toolName: "Read",
          toolInput: { file_path: "src/index.ts" },
        },
      },
      {
        id: "evt-2",
        timestamp: "2025-01-19T10:00:05Z",
        type: "tool.result",
        data: {
          phaseId: PhaseId("test-phase"),
          toolUseId: "toolu_123",
          toolName: "Read",
          result: "const app = express();",
          truncated: false,
          originalLength: 100,
          executionTimeMs: 45,
          isError: false,
        },
      },
      {
        id: "evt-3",
        timestamp: "2025-01-19T10:00:10Z",
        type: "file.updated",
        data: {
          path: "src/index.ts",
          filename: "index.ts",
          content: "// Updated content",
          action: "modified",
        },
      },
    ];

    mockContext = {
      events: mockEvents,
      phase: {
        id: "test-phase",
        name: "Test Phase",
        description: "A test phase for validation",
        startTime: new Date("2025-01-19T09:00:00Z"),
      },
      world: {
        currentTime: new Date("2025-01-19T10:00:00Z"),
      },
    };
  });

  afterEach(() => {
    TemplateRenderer.resetCache();
  });

  describe("Basic Template Rendering", () => {
    test("renders simple text template", async () => {
      const template = "Hello <%= it.phase.name %>!";
      const result = await TemplateRenderer.render(template, mockContext);
      expect(result).toBe("Hello Test Phase!");
    });

    test("renders template with event data", async () => {
      const template = "Found <%= it.events.length %> events";
      const result = await TemplateRenderer.render(template, mockContext);
      expect(result).toBe("Found 3 events");
    });

    test("handles nested object access", async () => {
      const template = "Phase: <%= it.phase.name %> (<%=  it.phase.id %>)";
      const result = await TemplateRenderer.render(template, mockContext);
      expect(result).toBe("Phase: Test Phase (test-phase)");
    });
  });

  describe("Event Iteration and Processing", () => {
    test("iterates over events with for loop", async () => {
      const template = `<% for (const event of it.events) { %>
Event: <%= event.type %>
<% } %>`;

      const result = await TemplateRenderer.render(template, mockContext);
      expect(result.trim()).toContain("Event: assistant.action");
      expect(result.trim()).toContain("Event: tool.result");
      expect(result.trim()).toContain("Event: file.updated");
    });

    test("filters events with array methods", async () => {
      const template = `Tool events: <%= it.events.filter(e => e.type === 'tool.result').length %>`;
      const result = await TemplateRenderer.render(template, mockContext);
      expect(result).toBe("Tool events: 1");
    });

    test("maps event types", async () => {
      const template = `Types: <%= it.events.map(e => e.type).join(', ') %>`;
      const result = await TemplateRenderer.render(template, mockContext);
      expect(result).toBe("Types: assistant.action, tool.result, file.updated");
    });

    test("handles spread operators", async () => {
      const template = `<% const types = [...new Set(it.events.map(e => e.type))]; %>
Unique types: <%= types.join(', ') %>`;
      const result = await TemplateRenderer.render(template, mockContext);
      expect(result.trim()).toBe("Unique types: assistant.action, tool.result, file.updated");
    });
  });

  describe("Conditional Rendering", () => {
    test("renders conditionally based on event types", async () => {
      const template = `<% if (it.events.some(e => e.type === 'error')) { %>
⚠️ Errors detected!
<% } else { %>
✅ No errors found
<% } %>`;

      const result = await TemplateRenderer.render(template, mockContext);
      expect(result.trim()).toBe("✅ No errors found");
    });

    test("handles complex conditional logic", async () => {
      const template = `<%
        const toolEvents = it.events.filter(e => e.type === 'tool.result');
        const errorEvents = toolEvents.filter(e => e.data.isError);
      %>
<% if (errorEvents.length > 0) { %>
Errors: <%= errorEvents.length %>
<% } else if (toolEvents.length > 0) { %>
Tools executed: <%= toolEvents.length %>
<% } else { %>
No tool activity
<% } %>`;

      const result = await TemplateRenderer.render(template, mockContext);
      expect(result.trim()).toBe("Tools executed: 1");
    });
  });

  describe("JSON Serialization", () => {
    test("serializes simple objects with JSON.stringify", async () => {
      const template = `Events: <%= JSON.stringify(it.events.map(e => ({type: e.type, id: e.id}))) %>`;
      const result = await TemplateRenderer.render(template, mockContext);

      const parsed = JSON.parse(result.replace("Events: ", ""));
      expect(parsed).toEqual([
        { type: "assistant.action", id: "evt-1" },
        { type: "tool.result", id: "evt-2" },
        { type: "file.updated", id: "evt-3" },
      ]);
    });

    test("handles indented JSON output", async () => {
      const template = `<%= JSON.stringify({phase: it.phase.name}, null, 2) %>`;
      const result = await TemplateRenderer.render(template, mockContext);
      expect(result).toContain('{\n  "phase": "Test Phase"\n}');
    });
  });

  describe("Complex ServerEvent Data Handling", () => {
    test("handles tool.result events with large outputs", async () => {
      const largeResultEvent: ServerEvent = {
        id: "evt-large",
        timestamp: "2025-01-19T10:00:00Z",
        type: "tool.result",
        data: {
          phaseId: PhaseId("test-phase"),
          toolUseId: "toolu_456",
          toolName: "Write",
          result: "x".repeat(5000), // Large result
          truncated: true,
          originalLength: 10000,
          executionTimeMs: 150,
          isError: false,
        },
      };

      const contextWithLargeEvent = {
        ...mockContext,
        events: [largeResultEvent],
      };

      const template = `Tool result length: <%= it.events[0].data.result.length %>
Original length: <%= it.events[0].data.originalLength %>
Truncated: <%= it.events[0].data.truncated %>`;

      const result = await TemplateRenderer.render(template, contextWithLargeEvent);
      expect(result).toContain("Tool result length: 5000");
      expect(result).toContain("Original length: 10000");
      expect(result).toContain("Truncated: true");
    });

    test("handles assistant.action events with complex tool input", async () => {
      const complexActionEvent: ServerEvent = {
        id: "evt-complex",
        timestamp: "2025-01-19T10:00:00Z",
        type: "assistant.action",
        data: {
          phaseId: PhaseId("test-phase"),
          action: "tool_use",
          content: "Using tool: Execute",
          toolName: "Execute",
          toolInput: {
            command: "npm test",
            options: { cwd: "/project", timeout: 30000 },
            env: { NODE_ENV: "test" },
          },
        },
      };

      const contextWithComplex = {
        ...mockContext,
        events: [complexActionEvent],
      };

      const template = `Command: <%= it.events[0].data.toolInput.command %>
Environment: <%= JSON.stringify(it.events[0].data.toolInput.env) %>`;

      const result = await TemplateRenderer.render(template, contextWithComplex);
      expect(result).toContain("Command: npm test");
      expect(result).toContain("NODE_ENV");
      expect(result).toContain("test");
    });
  });

  describe("Error Handling", () => {
    test("throws on template syntax errors", async () => {
      const template = "Bad syntax: <%= unclosed tag";

      await expect(TemplateRenderer.render(template, mockContext)).rejects.toThrow(
        "Template rendering failed:",
      );
    });

    test("throws on template runtime errors", async () => {
      const template = "Error: <%= it.nonexistent.property %>";

      await expect(TemplateRenderer.render(template, mockContext)).rejects.toThrow(
        "Template rendering failed:",
      );
    });

    test("handles undefined/null values gracefully", async () => {
      const contextWithNulls = {
        ...mockContext,
        phase: {
          ...mockContext.phase,
          description: undefined,
        },
      };

      const template = `Description: <%= it.phase.description || 'None' %>`;
      const result = await TemplateRenderer.render(template, contextWithNulls);
      expect(result).toBe("Description: None");
    });
  });

  describe("Template Caching", () => {
    test("uses Eta's native caching", async () => {
      const template = "Hello <%= it.phase.name %>!";

      // First call - should compile and cache
      const result1 = await TemplateRenderer.render(template, mockContext);
      expect(result1).toBe("Hello Test Phase!");

      // Second call - should use cached version
      const result2 = await TemplateRenderer.render(template, mockContext);
      expect(result2).toBe("Hello Test Phase!");

      // Templates should work consistently with Eta's native caching
      expect(result1).toBe(result2);
    });

    test("cache can be reset", async () => {
      const template = "Test <%= it.phase.name %>";
      await TemplateRenderer.render(template, mockContext);

      // Just verify that reset doesn't throw errors
      TemplateRenderer.resetCache();

      // Template should still work after reset
      const result = await TemplateRenderer.render(template, mockContext);
      expect(result).toContain("Test Test Phase");
    });
  });

  describe("Event Limit Handling", () => {
    test("limits events to MAX_EVENTS_FOR_TEMPLATE", async () => {
      // Import the constant
      const { MAX_EVENTS_FOR_TEMPLATE } = await import(
        "../../server/chroniclers/prompt-templating-engine.js"
      );

      // Create more events than the limit
      const manyEvents: ServerEvent[] = [];
      for (let i = 0; i < MAX_EVENTS_FOR_TEMPLATE + 500; i++) {
        manyEvents.push({
          id: `evt-${i}`,
          timestamp: "2025-01-19T10:00:00Z",
          type: "assistant.action",
          data: {
            phaseId: PhaseId("test-phase"),
            action: "thinking",
            content: `Thought ${i}`,
          },
        });
      }

      const largeContext = {
        ...mockContext,
        events: manyEvents,
      };

      const template = `Processing <%= it.events.length %> events`;
      const result = await TemplateRenderer.render(template, largeContext);

      // Should only see MAX_EVENTS_FOR_TEMPLATE events, not the full amount
      expect(result).toBe(`Processing ${MAX_EVENTS_FOR_TEMPLATE} events`);
    });

    test("completes complex templates efficiently", async () => {
      const template = `<%
        // Complex but finite computation
        let result = 0;
        for(let i = 0; i < 1000; i++) {
          result += i;
        }
      %>
Result: <%= result %>`;

      const result = await TemplateRenderer.render(template, mockContext);
      expect(result.trim()).toBe("Result: 499500");
    });
  });

  describe("Real ServerEvent Scenarios", () => {
    test("handles token.usage events", async () => {
      const tokenEvent: ServerEvent = {
        id: "evt-token",
        timestamp: "2025-01-19T10:00:00Z",
        type: "token.usage",
        data: {
          phaseId: PhaseId("test-phase"),
          inputTokens: 1024,
          outputTokens: 512,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalCost: 0.0045,
        },
      };

      const context = {
        ...mockContext,
        events: [tokenEvent],
      };

      const template = `Cost: $<%= it.events[0].data.totalCost.toFixed(4) %>
Tokens: <%= it.events[0].data.inputTokens + it.events[0].data.outputTokens %>`;

      const result = await TemplateRenderer.render(template, context);
      expect(result).toContain("Cost: $0.0045");
      expect(result).toContain("Tokens: 1536");
    });

    test("handles phase.completed events", async () => {
      const phaseCompletedEvent: ServerEvent = {
        id: "evt-complete",
        timestamp: "2025-01-19T10:00:00Z",
        type: "phase.completed",
        data: {
          phaseId: PhaseId("test-phase"),
          success: true,
          cost: 0.123,
          duration: 300000,
          exitStatus: { type: "success" },
        },
      };

      const context = {
        ...mockContext,
        events: [phaseCompletedEvent],
      };

      const template = `Phase completed: <%= it.events[0].data.success ? 'SUCCESS' : 'FAILED' %>
Duration: <%= (it.events[0].data.duration / 1000).toFixed(1) %>s
Cost: $<%= it.events[0].data.cost %>`;

      const result = await TemplateRenderer.render(template, context);
      expect(result).toContain("Phase completed: SUCCESS");
      expect(result).toContain("Duration: 300.0s");
      expect(result).toContain("Cost: $0.123");
    });

    test("handles error events", async () => {
      const errorEvent: ServerEvent = {
        id: "evt-error",
        timestamp: "2025-01-19T10:00:00Z",
        type: "error",
        data: {
          message: "Something went wrong",
          fatal: false,
          severity: "operation",
        },
      };

      const context = {
        ...mockContext,
        events: [errorEvent],
      };

      const template = `<% if (it.events.some(e => e.type === 'error')) { %>
🚨 ERROR: <%= it.events.find(e => e.type === 'error').data.message %>
Severity: <%= it.events.find(e => e.type === 'error').data.severity.toUpperCase() %>
<% } %>`;

      const result = await TemplateRenderer.render(template, context);
      expect(result.trim()).toContain("🚨 ERROR: Something went wrong");
      expect(result.trim()).toContain("Severity: OPERATION");
    });
  });

  describe("Date and Time Handling", () => {
    test("formats dates correctly", async () => {
      const template = `Phase started: <%= it.phase.startTime.toISOString() %>
Current time: <%= it.world.currentTime.toISOString() %>`;

      const result = await TemplateRenderer.render(template, mockContext);
      expect(result).toContain("Phase started: 2025-01-19T09:00:00.000Z");
      expect(result).toContain("Current time: 2025-01-19T10:00:00.000Z");
    });

    test("calculates time differences", async () => {
      const template = `Duration: <%= Math.floor((it.world.currentTime - it.phase.startTime) / 1000 / 60) %> minutes`;
      const result = await TemplateRenderer.render(template, mockContext);
      expect(result).toBe("Duration: 60 minutes");
    });
  });

  describe("Edge Cases", () => {
    test("handles empty events array", async () => {
      const emptyContext = {
        ...mockContext,
        events: [],
      };

      const template = `<% if (it.events.length === 0) { %>
No events to process
<% } else { %>
Processing <%= it.events.length %> events
<% } %>`;

      const result = await TemplateRenderer.render(template, emptyContext);
      expect(result.trim()).toBe("No events to process");
    });

    test("handles malformed event data gracefully", async () => {
      const malformedEvent = {
        id: "evt-bad",
        timestamp: "invalid-date",
        type: "custom.event",
        data: null,
      } as unknown as ServerEvent;

      const contextWithBadEvent = {
        ...mockContext,
        events: [malformedEvent],
      };

      const template = `Event type: <%= it.events[0].type %>
Data: <%= JSON.stringify(it.events[0].data) %>`;

      const result = await TemplateRenderer.render(template, contextWithBadEvent);
      expect(result).toContain("Event type: custom.event");
      expect(result).toContain("Data: null");
    });

    test("handles very large event arrays", async () => {
      const largeEvents: ServerEvent[] = [];
      for (let i = 0; i < 1000; i++) {
        largeEvents.push({
          id: `evt-${i}`,
          timestamp: "2025-01-19T10:00:00Z",
          type: "assistant.action",
          data: {
            phaseId: PhaseId("test-phase"),
            action: "thinking",
            content: `Thought ${i}`,
          },
        });
      }

      const largeContext = {
        ...mockContext,
        events: largeEvents,
      };

      const template = `Processed <%= it.events.length %> events
First: <%= it.events[0].id %>
Last: <%= it.events[it.events.length - 1].id %>`;

      const result = await TemplateRenderer.render(template, largeContext);
      expect(result).toContain("Processed 1000 events");
      expect(result).toContain("First: evt-0");
      expect(result).toContain("Last: evt-999");
    });
  });

  describe("Template Syntax Edge Cases", () => {
    test("handles nested loops", async () => {
      const template = `<%
        const groupedEvents = {};
        for (const event of it.events) {
          if (!groupedEvents[event.type]) {
            groupedEvents[event.type] = [];
          }
          groupedEvents[event.type].push(event);
        }
      %>
<% for (const [type, events] of Object.entries(groupedEvents)) { %>
Type: <%= type %> (<%= events.length %> events)
<% for (const event of events) { %>
  - <%= event.id %>
<% } %>
<% } %>`;

      const result = await TemplateRenderer.render(template, mockContext);
      expect(result).toContain("Type: assistant.action (1 events)");
      expect(result).toContain("- evt-1");
      expect(result).toContain("Type: tool.result (1 events)");
      expect(result).toContain("- evt-2");
    });

    test("handles template with functions and closures", async () => {
      const template = `<%
        const formatEvent = (event) => {
          return \`\${event.type} at \${event.timestamp}\`;
        };

        const eventSummaries = it.events.map(formatEvent);
      %>
Summary:
<% for (const summary of eventSummaries) { %>
- <%= summary %>
<% } %>`;

      const result = await TemplateRenderer.render(template, mockContext);
      expect(result).toContain("- assistant.action at 2025-01-19T10:00:00Z");
      expect(result).toContain("- tool.result at 2025-01-19T10:00:05Z");
      expect(result).toContain("- file.updated at 2025-01-19T10:00:10Z");
    });
  });
});
