import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AssistantActionEvent } from "../../../server/types/types.js";
import { parseJSONL } from "../../utils/test-data-helpers.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
}

export function runToolUsageTests(testState: TestState, testDir: string) {
  const assistantActionEvents = testState.client?.getEventsByType("assistant.action") || [];
  const toolUseActions = assistantActionEvents.filter(
    (e) => (e as AssistantActionEvent).data?.action === "tool_use",
  );

  // Count tool types used
  const toolCounts: Record<string, number> = {};
  for (const action of toolUseActions) {
    const actionEvent = action as AssistantActionEvent;
    const toolName = actionEvent.data?.toolName || "unknown";
    toolCounts[toolName] = (toolCounts[toolName] || 0) + 1;
  }

  test("at least 4 Write tool uses", () => {
    expect(toolCounts.Write || 0).toBeGreaterThanOrEqual(4);
  });

  test("at least 1 LS tool use", () => {
    expect(toolCounts.LS || 0).toBeGreaterThanOrEqual(1);
  });

  test("at least 2 Read tool uses", () => {
    expect(toolCounts.Read || 0).toBeGreaterThanOrEqual(2);
  });

  test("tool uses reported via WebSocket for each phase", () => {
    for (const phaseId of ["phase-1", "phase-2", "phase-3"]) {
      const logPath = path.join(testDir, `.tadpole/logs/log-${phaseId}.jsonl`);
      if (fs.existsSync(logPath)) {
        const logContent = fs.readFileSync(logPath, "utf-8");
        const logEntries = parseJSONL(logContent);

        // Count assistant messages in logs
        const logAssistantMessages = logEntries.filter((e) => e.type === "assistant");
        const logToolUses = logAssistantMessages.filter((e) =>
          e.message?.content?.some(
            (c: { type?: string; name?: string }) =>
              c.type === "tool_use" && c.name !== "TodoWrite",
          ),
        ).length;

        // Count WebSocket events for this phase
        const phaseActions = assistantActionEvents.filter(
          (e) => (e as AssistantActionEvent).data?.phaseId === phaseId,
        );
        const wsToolUses = phaseActions.filter(
          (e) =>
            (e as AssistantActionEvent).data?.action === "tool_use" &&
            (e as AssistantActionEvent).data?.toolName !== "TodoWrite",
        ).length;

        expect(wsToolUses).toBeGreaterThanOrEqual(logToolUses);
      }
    }
  });
}
