import fs from "node:fs";
import path from "node:path";
import { ClaudeLogParser } from "../../server/claude-log-parser.js";
import { ShimProcessManager } from "../../server/shim-process-manager.js";
import type {
  AssistantMessage,
  ResultMessage,
  SystemMessage,
  UserMessage,
} from "../../server/types/claude-session-schema.js";
import type { Codon } from "../../server/types/types.js";
import { getRuntimeCommand, type Logger } from "../../server/utils.js";

/**
 * Result of running a shim session to completion.
 */
export interface SessionResult {
  sessionId: string;
  logPath: string;
  allMessages: Array<SystemMessage | AssistantMessage | UserMessage | ResultMessage>;
}

/**
 * Runs a shim session to completion: creates manager, spawns process,
 * waits for exit, extracts session ID, and returns parsed messages.
 *
 * Works with any shim (codex, gemini, etc).
 */
export async function runSessionToCompletion(
  tempDir: string,
  executionPath: string,
  logger: Logger,
  shimPath: string,
  codon: Codon,
  previousSessionId: string | null,
  timeoutMs: number = 60000,
): Promise<SessionResult> {
  const shimName = path.basename(path.dirname(shimPath));
  console.log(`\n  Setting up session for codon: ${codon.id}...`);

  const sessionLogPath = path.join(tempDir, `session-${codon.id}.jsonl`);

  const logParser = new ClaudeLogParser({
    logPath: sessionLogPath,
    codonId: codon.id,
    parsingInterval: 100,
  });

  const manager = new ShimProcessManager(executionPath, executionPath, logger, logParser);

  console.log(`  Spawning ${shimName} shim for ${codon.id}...`);

  // Use the same runtime-selection logic as production (server/codon-runner.ts)
  // so the pi shim is launched with Node — Bun 1.3.x lacks
  // worker_threads.markAsUncloneable, which undici's CacheStorage requires.
  const command = getRuntimeCommand(shimPath);
  const actualLogPath = await manager.spawn(command, codon, previousSessionId, {
    logPath: sessionLogPath,
  });
  console.log(`    ✓ Spawned ${shimName} shim, log: ${actualLogPath}`);

  console.log(`  Waiting for completion...`);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      manager.kill("SIGTERM").catch(console.error);
      reject(new Error(`Session ${codon.id} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    manager.on("exit", (code, contextExceeded) => {
      clearTimeout(timeout);
      console.log(`    ✓ Session completed (exit code: ${code})`);
      if (contextExceeded) {
        console.log("    ⚠️  Context exceeded");
      }
      resolve();
    });

    manager.on("error", (error) => {
      clearTimeout(timeout);
      console.error(`    ✗ Session error:`, error);
      reject(error);
    });
  });

  console.log(`  Extracting session ID from log...`);
  const logContent = await fs.promises.readFile(actualLogPath, "utf-8");
  const lines = logContent.trim().split("\n");

  let sessionId: string | undefined;
  for (const line of lines) {
    const entry = JSON.parse(line);
    if (entry.type === "system" && entry.session_id) {
      sessionId = entry.session_id;
      break;
    }
  }

  if (!sessionId) {
    throw new Error(`No session ID found in log for ${codon.id}`);
  }
  console.log(`    ✓ Session ID: ${sessionId}`);

  const allMessages = logParser.getAllMessages();
  console.log(`    ✓ Log parser found ${allMessages.length} messages`);

  logParser.stop();

  return {
    sessionId,
    logPath: actualLogPath,
    allMessages,
  };
}
