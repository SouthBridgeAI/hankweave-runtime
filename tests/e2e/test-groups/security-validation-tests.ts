import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ServerEvent } from "../../../server/types/types.js";

interface TestState {
  events: ServerEvent[];
}

export function runSecurityValidationTests(_testState: TestState, testDir: string) {
  // Test removed: "no absolute paths leaked in events" - absolute paths are useful and should be kept

  test("no sensitive environment variables in logs", () => {
    // Check for actual sensitive VALUES, not environment variable NAMES
    // Logging env var names (like "using ANTHROPIC_API_KEY") is fine for debugging
    const sensitivePatterns = [
      /sk-ant-[a-zA-Z0-9_-]{95,}/, // Anthropic API key values
      /sk-[a-zA-Z0-9]{48}/, // OpenAI API key values
      /gsk_[a-zA-Z0-9]{52}/, // Groq API key values
      /authorization:\s*bearer\s+[a-zA-Z0-9_-]+/i, // Authorization headers with tokens
      /api_key['"]?\s*[:=]\s*['"]?sk-/, // API key assignment with value
    ];

    const allLogs = [
      path.join(testDir, ".hankweave/logs/server.log"),
      path.join(testDir, ".hankweave/logs/websocket.log"),
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
