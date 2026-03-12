import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ResultMessage } from "./protocol.js";
import { sleep, pathExists } from "./filesystem.js";
import { formatGeminiOutputModel } from "./models.js";

export interface SessionTokens {
  input: number;
  output: number;
  cached: number;
  thoughts?: number;
  tool?: number;
  total: number;
}

export interface SessionMessage {
  id: string;
  timestamp: string;
  type: string;
  content: unknown;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    result?: unknown;
    status: string;
    timestamp: string;
    resultDisplay?: unknown;
    displayName?: string;
    description?: string;
    renderOutputAsMarkdown?: boolean;
  }>;
  thoughts?: Array<{ subject?: string; description?: string; timestamp: string }>;
  tokens?: SessionTokens | null;
  model?: string;
}

export interface SessionFileData {
  sessionId: string;
  projectHash: string;
  startTime: string;
  lastUpdated: string;
  messages: SessionMessage[];
  summary?: string;
}

const sessionFileCache = new Map<string, string>();

export async function findGeminiSessionFile(sessionId: string): Promise<string | undefined> {
  const cached = sessionFileCache.get(sessionId);
  if (cached && (await pathExists(cached))) {
    return cached;
  }

  const baseDir = path.join(os.homedir(), ".gemini", "tmp");
  if (!(await pathExists(baseDir))) {
    return undefined;
  }

  const prefix = sessionId.slice(0, 8);
  const firstLevel = await readdir(baseDir, { withFileTypes: true });
  for (const entry of firstLevel) {
    if (!entry.isDirectory()) continue;
    const chatsDir = path.join(baseDir, entry.name, "chats");
    if (!(await pathExists(chatsDir))) continue;
    const files = await readdir(chatsDir);
    for (const file of files) {
      if (!file.startsWith("session-") || !file.endsWith(".json") || !file.includes(prefix)) continue;
      const filePath = path.join(chatsDir, file);
      try {
        const content = JSON.parse(await readFile(filePath, "utf8")) as SessionFileData;
        if (content.sessionId === sessionId) {
          sessionFileCache.set(sessionId, filePath);
          return filePath;
        }
      } catch {
        continue;
      }
    }
  }

  return undefined;
}

export async function readSessionFile(sessionId: string): Promise<SessionFileData | undefined> {
  const filePath = await findGeminiSessionFile(sessionId);
  if (!filePath) return undefined;
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as SessionFileData;
  } catch {
    return undefined;
  }
}

export async function waitForToolRecord(
  sessionId: string,
  toolId: string,
  timeoutMs = 2000,
): Promise<SessionFileData | undefined> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const data = await readSessionFile(sessionId);
    if (data?.messages.some((message) => message.toolCalls?.some((call) => call.id === toolId))) {
      return data;
    }
    await sleep(100);
  }
  return readSessionFile(sessionId);
}

export function extractMeaningfulToolContent(
  session: SessionFileData | undefined,
  toolId: string,
  fallbackOutput?: string,
): string | undefined {
  if (fallbackOutput && fallbackOutput.trim()) {
    return fallbackOutput;
  }

  const toolCall = session?.messages
    .flatMap((message) => message.toolCalls ?? [])
    .find((call) => call.id === toolId);

  if (!toolCall) {
    return fallbackOutput && fallbackOutput.trim() ? fallbackOutput : undefined;
  }

  const functionResponseOutput = extractOutputFromResult(toolCall.result);
  if (functionResponseOutput?.trim()) {
    return functionResponseOutput;
  }

  const resultDisplay = toolCall.resultDisplay;
  if (typeof resultDisplay === "string" && resultDisplay.trim()) {
    return resultDisplay;
  }
  if (resultDisplay && typeof resultDisplay === "object") {
    const record = resultDisplay as Record<string, unknown>;
    if (typeof record.fileDiff === "string" && record.fileDiff.trim()) {
      return record.fileDiff;
    }
    if (typeof record.filePath === "string") {
      return `File updated: ${record.filePath}`;
    }
    if (typeof record.fileName === "string") {
      return `File updated: ${record.fileName}`;
    }
  }

  return fallbackOutput && fallbackOutput.trim() ? fallbackOutput : undefined;
}

function extractOutputFromResult(result: unknown): string | undefined {
  if (!Array.isArray(result)) return undefined;
  for (const item of result) {
    if (!item || typeof item !== "object") continue;
    const functionResponse = (item as Record<string, unknown>).functionResponse;
    if (!functionResponse || typeof functionResponse !== "object") continue;
    const response = (functionResponse as Record<string, unknown>).response;
    if (!response || typeof response !== "object") continue;
    const output = (response as Record<string, unknown>).output;
    if (typeof output === "string") {
      return output;
    }
  }
  return undefined;
}

export function aggregateInvocationUsage(
  session: SessionFileData | undefined,
  invocationStartIso: string,
): ResultMessage["model_usage"] | undefined {
  if (!session) return undefined;
  const startMs = Date.parse(invocationStartIso);
  const totals = new Map<
    string,
    { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cost_usd: number }
  >();

  for (const message of session.messages) {
    if (message.type !== "gemini" || !message.model || !message.tokens) continue;
    if (Date.parse(message.timestamp) < startMs) continue;
    const current = totals.get(message.model) ?? {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cost_usd: 0,
    };
    current.input_tokens += Number(message.tokens.input ?? 0);
    current.output_tokens += Number(message.tokens.output ?? 0);
    current.cache_read_input_tokens = (current.cache_read_input_tokens ?? 0) + Number(message.tokens.cached ?? 0);
    totals.set(message.model, current);
  }

  if (totals.size <= 1) return undefined;
  return Object.fromEntries(
    [...totals.entries()].map(([model, usage]) => [formatGeminiOutputModel(model), usage]),
  );
}
