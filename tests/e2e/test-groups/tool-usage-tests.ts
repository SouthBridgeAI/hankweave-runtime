import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AssistantActionEvent } from "../../../server/types/types.js";
import { parseJSONL } from "../../utils/test-data-helpers.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
  codonModels: Record<string, string>;
}

/** Check if a model string refers to a non-Anthropic provider */
function isNonAnthropicModel(model: string): boolean {
  const lower = model.toLowerCase();
  return (
    !lower.includes("claude") &&
    !lower.includes("sonnet") &&
    !lower.includes("opus") &&
    !lower.includes("haiku")
  );
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
    const writeCount = toolCounts.Write || 0;
    const codon3IsNonAnthropic = isNonAnthropicModel(testState.codonModels["codon-3"] || "");

    if (writeCount < 4 && codon3IsNonAnthropic) {
      // Non-Anthropic models (e.g. Gemini) may not reliably create all expected files.
      // Relax to 2 (Codons 1+2 each create at least 1 file).
      console.warn(
        `Only ${writeCount} Write uses (expected ≥4) — Codon 3 model is non-Anthropic; relaxing to ≥2.`,
      );
      expect(writeCount).toBeGreaterThanOrEqual(2);
    } else {
      expect(writeCount).toBeGreaterThanOrEqual(4);
    }
  });

  test("at least 1 file-finding operation or direct data file read", () => {
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

    // Count direct reads of data files (e.g., read_only_data_source/poem_guides.txt)
    const dataReadCount = assistantActionEvents.filter((e) => {
      const actionEvent = e as AssistantActionEvent;
      if (actionEvent.data?.toolName !== "Read") return false;
      const filePath = actionEvent.data?.toolInput?.file_path;
      return typeof filePath === "string" && filePath.includes("read_only_data_source");
    }).length;

    const totalDiscoveryOps = globCount + bashFileFindingCount + dataReadCount;
    expect(totalDiscoveryOps).toBeGreaterThanOrEqual(1);
  });

  test("at least 2 Read tool uses", () => {
    expect(toolCounts.Read || 0).toBeGreaterThanOrEqual(2);
  });

  test("tool uses reported via WebSocket for each codon", () => {
    // Find the run folder - there should be exactly one
    const runsDir = path.join(testDir, ".hankweave/runs");
    let runFolder = "";

    if (fs.existsSync(runsDir)) {
      const runFolders = fs.readdirSync(runsDir);
      if (runFolders.length > 0) {
        runFolder = path.join(runsDir, runFolders[0]);
      }
    }

    if (!runFolder) return;

    for (const codonId of ["codon-1", "codon-2", "codon-3"]) {
      // Logs are now in .hankweave/runs/{runId}/codon-{codonId}-claude.log
      const logPath = path.join(runFolder, `${codonId}-claude.log`);
      if (fs.existsSync(logPath)) {
        const logContent = fs.readFileSync(logPath, "utf-8");
        const logEntries = parseJSONL(logContent);

        // Count assistant messages in logs
        const logAssistantMessages = logEntries.filter((e) => e.type === "assistant");
        const logToolUses = logAssistantMessages.filter(
          (e) =>
            typeof e.message === "object" &&
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
