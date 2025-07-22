import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ClaudeLogParser } from "../../server/claude-log-parser.js";
import { logMessageSchema } from "../../types/claude-session-schema.js";
import type {
  AssistantMessage,
  LogMessage,
  ResultMessage,
  SystemMessage,
} from "../../types/claude-session-schema.js";
import { calculateCost } from "../../server/config.js";
import type { TokenUsage } from "../../server/types.js";

// Local helper for testing log parsing - replaces the removed loadPhaseStateFromLog
function parseLogForTesting(
  logPath: string,
  costsPerMTok: {
    input: number;
    output: number;
    inputCache: number;
    cacheRead: number;
  }
): {
  sessionId: string | null;
  success: boolean;
  cost: number;
  tokens: TokenUsage;
} {
  let sessionId: string | null = null;
  let success = false;
  const tokens: TokenUsage & { _totalCost?: number } = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };

  try {
    if (!fs.existsSync(logPath)) {
      return { sessionId, success, cost: 0, tokens };
    }

    const content = fs.readFileSync(logPath, "utf8");
    const lines = content.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const result = logMessageSchema.safeParse(JSON.parse(trimmed));
        if (!result.success) continue;

        const entry = result.data;

        if (entry.type === "system" && entry.subtype === "init") {
          sessionId = entry.session_id;
        }

        if (entry.type === "result") {
          // Mark success only if subtype is "success" AND is_error is false
          if (entry.subtype === "success" && !entry.is_error) {
            success = true;
          }

          // Use final usage from result message if available (for both success and error)
          if (entry.usage) {
            tokens.inputTokens = entry.usage.input_tokens || 0;
            tokens.outputTokens = entry.usage.output_tokens || 0;
            tokens.cacheCreationTokens =
              entry.usage.cache_creation_input_tokens || 0;
            tokens.cacheReadTokens = entry.usage.cache_read_input_tokens || 0;
          }

          // If total_cost_usd is provided, we'll use it directly in cost calculation
          if (entry.total_cost_usd !== undefined) {
            // Store it temporarily - we'll return it directly
            tokens._totalCost = entry.total_cost_usd;
          }
        }

        // Only use assistant message usage if we haven't found result usage yet
        if (
          entry.type === "assistant" &&
          entry.message.usage &&
          !tokens._totalCost
        ) {
          // Claude reports cumulative usage, so we take the last one
          const usage = entry.message.usage;
          tokens.inputTokens = usage.input_tokens || 0;
          tokens.outputTokens = usage.output_tokens || 0;
          tokens.cacheCreationTokens = usage.cache_creation_input_tokens || 0;
          tokens.cacheReadTokens = usage.cache_read_input_tokens || 0;
        }
      } catch {
        // Skip invalid lines
      }
    }

    // Use the total cost from result message if available, otherwise calculate
    const tokensWithCost = tokens as TokenUsage & { _totalCost?: number };
    const cost =
      tokensWithCost._totalCost !== undefined
        ? tokensWithCost._totalCost
        : calculateCost(tokens, costsPerMTok);

    // Clean up temporary property
    if (tokensWithCost._totalCost !== undefined) {
      delete tokensWithCost._totalCost;
    }

    return { sessionId, success, cost, tokens };
  } catch (error) {
    console.error(`Error loading state from log ${logPath}:`, error);
    return { sessionId, success: false, cost: 0, tokens };
  }
}

