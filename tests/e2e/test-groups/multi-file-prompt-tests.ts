import { expect, test } from "bun:test";
import * as fs from "node:fs";
import type {
  AssistantActionEvent,
  CodonCompletedEvent,
  CodonStartedEvent,
  ServerEvent,
} from "../../../server/types/types.js";

interface TestState {
  events: ServerEvent[];
  codon3Started: CodonStartedEvent | null;
  codon3Completed: CodonCompletedEvent | null;
}

export function runMultiFilePromptTests(testState: TestState, codonsConfig: string) {
  test("multi-file prompts are concatenated correctly", () => {
    // Codon 3 uses array of prompt files
    const configContent = fs.readFileSync(codonsConfig, "utf-8");
    const codons = JSON.parse(configContent);
    const codon3Config = codons.find((p: { id: string }) => p.id === "codon-3");

    if (Array.isArray(codon3Config?.promptFile)) {
      // Check that all files were read
      const codon3Actions = testState.events
        .filter((e) => e.type === "assistant.action")
        .filter((e) => {
          const timestamp = new Date(e.timestamp).getTime();
          const start = new Date(testState.codon3Started?.timestamp || 0).getTime();
          const end = new Date(testState.codon3Completed?.timestamp || Date.now()).getTime();
          return timestamp >= start && timestamp <= end;
        });

      // Assistant should reference content from both prompt files
      const hasReferenceToBothPoems = codon3Actions.some((e) => {
        const content = (e as AssistantActionEvent).data?.content || "";
        return content.includes("favorite") && content.includes("second");
      });

      expect(hasReferenceToBothPoems).toBe(true);
    }
  });
}
