import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { FileUpdatedEvent } from "../../../server/types.js";

interface TestState {
  events: any[];
}

export function runSecurityValidationTests(testState: TestState, testDir: string) {
  test("no absolute paths leaked in events", () => {
    const absolutePathRegex = /^\/|^[A-Z]:\\/;

    testState.events.forEach((event) => {
      const eventStr = JSON.stringify(event);
      // Check for common absolute path patterns
      expect(eventStr).not.toMatch(/\/home\/[^"]+/);
      expect(eventStr).not.toMatch(/\/Users\/[^"]+/);
      expect(eventStr).not.toMatch(/C:\\Users\\/);

      // Specific checks for file events
      if (event.type === "file.updated") {
        const fileEvent = event as FileUpdatedEvent;
        expect(fileEvent.data?.path).not.toMatch(absolutePathRegex);
      }
    });
  });

  test("no sensitive environment variables in logs", () => {
    const sensitivePatterns = [/ANTHROPIC_API_KEY/, /api_key.*=.*sk-/, /authorization.*bearer/i];

    const allLogs = [
      path.join(testDir, ".langton/logs/server.log"),
      path.join(testDir, ".langton/logs/websocket.log"),
    ];

    allLogs.forEach((logPath) => {
      if (fs.existsSync(logPath)) {
        const content = fs.readFileSync(logPath, "utf-8");
        sensitivePatterns.forEach((pattern) => {
          expect(content).not.toMatch(pattern);
        });
      }
    });
  });
}