describe("Real Claude Logs Validation", () => {
  const testLogsBaseDir = path.join(
    import.meta.dir,
    "../test-data/claude-logs"
  );

  // Auto-discover all .jsonl files in test-claude-logs directory
  function findAllLogFiles(dir: string): string[] {
    const files: string[] = [];

    function scanDir(currentDir: string) {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          files.push(fullPath);
        }
      }
    }

    if (fs.existsSync(dir)) {
      scanDir(dir);
    }

    return files;
  }

  const logFiles = findAllLogFiles(testLogsBaseDir);

  // Helper to get relative path for better test names
  const getRelativePath = (fullPath: string) =>
    path.relative(testLogsBaseDir, fullPath);

  // Log discovered files at test startup
  if (logFiles.length > 0) {
    console.log(
      `\nDiscovered ${logFiles.length} log files in test-claude-logs:`
    );
    logFiles.forEach((file) => {
      const size = fs.statSync(file).size;
      console.log(
        `  - ${getRelativePath(file)} (${(size / 1024 / 1024).toFixed(2)} MB)`
      );
    });
  } else {
    console.log("\nNo log files found in test-claude-logs directory");
  }

  describe("Log file parsing", () => {
    test.each(logFiles.map((f) => [getRelativePath(f), f]))(
      "should parse all entries in %s",
      async (relativePath, logPath) => {
        const content = fs.readFileSync(logPath, "utf-8");
        const lines = content.split("\n").filter((line) => line.trim());

        let validCount = 0;
        let invalidCount = 0;
        const errors: Array<{ line: number; error: string }> = [];

        for (let i = 0; i < lines.length; i++) {
          try {
            const parsed = JSON.parse(lines[i]);
            const result = logMessageSchema.safeParse(parsed);

            if (result.success) {
              validCount++;
            } else {
              invalidCount++;
              errors.push({
                line: i + 1,
                error: result.error.errors.map((e) => e.message).join(", "),
              });
            }
          } catch (e) {
            invalidCount++;
            errors.push({
              line: i + 1,
              error: e instanceof Error ? e.message : "Invalid JSON",
            });
          }
        }

        // Log errors for debugging
        if (errors.length > 0) {
          console.log(`\nErrors in ${relativePath}:`);
          errors.slice(0, 5).forEach((err) => {
            console.log(`  Line ${err.line}: ${err.error}`);
          });
          if (errors.length > 5) {
            console.log(`  ... and ${errors.length - 5} more errors`);
          }
        }

        expect(validCount).toBeGreaterThan(0);
        expect(invalidCount).toBe(0); // All entries should be valid
      }
    );

    test.each(logFiles.map((f) => [getRelativePath(f), f]))(
      "should have required message types in %s",
      (relativePath, logPath) => {
        const content = fs.readFileSync(logPath, "utf-8");
        const lines = content.split("\n").filter((line) => line.trim());

        const messageTypes = new Set<string>();
        let hasInit = false;
        let hasResult = false;

        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            const result = logMessageSchema.safeParse(parsed);

            if (result.success) {
              const msg = result.data;
              messageTypes.add(msg.type);

              if (msg.type === "system" && msg.subtype === "init") {
                hasInit = true;
              } else if (msg.type === "result") {
                hasResult = true;
              }
            }
          } catch {
            // Skip invalid lines
          }
        }

        expect(hasInit).toBe(true); // Should have initialization
        expect(hasResult).toBe(true); // Should have result
        expect(messageTypes.size).toBeGreaterThan(1); // Should have multiple message types
      }
    );
  });

  describe("Session data extraction", () => {
    test.each(logFiles.map((f) => [getRelativePath(f), f]))(
      "should extract session ID from %s",
      (relativePath, logPath) => {
        const content = fs.readFileSync(logPath, "utf-8");
        const lines = content.split("\n").filter((line) => line.trim());

        let sessionId: string | null = null;

        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            const result = logMessageSchema.safeParse(parsed);

            if (
              result.success &&
              result.data.type === "system" &&
              result.data.subtype === "init"
            ) {
              sessionId = result.data.session_id;
              break;
            }
          } catch {
            // Skip invalid lines
          }
        }

        expect(sessionId).toBeTruthy();
        expect(sessionId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        );
      }
    );

    test.each(logFiles.map((f) => [getRelativePath(f), f]))(
      "should calculate costs from %s",
      (relativePath, logPath) => {
        const state = parseLogForTesting(logPath, {
          input: 3,
          output: 15,
          inputCache: 3.75,
          cacheRead: 0.3,
        });

        expect(state.sessionId).toBeTruthy();
        expect(state.cost).toBeGreaterThanOrEqual(0);
        expect(state.tokens.inputTokens).toBeGreaterThanOrEqual(0);
        expect(state.tokens.outputTokens).toBeGreaterThanOrEqual(0);
      }
    );
  });

  describe("API Timeout Detection", () => {
    // Find logs that contain timeout errors
    const timeoutLogs = logFiles.filter((logPath) => {
      const content = fs.readFileSync(logPath, "utf-8");
      return content.includes("API Error: Request timed out.");
    });

    test.each(timeoutLogs.map((f) => [getRelativePath(f), f]))(
      "should detect timeout error in %s",
      (relativePath, logPath) => {
        const content = fs.readFileSync(logPath, "utf-8");
        const lines = content.split("\n").filter((line) => line.trim());

        let foundTimeoutInAssistant = false;
        let foundTimeoutInResult = false;
        let timeoutMessage: AssistantMessage | null = null;
        let resultMessage: ResultMessage | null = null;

        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            const result = logMessageSchema.safeParse(parsed);

            if (result.success) {
              const msg = result.data;

              // Check assistant message for timeout (including synthetic messages)
              if (msg.type === "assistant") {
                const content = msg.message.content;
                let hasTimeoutText = false;

                if (Array.isArray(content)) {
                  hasTimeoutText = content.some(
                    (item) =>
                      item.type === "text" &&
                      item.text === "API Error: Request timed out."
                  );
                } else if (typeof content === "string") {
                  hasTimeoutText = content === "API Error: Request timed out.";
                }

                if (hasTimeoutText) {
                  foundTimeoutInAssistant = true;
                  timeoutMessage = msg;
                }
              }

              // Check result message for timeout
              if (
                msg.type === "result" &&
                msg.result === "API Error: Request timed out."
              ) {
                foundTimeoutInResult = true;
                resultMessage = msg;
              }
            }
          } catch {
            // Skip invalid lines
          }
        }

        expect(foundTimeoutInAssistant).toBe(true);
        expect(foundTimeoutInResult).toBe(true);
        expect(timeoutMessage).toBeTruthy();
        expect(resultMessage).toBeTruthy();
        // Can be either "error" subtype or "success" with is_error=true
        expect(resultMessage?.is_error).toBe(true);
      }
    );

    test.each(timeoutLogs.map((f) => [getRelativePath(f), f]))(
      "should parse timeout phase state correctly for %s",
      (relativePath, logPath) => {
        const state = parseLogForTesting(logPath, {
          input: 3,
          output: 15,
          inputCache: 3.75,
          cacheRead: 0.3,
        });

        expect(state.success).toBe(false); // Phase failed due to timeout
        expect(state.sessionId).toBeTruthy(); // Should have a session ID
        expect(state.cost).toBeGreaterThan(0); // Should have some cost
        expect(state.tokens.inputTokens).toBeGreaterThanOrEqual(0);
        expect(state.tokens.outputTokens).toBeGreaterThanOrEqual(0);
      }
    );
  });

  describe("Log Parser with real files", () => {
    // Use the first available log file for parser tests
    const firstLog = logFiles[0];
    const firstLogName = firstLog ? getRelativePath(firstLog) : "no logs found";

    test.skipIf(!firstLog)(
      `should parse ${firstLogName} in real-time`,
      async () => {
        const logPath = firstLog;
        const messages = {
          system: 0,
          assistant: 0,
          user: 0,
          result: 0,
        };

        const parser = new ClaudeLogParser({
          logPath,
          phaseId: "phase-1",
          parsingInterval: 50,
          onSystemMessage: () => messages.system++,
          onAssistantMessage: () => messages.assistant++,
          onResultMessage: () => messages.result++,
        });

        // Since we're reading an existing file, the parser should immediately
        // read all messages on the first parse
        parser.start();

        // Wait for parsing
        await new Promise((resolve) => setTimeout(resolve, 100));

        parser.stop();

        expect(messages.system).toBeGreaterThan(0);
        expect(messages.assistant).toBeGreaterThan(0);
        expect(messages.result).toBeGreaterThan(0);
      }
    );

    // Find logs that have thinking content
    const logsWithThinking = logFiles.filter((logPath) => {
      const content = fs.readFileSync(logPath, "utf-8");
      return content.includes('"type":"thinking"');
    });

    test.skipIf(logsWithThinking.length === 0)(
      "should handle thinking content in messages",
      () => {
        const logPath = logsWithThinking[0] || logFiles[0];
        const content = fs.readFileSync(logPath, "utf-8");
        const lines = content.split("\n").filter((line) => line.trim());

        let foundThinking = false;

        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            const result = logMessageSchema.safeParse(parsed);

            if (result.success && result.data.type === "assistant") {
              const msgContent = result.data.message.content;
              if (Array.isArray(msgContent)) {
                const hasThinking = msgContent.some(
                  (item) => item.type === "thinking"
                );
                if (hasThinking) {
                  foundThinking = true;
                  break;
                }
              }
            }
          } catch {
            // Skip invalid lines
          }
        }

        expect(foundThinking).toBe(true);
      }
    );
  });

  describe("Token usage tracking", () => {
    test.skipIf(logFiles.length === 0)(
      "should track cumulative token usage",
      () => {
        const logPath = logFiles[0];
        const content = fs.readFileSync(logPath, "utf-8");
        const lines = content.split("\n").filter((line) => line.trim());

        let lastInputTokens = 0;
        let lastOutputTokens = 0;
        let messageCount = 0;

        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            const result = logMessageSchema.safeParse(parsed);

            if (
              result.success &&
              result.data.type === "assistant" &&
              result.data.message.usage
            ) {
              const usage = result.data.message.usage;

              // Tokens should generally increase (cumulative)
              if (messageCount > 0) {
                expect(usage.input_tokens).toBeGreaterThanOrEqual(
                  lastInputTokens
                );
                expect(usage.output_tokens).toBeGreaterThanOrEqual(
                  lastOutputTokens
                );
              }

              lastInputTokens = usage.input_tokens || 0;
              lastOutputTokens = usage.output_tokens || 0;
              messageCount++;
            }
          } catch {
            // Skip invalid lines
          }
        }

        expect(messageCount).toBeGreaterThan(0);
      }
    );
  });
});
