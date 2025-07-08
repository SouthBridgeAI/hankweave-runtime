import { expect, test } from "bun:test";
import * as fs from "node:fs";
import type {
  AssistantActionEvent,
  PhaseCompletedEvent,
  PhaseStartedEvent,
  ServerEvent,
} from "../../../server/types.js";

interface TestState {
  events: ServerEvent[];
  phase3Started: PhaseStartedEvent | null;
  phase3Completed: PhaseCompletedEvent | null;
}

export function runMultiFilePromptTests(testState: TestState, phasesConfig: string) {
  test("multi-file prompts are concatenated correctly", () => {
    // Phase 3 uses array of prompt files
    const configContent = fs.readFileSync(phasesConfig, "utf-8");
    const phases = JSON.parse(configContent);
    const phase3Config = phases.find((p: { id: string }) => p.id === "phase-3");

    if (Array.isArray(phase3Config?.promptFile)) {
      // Check that all files were read
      const phase3Actions = testState.events
        .filter((e) => e.type === "assistant.action")
        .filter((e) => {
          const timestamp = new Date(e.timestamp).getTime();
          const start = new Date(testState.phase3Started?.timestamp || 0).getTime();
          const end = new Date(testState.phase3Completed?.timestamp || Date.now()).getTime();
          return timestamp >= start && timestamp <= end;
        });

      // Assistant should reference content from both prompt files
      const hasReferenceToBothPoems = phase3Actions.some((e) => {
        const content = (e as AssistantActionEvent).data?.content || "";
        return content.includes("favorite") && content.includes("second");
      });

      expect(hasReferenceToBothPoems).toBe(true);
    }
  });
}
