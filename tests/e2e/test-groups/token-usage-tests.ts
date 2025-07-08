import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { TokenUsageEvent } from "../../../server/types.js";
import { parseJSONL } from "../../utils/test-data-helpers.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
}

export function runTokenUsageTests(testState: TestState, testDir: string) {
  const tokenUsageEvents = testState.client?.getEventsByType("token.usage") || [];

  for (const phaseId of ["phase-1", "phase-2", "phase-3"]) {
    test(`${phaseId} token usage events match log messages`, () => {
      const logPath = path.join(testDir, `.langton/logs/log-${phaseId}.jsonl`);
      if (fs.existsSync(logPath)) {
        const logContent = fs.readFileSync(logPath, "utf-8");
        const logEntries = parseJSONL(logContent);

        // Get all assistant messages with usage for this phase
        const assistantMessages = logEntries.filter(
          (e) => e.type === "assistant" && e.message?.usage,
        );

        // Get the result message
        const resultMessage = logEntries.find(
          (e) => e.type === "result" && e.subtype === "success",
        );

        // Get all token events for this phase
        const phaseTokenEvents = tokenUsageEvents.filter(
          (e) => (e as TokenUsageEvent).data?.phaseId === phaseId,
        );

        // We should have token events for each assistant message plus one for the result
        const expectedEventCount = assistantMessages.length + (resultMessage?.usage ? 1 : 0);
        expect(phaseTokenEvents.length).toBeGreaterThanOrEqual(expectedEventCount);

        // The last token event should match the result message usage if available
        if (resultMessage?.usage && phaseTokenEvents.length > 0) {
          const lastTokenEvent = phaseTokenEvents[phaseTokenEvents.length - 1] as TokenUsageEvent;
          expect(lastTokenEvent.data?.inputTokens || 0).toBe(
            resultMessage.usage.input_tokens || 0,
          );
          expect(lastTokenEvent.data?.outputTokens || 0).toBe(
            resultMessage.usage.output_tokens || 0,
          );
        }
      }
    });
  }
}