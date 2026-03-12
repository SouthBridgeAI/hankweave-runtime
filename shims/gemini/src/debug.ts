import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RawGeminiEvent } from "./protocol.js";
import { ensureDir, pathExists, writeJsonDebugLine } from "./filesystem.js";

export interface DebugCapture {
  debugDir?: string;
  sessionId?: string;
  jsonlPath?: string;
  logPath?: string;
  bufferedEvents: RawGeminiEvent[];
  bufferedStderr: string[];
}

export async function bindDebugSession(debug: DebugCapture, sessionId: string): Promise<void> {
  if (!debug.debugDir || debug.sessionId) return;
  debug.sessionId = sessionId;
  debug.jsonlPath = path.join(debug.debugDir, `session-${sessionId}.raw.jsonl`);
  debug.logPath = path.join(debug.debugDir, `session-${sessionId}.raw.log`);
  await ensureDir(debug.debugDir);
  for (const event of debug.bufferedEvents) {
    await writeJsonDebugLine(debug.jsonlPath, event);
  }
  debug.bufferedEvents = [];
  if (debug.bufferedStderr.length > 0) {
    await ensureLogFile(debug.logPath, debug.bufferedStderr.join(""));
    debug.bufferedStderr = [];
  } else {
    await ensureLogFile(debug.logPath, "");
  }
}

export async function captureStderr(debug: DebugCapture, text: string): Promise<void> {
  if (!debug.debugDir) return;
  if (debug.logPath) {
    await ensureLogFile(debug.logPath, text, true);
  } else {
    debug.bufferedStderr.push(text);
  }
}

export async function writeUnknownLog(debug: DebugCapture, text: string): Promise<void> {
  if (!debug.debugDir) return;
  const unknownLog = path.join(debug.debugDir, "session-unknown.raw.log");
  await ensureLogFile(unknownLog, text, true);
}

async function ensureLogFile(filePath: string, text: string, appendOnly = false): Promise<void> {
  if (!(await pathExists(filePath))) {
    await ensureDir(path.dirname(filePath));
    await writeFile(filePath, text, "utf8");
    return;
  }
  if (!appendOnly && text === "") {
    return;
  }
  await appendFile(filePath, text, "utf8");
}
