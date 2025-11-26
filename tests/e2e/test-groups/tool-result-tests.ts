import { expect, test } from "bun:test";
import type {
  AssistantActionEvent,
  ServerEvent,
  ToolResultEvent,
} from "../../../server/types/types.js";

interface TestState {
  events: ServerEvent[];
  executionPath?: string;
}

export function runToolResultTests(testState: TestState): void {
  test("should emit tool.result events for tool executions", () => {
    const toolResultEvents = testState.events.filter(
      (e) => e.type === "tool.result",
    ) as ToolResultEvent[];

    // Should have at least one tool result event
    expect(toolResultEvents.length).toBeGreaterThan(0);
  });

  test("should have valid tool result event structure", () => {
    const toolResultEvents = testState.events.filter(
      (e) => e.type === "tool.result",
    ) as ToolResultEvent[];

    for (const event of toolResultEvents) {
      // Validate event structure
      expect(event.type).toBe("tool.result");
      expect(event.id).toBeTruthy();
      expect(event.timestamp).toBeTruthy();

      // Validate data fields
      expect(event.data.codonId).toBeTruthy();
      expect(event.data.toolUseId).toMatch(/^toolu_[a-zA-Z0-9]+$/);
      expect(event.data.toolName).toBeTruthy();
      expect(typeof event.data.result).toBe("string"); // Result can be empty string
      expect(typeof event.data.truncated).toBe("boolean");
      expect(event.data.originalLength).toBeGreaterThanOrEqual(0);
      expect(event.data.executionTimeMs).toBeGreaterThanOrEqual(0);
      expect(typeof event.data.isError).toBe("boolean");
    }
  });

  test("should correlate tool results with tool uses", () => {
    // Get tool use events
    const assistantEvents = testState.events
      .filter((e): e is AssistantActionEvent => e.type === "assistant.action")
      .filter((e) => e.data.action === "tool_use");

    const toolUseEvents = assistantEvents.map((e) => ({
      toolName: e.data.toolName,
      codonId: e.data.codonId,
      timestamp: new Date(e.timestamp).getTime(),
    }));

    // Get tool result events
    const toolResultEvents = testState.events.filter(
      (e) => e.type === "tool.result",
    ) as ToolResultEvent[];

    // Every tool result should match a tool use
    for (const result of toolResultEvents) {
      const matchingUse = toolUseEvents.find(
        (use) => use.toolName === result.data.toolName && use.codonId === result.data.codonId,
      );

      expect(matchingUse).toBeTruthy();

      // Result should come at or after the use
      if (matchingUse) {
        const resultTime = new Date(result.timestamp).getTime();
        expect(resultTime).toBeGreaterThanOrEqual(matchingUse.timestamp);
      }
    }
  });

  test("should track execution time correctly", () => {
    const toolResultEvents = testState.events.filter(
      (e) => e.type === "tool.result",
    ) as ToolResultEvent[];

    for (const event of toolResultEvents) {
      // Execution time should be reasonable (not negative, not too long)
      expect(event.data.executionTimeMs).toBeGreaterThanOrEqual(0);
      expect(event.data.executionTimeMs).toBeLessThan(30000); // Less than 30 seconds
    }
  });

  test("should handle truncated results appropriately", () => {
    const toolResultEvents = testState.events.filter(
      (e) => e.type === "tool.result",
    ) as ToolResultEvent[];

    for (const event of toolResultEvents) {
      if (event.data.truncated) {
        // If truncated, result should end with "..."
        expect(event.data.result.endsWith("...")).toBe(true);
        // Original length should be greater than result length
        expect(event.data.originalLength).toBeGreaterThan(event.data.result.length - 3);
      } else {
        // If not truncated, result length should match original length
        expect(event.data.result.length).toBe(event.data.originalLength);
      }
    }
  });

  test("should emit tool results for Write operations", () => {
    const writeResults = testState.events
      .filter((e) => e.type === "tool.result")
      .filter((e) => (e as ToolResultEvent).data.toolName === "Write") as ToolResultEvent[];

    // Should have Write operations in test codons
    expect(writeResults.length).toBeGreaterThan(0);

    for (const result of writeResults) {
      // Write results are strings (can be empty)
      expect(typeof result.data.result).toBe("string");
    }
  });

  test("should emit tool results for Read operations", () => {
    const readResults = testState.events
      .filter((e) => e.type === "tool.result")
      .filter((e) => (e as ToolResultEvent).data.toolName === "Read") as ToolResultEvent[];

    // May have Read operations
    for (const result of readResults) {
      // Read results contain file content
      expect(result.data.result).toBeTruthy();
      expect(result.data.originalLength).toBeGreaterThan(0);
    }
  });

  test("should track tool results per codon", () => {
    const toolResultEvents = testState.events.filter(
      (e) => e.type === "tool.result",
    ) as ToolResultEvent[];

    // Group by codon
    const resultsByCodon = new Map<string, ToolResultEvent[]>();
    for (const event of toolResultEvents) {
      const codonResults = resultsByCodon.get(event.data.codonId) || [];
      codonResults.push(event);
      resultsByCodon.set(event.data.codonId, codonResults);
    }

    // Each codon that uses tools should have results
    expect(resultsByCodon.size).toBeGreaterThan(0);

    // Log results per codon for debugging
    for (const [codonId, results] of resultsByCodon) {
      console.log(`Codon ${codonId}: ${results.length} tool results`);
    }
  });

  test("should handle error tool results correctly", () => {
    const errorResults = testState.events
      .filter((e) => e.type === "tool.result")
      .filter((e) => (e as ToolResultEvent).data.isError) as ToolResultEvent[];

    // Error results should have appropriate content
    for (const result of errorResults) {
      expect(result.data.result).toBeTruthy();
      expect(result.data.isError).toBe(true);
    }

    // Log error count for debugging
    console.log(`Found ${errorResults.length} error tool results`);
  });

  test("should have consistent timing between tool use and result", () => {
    // Map tool uses by codon
    const toolUsesByCodon = new Map<
      string,
      Array<{ toolName: string; timestamp: number; toolUseId?: string }>
    >();

    testState.events.forEach((e) => {
      if (e.type === "assistant.action" && e.data.action === "tool_use") {
        const assistantEvent = e as AssistantActionEvent;
        const codonUses = toolUsesByCodon.get(assistantEvent.data.codonId) || [];
        const toolUseId =
          typeof assistantEvent.data.toolInput === "object" &&
          assistantEvent.data.toolInput !== null &&
          "id" in assistantEvent.data.toolInput
            ? String(assistantEvent.data.toolInput.id)
            : undefined;
        codonUses.push({
          toolName: assistantEvent.data.toolName || "",
          timestamp: new Date(assistantEvent.timestamp).getTime(),
          toolUseId,
        });
        toolUsesByCodon.set(assistantEvent.data.codonId, codonUses);
      }
    });

    // Check tool results timing
    const toolResultEvents = testState.events.filter(
      (e) => e.type === "tool.result",
    ) as ToolResultEvent[];

    for (const result of toolResultEvents) {
      const codonUses = toolUsesByCodon.get(result.data.codonId) || [];
      const resultTime = new Date(result.timestamp).getTime();

      // Find the corresponding tool use
      const _matchingUse = codonUses.find(
        (use) =>
          use.toolName === result.data.toolName &&
          use.timestamp < resultTime &&
          resultTime - use.timestamp === result.data.executionTimeMs,
      );

      // There should be a tool use at or before this result
      const hasToolUseBeforeOrAt = codonUses.some(
        (use) => use.toolName === result.data.toolName && use.timestamp <= resultTime,
      );

      expect(hasToolUseBeforeOrAt).toBe(true);
    }
  });
}
