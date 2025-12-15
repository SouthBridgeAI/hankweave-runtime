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

  test("at least 1 file-finding operation (Glob, find, or ls)", () => {
    // Count Glob tool uses
    const globCount = toolCounts.Glob || 0;

    // Count Bash commands that use find or ls for file discovery
    const bashFileFindingCount = assistantActionEvents.filter((e) => {
      const actionEvent = e as AssistantActionEvent;
      if (actionEvent.data?.toolName !== "Bash") return false;
      const command = actionEvent.data?.toolInput?.command;
      // Check for find or ls commands - ensure command is a string
      if (typeof command !== "string") return false;
      return /\b(find|ls)\b/.test(command);
    }).length;

    const totalFileFindingOps = globCount + bashFileFindingCount;
    expect(totalFileFindingOps).toBeGreaterThanOrEqual(1);
  });

  test("at least 2 Read tool uses", () => {
    expect(toolCounts.Read || 0).toBeGreaterThanOrEqual(2);
  });

  test("tool uses reported via WebSocket for each codon", () => {
    // Find the run folder - there should be exactly one
    const runsDir = path.join(testDir, ".strandweave/runs");
    let runFolder = "";

    if (fs.existsSync(runsDir)) {
      const runFolders = fs.readdirSync(runsDir);
      if (runFolders.length > 0) {
        runFolder = path.join(runsDir, runFolders[0]);
      }
    }

    if (!runFolder) return;

    for (const codonId of ["codon-1", "codon-2", "codon-3"]) {
      // Logs are now in .strandweave/runs/{runId}/codon-{codonId}-claude.log
      const logPath = path.join(runFolder, `${codonId}-claude.log`);
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

        // Count WebSocket events for this codon
        const codonActions = assistantActionEvents.filter(
          (e) => (e as AssistantActionEvent).data?.codonId === codonId,
        );
        const wsToolUses = codonActions.filter(
          (e) =>
            (e as AssistantActionEvent).data?.action === "tool_use" &&
            (e as AssistantActionEvent).data?.toolName !== "TodoWrite",
        ).length;

        expect(wsToolUses).toBeGreaterThanOrEqual(logToolUses);
      }
    }
  });
}
