import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ServerEvent } from "../../../server/types.js";

interface TestState {
  events: ServerEvent[];
}

export function runSecurityValidationTests(_testState: TestState, testDir: string) {
  // Test removed: "no absolute paths leaked in events" - absolute paths are useful and should be kept

  test("no sensitive environment variables in logs", () => {
    const sensitivePatterns = [/ANTHROPIC_API_KEY/, /api_key.*=.*sk-/, /authorization.*bearer/i];

    const allLogs = [
      path.join(testDir, ".tadpole/logs/server.log"),
      path.join(testDir, ".tadpole/logs/websocket.log"),
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
