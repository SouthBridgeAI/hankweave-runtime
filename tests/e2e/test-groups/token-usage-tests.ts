import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { TokenUsageEvent } from "../../../server/types/types.js";
import { parseJSONL } from "../../utils/test-data-helpers.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
}

export function runTokenUsageTests(testState: TestState, testDir: string) {
  const tokenUsageEvents = testState.client?.getEventsByType("token.usage") || [];

  for (const codonId of ["codon-1", "codon-2", "codon-3"]) {
    test(`${codonId} token usage events match log messages`, () => {
      // Log files are now in .strandweave/runs/{runId}/{codonId}-claude.log
      // We need to find the run directory first
      const runsDir = path.join(testDir, ".strandweave/runs");
      let runFolder = "";
      if (fs.existsSync(runsDir)) {
        const runFolders = fs.readdirSync(runsDir);
        if (runFolders.length > 0) {
          runFolder = path.join(runsDir, runFolders[0]);
        }
      }

      if (runFolder) {
        const logPath = path.join(runFolder, `${codonId}-claude.log`);
        if (fs.existsSync(logPath)) {
          const logContent = fs.readFileSync(logPath, "utf-8");
          const logEntries = parseJSONL(logContent);

          // Get all assistant messages with usage for this codon
          const assistantMessages = logEntries.filter(
            (e) => e.type === "assistant" && typeof e.message === "object" && e.message?.usage,
          );

          // Get the result message
          const resultMessage = logEntries.find(
            (e) => e.type === "result" && e.subtype === "success",
          );

          // Get all token events for this codon
          const codonTokenEvents = tokenUsageEvents.filter(
            (e) => (e as TokenUsageEvent).data?.codonId === codonId,
          );

          // We should have token events for each assistant message plus one for the result
          const expectedEventCount = assistantMessages.length + (resultMessage?.usage ? 1 : 0);
          expect(codonTokenEvents.length).toBeGreaterThanOrEqual(expectedEventCount);

          // The last token event should match the result message usage if available
          if (resultMessage?.usage && codonTokenEvents.length > 0) {
            const lastTokenEvent = codonTokenEvents[codonTokenEvents.length - 1] as TokenUsageEvent;
            expect(lastTokenEvent.data?.inputTokens || 0).toBe(
              resultMessage.usage.input_tokens || 0,
            );
            expect(lastTokenEvent.data?.outputTokens || 0).toBe(
              resultMessage.usage.output_tokens || 0,
            );
          }
        }
      }
    });
  }
}
