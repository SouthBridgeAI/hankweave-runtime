#!/usr/bin/env node

// src/index.ts
import process3 from "node:process";

// src/args.ts
function parseArgs(argv) {
  const args = {
    model: process.env.MODEL || "gemini-2.5-flash",
    verbose: false,
    idleTimeout: 120,
    sandbox: "none",
    selfTest: false,
    version: false,
    help: false
  };
  const takeValue = (index, current) => {
    if (current.includes("=")) {
      const [, value] = current.split(/=(.*)/s, 2);
      return [value, index];
    }
    return [argv[index + 1], index + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i] ?? "";
    const key = raw.includes("=") ? raw.split("=", 1)[0] : raw;
    switch (key) {
      case "-p":
        break;
      case "--model": {
        const [value, nextIndex] = takeValue(i, raw);
        if (value) {
          args.model = value;
          i = nextIndex;
        }
        break;
      }
      case "--resume": {
        const [value, nextIndex] = takeValue(i, raw);
        if (value) {
          args.resume = value;
          i = nextIndex;
        }
        break;
      }
      case "--verbose":
        args.verbose = true;
        break;
      case "--append-system-prompt": {
        const [value, nextIndex] = takeValue(i, raw);
        if (value !== void 0) {
          args.appendSystemPrompt = value;
          i = nextIndex;
        }
        break;
      }
      case "--debug-dir": {
        const [value, nextIndex] = takeValue(i, raw);
        if (value) {
          args.debugDir = value;
          i = nextIndex;
        }
        break;
      }
      case "--idle-timeout": {
        const [value, nextIndex] = takeValue(i, raw);
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error("Invalid --idle-timeout value: must be a positive number");
        }
        args.idleTimeout = parsed;
        i = nextIndex;
        break;
      }
      case "--sandbox": {
        const [value, nextIndex] = takeValue(i, raw);
        if (value === "none" || value === "standard" || value === "strict") {
          args.sandbox = value;
          i = nextIndex;
        } else {
          throw new Error("Invalid --sandbox value: must be one of none, standard, strict");
        }
        break;
      }
      case "--self-test":
        args.selfTest = true;
        break;
      case "--version":
        args.version = true;
        break;
      case "--help":
        args.help = true;
        break;
      default:
        break;
    }
  }
  return args;
}
function printHelp() {
  process.stdout.write(`Gemini CLI shim

Usage:
  gemini-cli-shim --model <model> [options]

Options:
  -p                              Prompt via stdin (accepted, optional)
  --model <model>                 Gemini model or alias (for example: gemini-2.5-flash, google/gemini-2.5-pro, flash, pro)
  --resume <session_id>           Resume an existing Gemini session UUID
  --verbose                       Verbose stderr logging
  --append-system-prompt <text>   Extra system instructions appended to the internal shim prompt
  --idle-timeout <seconds>        Baseline idle timeout before work starts (default: 120)
  --debug-dir <path>              Write raw debug logs into this directory
  --sandbox <level>               none | standard | strict
  --self-test                     Verify environment and print JSON
  --version                       Print version
  --help                          Print help
`);
}
async function readStdinTrimmed() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

// node_modules/@shims/common/src/tools.ts
var STANDARD_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "LS"];

// src/constants.ts
var SHIM_NAME = "gemini-cli-shim";
var SHIM_VERSION = "0.1.0";
var KNOWN_TOOLS = [...STANDARD_TOOLS];
var MAX_SILENT_SUCCESS_RETRIES = 1;
var MAX_INVALID_JSON_REPAIRS = 2;

// src/shim.ts
import { spawn } from "node:child_process";
import path4 from "node:path";
import process2 from "node:process";
import { createInterface } from "node:readline";

// node_modules/@shims/common/src/timeout.ts
var IdleTimeoutError = class extends Error {
  timeoutMs;
  constructor(timeoutMs) {
    super(`Idle timeout: no events received for ${timeoutMs}ms`);
    this.name = "IdleTimeoutError";
    this.timeoutMs = timeoutMs;
  }
};
var BusyStepTimeoutError = class extends Error {
  timeoutMs;
  constructor(timeoutMs) {
    super(`Busy-step stall timeout: no observed activity for ${timeoutMs}ms`);
    this.name = "BusyStepTimeoutError";
    this.timeoutMs = timeoutMs;
  }
};
async function* withAdaptiveTimeout(events, options) {
  const iterator = events[Symbol.asyncIterator]();
  let state = "idle";
  const busyTimeoutMs = Math.max(
    options.busyTimeoutMs ?? options.idleTimeoutMs,
    options.idleTimeoutMs
  );
  const controller = {
    markBusy() {
      state = "busy";
    },
    markIdle() {
      state = "idle";
    },
    get state() {
      return state;
    }
  };
  try {
    while (true) {
      const timeoutMs = state === "busy" ? busyTimeoutMs : options.idleTimeoutMs;
      let timeoutId;
      try {
        const result = await Promise.race([
          iterator.next(),
          new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
              reject(
                state === "busy" ? new BusyStepTimeoutError(timeoutMs) : new IdleTimeoutError(timeoutMs)
              );
            }, timeoutMs);
          })
        ]);
        if (result.done) break;
        options.onEvent?.(result.value, controller);
        yield result.value;
      } finally {
        clearTimeout(timeoutId);
      }
    }
  } finally {
    void iterator.return?.();
  }
}

// src/debug.ts
import { appendFile as appendFile2, writeFile } from "node:fs/promises";
import path from "node:path";

// src/filesystem.ts
import { appendFile, access, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
async function pathExists(target) {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}
async function writeJsonDebugLine(filePath, event) {
  await appendFile(filePath, JSON.stringify(event) + "\n", "utf8");
}
async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
async function findInvalidJsonFiles(filePaths) {
  const invalid = [];
  for (const filePath of filePaths) {
    if (!filePath.toLowerCase().endsWith(".json")) {
      continue;
    }
    try {
      const content = await readFile(filePath, "utf8");
      JSON.parse(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      invalid.push({ filePath, error: message });
    }
  }
  return invalid;
}

// src/debug.ts
async function bindDebugSession(debug, sessionId) {
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
async function captureStderr(debug, text) {
  if (!debug.debugDir) return;
  if (debug.logPath) {
    await ensureLogFile(debug.logPath, text, true);
  } else {
    debug.bufferedStderr.push(text);
  }
}
async function writeUnknownLog(debug, text) {
  if (!debug.debugDir) return;
  const unknownLog = path.join(debug.debugDir, "session-unknown.raw.log");
  await ensureLogFile(unknownLog, text, true);
}
async function ensureLogFile(filePath, text, appendOnly = false) {
  if (!await pathExists(filePath)) {
    await ensureDir(path.dirname(filePath));
    await writeFile(filePath, text, "utf8");
    return;
  }
  if (!appendOnly && text === "") {
    return;
  }
  await appendFile2(filePath, text, "utf8");
}

// src/ids.ts
var NIL_UUID = "00000000-0000-0000-0000-000000000000";
var UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validateResumeSessionId(value) {
  if (!UUID_V4_REGEX.test(value)) {
    throw new Error(`Invalid session ID: ${value}`);
  }
}
function generateMessageId() {
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
function generateToolUseId() {
  return `toolu_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

// src/models.ts
function formatGeminiOutputModel(model) {
  const trimmed = model.trim();
  if (!trimmed) {
    return "google/gemini-2.5-flash";
  }
  return trimmed.includes("/") ? trimmed : `google/${trimmed}`;
}
function normalizeModelForGeminiCli(model) {
  const trimmed = model.trim();
  if (!trimmed) {
    return {
      requested: "gemini-2.5-flash",
      outputModel: "google/gemini-2.5-flash",
      geminiModel: "gemini-2.5-flash"
    };
  }
  const short = trimmed.toLowerCase();
  if (short === "flash") {
    return {
      requested: trimmed,
      outputModel: "google/gemini-2.5-flash",
      geminiModel: "gemini-2.5-flash"
    };
  }
  if (short === "pro") {
    return {
      requested: trimmed,
      outputModel: "google/gemini-2.5-pro",
      geminiModel: "gemini-2.5-pro"
    };
  }
  if (trimmed.includes("/")) {
    const [, rest] = trimmed.split(/\/(.*)/s, 2);
    const geminiModel = rest || trimmed;
    return {
      requested: trimmed,
      outputModel: formatGeminiOutputModel(trimmed),
      geminiModel
    };
  }
  return {
    requested: trimmed,
    outputModel: formatGeminiOutputModel(trimmed),
    geminiModel: trimmed
  };
}
function getApiKeySource() {
  if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_GENAI_USE_VERTEXAI === "true" || process.env.GOOGLE_GENAI_USE_GCA === "true") {
    return "env";
  }
  return "none";
}

// src/output.ts
function syntheticErrorMessage(prefix, text, model = "<synthetic>") {
  return {
    type: "assistant",
    message: {
      id: NIL_UUID,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: `${prefix}: ${text}` }],
      stop_reason: null
    }
  };
}
function emit(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}
async function flushStdout() {
  await new Promise((resolve, reject) => {
    process.stdout.write("", (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
function summarizeText(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return "Completed successfully.";
  }
  return trimmed.length > 500 ? `${trimmed.slice(0, 497)}...` : trimmed;
}
function countNumberedSteps(text) {
  return text.match(/(?:^|\n)\s*\d+\.\s+/g)?.length ?? 0;
}
function shouldRetrySilentSuccessTurn(input) {
  return !input.isError && !input.sawAssistantText && !input.sawToolUse && !input.sawToolResult;
}

// src/process-utils.ts
import { readFile as readFile2 } from "node:fs/promises";
import os from "node:os";
import path2 from "node:path";
function trackChildExit(child) {
  if (child.exitCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code) => {
      cleanup();
      resolve(code ?? child.exitCode ?? 1);
    };
    const cleanup = () => {
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
    };
    child.once("error", onError);
    child.once("close", onClose);
  });
}
async function which(command) {
  const isWindows = process.platform === "win32";
  const { spawn: spawn2 } = await import("node:child_process");
  return await new Promise((resolve) => {
    const proc = spawn2(isWindows ? "where" : "which", [command], {
      stdio: ["ignore", "pipe", "ignore"],
      shell: isWindows
    });
    let output = "";
    proc.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null);
      } else {
        resolve(null);
      }
    });
  });
}
async function loadGeminiSettingsAuthType() {
  try {
    const settingsPath = path2.join(os.homedir(), ".gemini", "settings.json");
    const content = JSON.parse(await readFile2(settingsPath, "utf8"));
    return content?.security?.auth?.selectedType ?? null;
  } catch {
    return null;
  }
}

// src/prompts.ts
function buildGeminiPrompt(prompt, appendSystemPrompt) {
  const internalInstructions = [
    "You are running behind a machine-oriented shim.",
    "Answer directly from the conversation context and tool results whenever possible.",
    "If the user explicitly asks you to create, update, or maintain a file, do that with tools before ending the turn.",
    "When the user gives a numbered or ordered task list, complete every requested step in sequence before finishing.",
    "Do not stop after an intermediate answer if additional requested steps remain.",
    "If the user asks for ongoing research notes or a progress file, keep that file updated as you work.",
    "If the user asks for research, use the available search/web/file tools rather than answering from memory alone whenever the request calls for current sources.",
    "When creating machine-readable files such as JSON, ensure the final file contents are syntactically valid before ending the turn.",
    "Do not delegate to CLI help, documentation helpers, or other subagents unless the user explicitly asks about Gemini CLI usage or external documentation.",
    "If the user asks what they told you earlier in this same conversation, answer from the conversation history directly."
  ].join(" ");
  if (!appendSystemPrompt?.trim()) {
    return [
      "SYSTEM INSTRUCTIONS (highest priority for this run):",
      internalInstructions,
      "",
      "USER PROMPT:",
      prompt
    ].join("\n");
  }
  return [
    "SYSTEM INSTRUCTIONS (highest priority for this run):",
    internalInstructions,
    "",
    "ADDITIONAL CALLER SYSTEM INSTRUCTIONS:",
    appendSystemPrompt.trim(),
    "",
    "USER PROMPT:",
    prompt
  ].join("\n");
}
function buildSilentTurnRecoveryPrompt() {
  return [
    "System: Your previous turn produced no assistant-visible text, tool calls, or tool results.",
    "Continue the pending user request now.",
    "You must either produce assistant text or use tools to complete the requested work before ending the turn.",
    "Do not end with an empty response."
  ].join(" ");
}
function buildRemainingStepsPrompt() {
  return [
    "System: Re-check the user's original numbered task list.",
    "If any requested numbered steps are still incomplete, complete them now before you finish.",
    "If everything is already complete, briefly confirm that all requested steps are done."
  ].join(" ");
}
function buildInvalidJsonRepairPrompt(invalidFiles) {
  return [
    "System: Re-check the machine-readable files you created or modified.",
    `These files are currently invalid JSON: ${invalidFiles.join("; ")}.`,
    "Use tools to read the current file contents, repair them, and verify the final on-disk files parse as valid JSON before you end the turn.",
    "If a previous repair introduced extra escaping, remove the extra escaping so the file itself is valid JSON.",
    "After repairing them, briefly confirm which files were fixed."
  ].join(" ");
}

// src/session-files.ts
import { readFile as readFile3, readdir } from "node:fs/promises";
import os2 from "node:os";
import path3 from "node:path";
var sessionFileCache = /* @__PURE__ */ new Map();
async function findGeminiSessionFile(sessionId) {
  const cached = sessionFileCache.get(sessionId);
  if (cached && await pathExists(cached)) {
    return cached;
  }
  const baseDir = path3.join(os2.homedir(), ".gemini", "tmp");
  if (!await pathExists(baseDir)) {
    return void 0;
  }
  const prefix = sessionId.slice(0, 8);
  const firstLevel = await readdir(baseDir, { withFileTypes: true });
  for (const entry of firstLevel) {
    if (!entry.isDirectory()) continue;
    const chatsDir = path3.join(baseDir, entry.name, "chats");
    if (!await pathExists(chatsDir)) continue;
    const files = await readdir(chatsDir);
    for (const file of files) {
      if (!file.startsWith("session-") || !file.endsWith(".json") || !file.includes(prefix)) continue;
      const filePath = path3.join(chatsDir, file);
      try {
        const content = JSON.parse(await readFile3(filePath, "utf8"));
        if (content.sessionId === sessionId) {
          sessionFileCache.set(sessionId, filePath);
          return filePath;
        }
      } catch {
        continue;
      }
    }
  }
  return void 0;
}
async function readSessionFile(sessionId) {
  const filePath = await findGeminiSessionFile(sessionId);
  if (!filePath) return void 0;
  try {
    return JSON.parse(await readFile3(filePath, "utf8"));
  } catch {
    return void 0;
  }
}
async function waitForToolRecord(sessionId, toolId, timeoutMs = 2e3) {
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
function extractMeaningfulToolContent(session, toolId, fallbackOutput) {
  if (fallbackOutput && fallbackOutput.trim()) {
    return fallbackOutput;
  }
  const toolCall = session?.messages.flatMap((message) => message.toolCalls ?? []).find((call) => call.id === toolId);
  if (!toolCall) {
    return fallbackOutput && fallbackOutput.trim() ? fallbackOutput : void 0;
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
    const record = resultDisplay;
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
  return fallbackOutput && fallbackOutput.trim() ? fallbackOutput : void 0;
}
function extractOutputFromResult(result) {
  if (!Array.isArray(result)) return void 0;
  for (const item of result) {
    if (!item || typeof item !== "object") continue;
    const functionResponse = item.functionResponse;
    if (!functionResponse || typeof functionResponse !== "object") continue;
    const response = functionResponse.response;
    if (!response || typeof response !== "object") continue;
    const output = response.output;
    if (typeof output === "string") {
      return output;
    }
  }
  return void 0;
}
function aggregateInvocationUsage(session, invocationStartIso) {
  if (!session) return void 0;
  const startMs = Date.parse(invocationStartIso);
  const totals = /* @__PURE__ */ new Map();
  for (const message of session.messages) {
    if (message.type !== "gemini" || !message.model || !message.tokens) continue;
    if (Date.parse(message.timestamp) < startMs) continue;
    const current = totals.get(message.model) ?? {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cost_usd: 0
    };
    current.input_tokens += Number(message.tokens.input ?? 0);
    current.output_tokens += Number(message.tokens.output ?? 0);
    current.cache_read_input_tokens = (current.cache_read_input_tokens ?? 0) + Number(message.tokens.cached ?? 0);
    totals.set(message.model, current);
  }
  if (totals.size <= 1) return void 0;
  return Object.fromEntries(
    [...totals.entries()].map(([model, usage]) => [formatGeminiOutputModel(model), usage])
  );
}

// src/tools.ts
function camelToSnake(value) {
  return value.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}
function topLevelSnakeCase(input) {
  if (!input) return void 0;
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    output[camelToSnake(key)] = value;
  }
  return output;
}
var TOOL_NAME_MAP = /* @__PURE__ */ new Map([
  ["read_file", "Read"],
  ["readfile", "Read"],
  ["write_file", "Write"],
  ["writefile", "Write"],
  ["replace", "Edit"],
  ["edit", "Edit"],
  ["run_shell_command", "Bash"],
  ["shell", "Bash"],
  ["bash", "Bash"],
  ["glob", "Glob"],
  ["search_file_content", "Grep"],
  ["grep", "Grep"],
  ["list_directory", "LS"],
  ["ls", "LS"]
]);
function normalizeToolName(name) {
  return TOOL_NAME_MAP.get(name.toLowerCase()) ?? name;
}
function normalizeToolInput(name, input) {
  const snake = topLevelSnakeCase(input);
  if (!snake) return void 0;
  switch (name) {
    case "Read": {
      const filePath = snake.file_path ?? snake.path;
      const result = {};
      if (filePath !== void 0) result.file_path = filePath;
      if (snake.offset !== void 0) result.offset = snake.offset;
      if (snake.limit !== void 0) result.limit = snake.limit;
      return result;
    }
    case "Write": {
      const filePath = snake.file_path ?? snake.path;
      const result = {};
      if (filePath !== void 0) result.file_path = filePath;
      if (snake.content !== void 0) result.content = snake.content;
      return result;
    }
    case "Edit":
      return snake;
    case "Bash":
      return {
        command: snake.command,
        ...snake.description !== void 0 ? { description: snake.description } : {},
        ...snake.directory !== void 0 ? { directory: snake.directory } : {}
      };
    case "Glob": {
      const out = {};
      if (snake.pattern !== void 0) out.pattern = snake.pattern;
      if (snake.path !== void 0) out.path = snake.path;
      if (snake.case_sensitive !== void 0) out.case_sensitive = snake.case_sensitive;
      if (snake.respect_git_ignore !== void 0) out.respect_git_ignore = snake.respect_git_ignore;
      return out;
    }
    case "Grep": {
      const out = {};
      if (snake.pattern !== void 0) out.pattern = snake.pattern;
      if (snake.path !== void 0) out.path = snake.path;
      if (snake.include !== void 0) out.glob = snake.include;
      return out;
    }
    case "LS": {
      const out = {};
      if (snake.path !== void 0) out.path = snake.path;
      if (snake.ignore !== void 0) out.ignore = snake.ignore;
      if (snake.respect_git_ignore !== void 0) out.respect_git_ignore = snake.respect_git_ignore;
      return out;
    }
    default:
      return snake;
  }
}
function extractToolFilePath(input) {
  const candidate = input?.file_path ?? input?.path;
  return typeof candidate === "string" ? candidate : void 0;
}

// src/shim.ts
async function runShim(args, prompt) {
  const invocationStart = (/* @__PURE__ */ new Date()).toISOString();
  const startTime = Date.now();
  const { outputModel, geminiModel } = normalizeModelForGeminiCli(args.model);
  const cwd = process2.cwd();
  const debug = {
    debugDir: args.debugDir,
    bufferedEvents: [],
    bufferedStderr: []
  };
  if (debug.debugDir) {
    await ensureDir(debug.debugDir);
  }
  if (args.resume) {
    try {
      validateResumeSessionId(args.resume);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await writeUnknownLog(debug, `${message}
`);
      throw error;
    }
  }
  const geminiPath = await which("gemini");
  if (!geminiPath) {
    process2.stderr.write("Gemini CLI not found in PATH.\n");
    await writeUnknownLog(debug, "Gemini CLI not found in PATH.\n");
    return 1;
  }
  let interrupted = false;
  let activeChild;
  let systemEmitted = false;
  let resultEmitted = false;
  let sessionId = args.resume;
  let actualModel = outputModel;
  let durationApiMs = 0;
  let usage;
  let modelUsage;
  let finalIsError = false;
  let numTurns = 0;
  let remainingSilentSuccessRetries = MAX_SILENT_SUCCESS_RETRIES;
  let remainingInvalidJsonRepairs = MAX_INVALID_JSON_REPAIRS;
  let completionCheckIssued = false;
  let totalToolUseCount = 0;
  let resumeSessionId = args.resume;
  let attemptPrompt = buildGeminiPrompt(prompt, args.appendSystemPrompt);
  const toolIdMap = /* @__PURE__ */ new Map();
  const emittedToolUses = /* @__PURE__ */ new Set();
  const emittedToolResults = /* @__PURE__ */ new Set();
  const pendingToolResults = /* @__PURE__ */ new Map();
  const assistantTextChunks = [];
  let pendingAssistantText = "";
  let currentAssistantStreamHasDelta = false;
  let lastSyntheticError;
  const candidateJsonFiles = /* @__PURE__ */ new Set();
  const numberedStepCount = countNumberedSteps(prompt);
  const flushAssistantText = () => {
    if (!pendingAssistantText) return;
    assistantTextChunks.push(pendingAssistantText);
    const message = {
      type: "assistant",
      message: {
        id: generateMessageId(),
        type: "message",
        role: "assistant",
        model: actualModel,
        content: [{ type: "text", text: pendingAssistantText }],
        stop_reason: null
      }
    };
    emit(message);
    pendingAssistantText = "";
    currentAssistantStreamHasDelta = false;
  };
  const emitFinalResult = async (isError, resultText) => {
    const result = {
      type: "result",
      subtype: isError ? "error" : "success",
      is_error: isError,
      duration_ms: Date.now() - startTime,
      duration_api_ms: durationApiMs,
      num_turns: Math.max(1, numTurns),
      result: resultText,
      session_id: sessionId,
      usage,
      ...modelUsage ? { model_usage: modelUsage } : {}
    };
    emit(result);
    resultEmitted = true;
    finalIsError = isError;
    await flushStdout();
    return isError ? 1 : 0;
  };
  const maybeRepairInvalidJsonFiles = async () => {
    const invalidJsonFiles = await findInvalidJsonFiles(candidateJsonFiles);
    if (invalidJsonFiles.length === 0) {
      return void 0;
    }
    const invalidFileDescriptions = invalidJsonFiles.map(({ filePath, error }) => {
      const relativePath = path4.relative(cwd, filePath) || filePath;
      return `${relativePath} (${error})`;
    });
    const errorText = `Gemini left invalid JSON files: ${invalidFileDescriptions.join("; ")}`;
    if (remainingInvalidJsonRepairs > 0 && sessionId) {
      remainingInvalidJsonRepairs -= 1;
      resumeSessionId = sessionId;
      attemptPrompt = buildInvalidJsonRepairPrompt(invalidFileDescriptions);
      if (args.verbose) {
        process2.stderr.write(
          `[shim] Gemini left invalid JSON files for session ${sessionId}; requesting repair: ${invalidFileDescriptions.join(", ")}
`
        );
      }
      return "continue";
    }
    emit(syntheticErrorMessage("Agent Error", errorText));
    return await emitFinalResult(true, errorText);
  };
  const signalHandler = async () => {
    if (interrupted) return;
    interrupted = true;
    activeChild?.kill("SIGTERM");
    flushAssistantText();
    if (systemEmitted && !resultEmitted) {
      await emitFinalResult(false, summarizeText(assistantTextChunks.join("")));
    }
    process2.exit(0);
  };
  process2.once("SIGINT", signalHandler);
  process2.once("SIGTERM", signalHandler);
  try {
    while (true) {
      numTurns += 1;
      lastSyntheticError = void 0;
      let syntheticErrorEmitted = false;
      const child = spawnGemini({
        args,
        cwd,
        geminiModel,
        geminiPath,
        resumeSessionId
      });
      activeChild = child;
      const childExitPromise = trackChildExit(child);
      child.stdin.write(attemptPrompt);
      child.stdin.end();
      child.stderr.on("data", async (chunk) => {
        const text = String(chunk);
        if (args.verbose) {
          process2.stderr.write(`[gemini-stderr] ${text}`);
        }
        await captureStderr(debug, text);
      });
      const eventIterator = readGeminiEvents(child, debug, args.verbose);
      let attemptSawAssistantText = false;
      let attemptSawToolUse = false;
      let attemptSawToolResult = false;
      let retryDueToSilentSuccess = false;
      let continueWithFollowUpPrompt = false;
      const emitToolResultFromEvent = async (event) => {
        if (emittedToolResults.has(event.tool_id)) {
          return;
        }
        const publicToolId = toolIdMap.get(event.tool_id);
        if (!publicToolId) {
          pendingToolResults.set(event.tool_id, event);
          return;
        }
        const sessionData = sessionId ? await waitForToolRecord(sessionId, event.tool_id) : void 0;
        const contentText = sessionId ? extractMeaningfulToolContent(sessionData, event.tool_id, event.output) : event.output;
        const userMessage = {
          type: "user",
          message: {
            role: "user",
            content: [
              event.status === "error" ? {
                type: "tool_result",
                tool_use_id: publicToolId,
                content: {
                  is_error: true,
                  error: event.error?.message || contentText || "Tool execution failed"
                }
              } : {
                type: "tool_result",
                tool_use_id: publicToolId,
                content: contentText || `Tool completed: ${event.tool_id}`
              }
            ]
          }
        };
        emit(userMessage);
        emittedToolResults.add(event.tool_id);
      };
      try {
        attemptLoop: for await (const event of withAdaptiveTimeout(eventIterator, {
          idleTimeoutMs: args.idleTimeout * 1e3,
          busyTimeoutMs: Math.max(args.idleTimeout * 1e3, 3e5),
          onEvent(event2, controller) {
            if (event2.type === "tool_use" || event2.type === "message" && event2.role === "assistant" && event2.content.length > 0) {
              controller.markBusy();
            }
            if (event2.type === "result") {
              controller.markIdle();
            }
          }
        })) {
          switch (event.type) {
            case "init": {
              sessionId = event.session_id;
              actualModel = formatGeminiOutputModel(event.model || geminiModel || outputModel);
              await bindDebugSession(debug, sessionId);
              if (!systemEmitted) {
                const system = {
                  type: "system",
                  subtype: "init",
                  cwd,
                  session_id: sessionId,
                  tools: KNOWN_TOOLS,
                  model: actualModel,
                  permissionMode: "bypassPermissions",
                  apiKeySource: getApiKeySource(),
                  mcp_servers: []
                };
                emit(system);
                systemEmitted = true;
              }
              break;
            }
            case "message": {
              if (event.role !== "assistant") {
                break;
              }
              if (!event.content) {
                break;
              }
              if (event.delta) {
                currentAssistantStreamHasDelta = true;
                pendingAssistantText += event.content;
                if (event.content.trim().length > 0) {
                  attemptSawAssistantText = true;
                }
                break;
              }
              if (currentAssistantStreamHasDelta) {
                break;
              }
              pendingAssistantText += event.content;
              if (event.content.trim().length > 0) {
                attemptSawAssistantText = true;
              }
              break;
            }
            case "tool_use": {
              attemptSawToolUse = true;
              if (emittedToolUses.has(event.tool_id)) {
                break;
              }
              totalToolUseCount += 1;
              flushAssistantText();
              const publicToolId = toolIdMap.get(event.tool_id) ?? generateToolUseId();
              toolIdMap.set(event.tool_id, publicToolId);
              emittedToolUses.add(event.tool_id);
              const normalizedName = normalizeToolName(event.tool_name);
              const normalizedInput = normalizeToolInput(normalizedName, event.parameters);
              const candidateFilePath = extractToolFilePath(normalizedInput);
              if (candidateFilePath && (normalizedName === "Write" || normalizedName === "Edit") && candidateFilePath.toLowerCase().endsWith(".json")) {
                candidateJsonFiles.add(path4.resolve(cwd, candidateFilePath));
              }
              const toolUse = {
                type: "assistant",
                message: {
                  id: generateMessageId(),
                  type: "message",
                  role: "assistant",
                  model: actualModel,
                  content: [
                    {
                      type: "tool_use",
                      id: publicToolId,
                      name: normalizedName,
                      input: normalizedInput
                    }
                  ],
                  stop_reason: "tool_use"
                }
              };
              emit(toolUse);
              const pendingResult = pendingToolResults.get(event.tool_id);
              if (pendingResult) {
                pendingToolResults.delete(event.tool_id);
                await emitToolResultFromEvent(pendingResult);
              }
              break;
            }
            case "tool_result": {
              attemptSawToolResult = true;
              flushAssistantText();
              await emitToolResultFromEvent(event);
              break;
            }
            case "error": {
              flushAssistantText();
              if (event.severity === "error") {
                lastSyntheticError = event.message;
                finalIsError = true;
                if (!syntheticErrorEmitted) {
                  emit(syntheticErrorMessage("Agent Error", event.message));
                  syntheticErrorEmitted = true;
                }
              }
              break;
            }
            case "result": {
              flushAssistantText();
              durationApiMs = Number(event.stats?.duration_ms ?? Date.now() - startTime);
              usage = {
                input_tokens: event.stats?.input_tokens,
                output_tokens: event.stats?.output_tokens,
                cache_read_input_tokens: event.stats?.cached
              };
              const sessionData = sessionId ? await waitForSessionFile(sessionId) : void 0;
              modelUsage = aggregateInvocationUsage(sessionData, invocationStart);
              const isError = event.status === "error" || Boolean(lastSyntheticError) || Boolean(event.error?.message);
              if (isError && !syntheticErrorEmitted) {
                emit(
                  syntheticErrorMessage(
                    "Agent Error",
                    event.error?.message || lastSyntheticError || "Gemini CLI reported an error"
                  )
                );
                syntheticErrorEmitted = true;
              }
              const silentSuccess = shouldRetrySilentSuccessTurn({
                isError,
                sawAssistantText: attemptSawAssistantText,
                sawToolUse: attemptSawToolUse,
                sawToolResult: attemptSawToolResult
              });
              if (silentSuccess) {
                if (remainingSilentSuccessRetries > 0 && sessionId) {
                  remainingSilentSuccessRetries -= 1;
                  retryDueToSilentSuccess = true;
                  continueWithFollowUpPrompt = true;
                  resumeSessionId = sessionId;
                  attemptPrompt = buildSilentTurnRecoveryPrompt();
                  if (args.verbose) {
                    process2.stderr.write(
                      `[shim] Gemini returned a silent success turn for session ${sessionId}; retrying with continuation prompt.
`
                    );
                  }
                  break attemptLoop;
                }
                const message = "Gemini completed with no assistant text or tool activity.";
                emit(syntheticErrorMessage("Agent Error", message));
                const emittedCode2 = await emitFinalResult(true, message);
                await childExitPromise;
                activeChild = void 0;
                return emittedCode2;
              }
              const needsCompletionCheck = !isError && !completionCheckIssued && sessionId && numberedStepCount >= 2 && totalToolUseCount > 0 && totalToolUseCount < numberedStepCount;
              if (needsCompletionCheck) {
                completionCheckIssued = true;
                continueWithFollowUpPrompt = true;
                resumeSessionId = sessionId;
                attemptPrompt = buildRemainingStepsPrompt();
                if (args.verbose) {
                  process2.stderr.write(
                    `[shim] Gemini may have stopped before finishing a numbered task list for session ${sessionId}; requesting completion check.
`
                  );
                }
                break attemptLoop;
              }
              if (!isError) {
                const jsonRepairOutcome = await maybeRepairInvalidJsonFiles();
                if (jsonRepairOutcome === "continue") {
                  continueWithFollowUpPrompt = true;
                  break attemptLoop;
                }
                if (typeof jsonRepairOutcome === "number") {
                  await childExitPromise;
                  activeChild = void 0;
                  return jsonRepairOutcome;
                }
              }
              const resultText = isError ? event.error?.message || lastSyntheticError || "Gemini CLI reported an error" : summarizeText(assistantTextChunks.join(""));
              const emittedCode = await emitFinalResult(isError, resultText);
              await childExitPromise;
              activeChild = void 0;
              return emittedCode;
            }
          }
        }
        flushAssistantText();
        const exitCode = await childExitPromise;
        activeChild = void 0;
        if (retryDueToSilentSuccess || continueWithFollowUpPrompt) {
          continue;
        }
        if (!resultEmitted && systemEmitted) {
          const sessionData = sessionId ? await waitForSessionFile(sessionId) : void 0;
          modelUsage = aggregateInvocationUsage(sessionData, invocationStart);
          const success = exitCode === 0 && !lastSyntheticError;
          const silentSuccess = shouldRetrySilentSuccessTurn({
            isError: !success,
            sawAssistantText: attemptSawAssistantText,
            sawToolUse: attemptSawToolUse,
            sawToolResult: attemptSawToolResult
          });
          if (silentSuccess) {
            if (remainingSilentSuccessRetries > 0 && sessionId) {
              remainingSilentSuccessRetries -= 1;
              resumeSessionId = sessionId;
              attemptPrompt = buildSilentTurnRecoveryPrompt();
              if (args.verbose) {
                process2.stderr.write(
                  `[shim] Gemini exited after a silent success turn for session ${sessionId}; retrying with continuation prompt.
`
                );
              }
              continue;
            }
            const message = "Gemini completed with no assistant text or tool activity.";
            emit(syntheticErrorMessage("Agent Error", message));
            return await emitFinalResult(true, message);
          }
          const needsCompletionCheck = success && !completionCheckIssued && sessionId && numberedStepCount >= 2 && totalToolUseCount > 0 && totalToolUseCount < numberedStepCount;
          if (needsCompletionCheck) {
            completionCheckIssued = true;
            resumeSessionId = sessionId;
            attemptPrompt = buildRemainingStepsPrompt();
            if (args.verbose) {
              process2.stderr.write(
                `[shim] Gemini may have exited before finishing a numbered task list for session ${sessionId}; requesting completion check.
`
              );
            }
            continue;
          }
          if (success) {
            const jsonRepairOutcome = await maybeRepairInvalidJsonFiles();
            if (jsonRepairOutcome === "continue") {
              continue;
            }
            if (typeof jsonRepairOutcome === "number") {
              return jsonRepairOutcome;
            }
          } else if (!syntheticErrorEmitted) {
            emit(syntheticErrorMessage("Agent Error", lastSyntheticError || `Gemini CLI exited with code ${exitCode}`));
            syntheticErrorEmitted = true;
          }
          const resultText = success ? summarizeText(assistantTextChunks.join("")) : lastSyntheticError || `Gemini CLI exited with code ${exitCode}`;
          return await emitFinalResult(!success, resultText);
        }
        await flushStdout();
        return finalIsError ? 1 : exitCode === 0 ? 0 : 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const _isTimeout = error instanceof IdleTimeoutError || error instanceof BusyStepTimeoutError;
        if (args.verbose) {
          process2.stderr.write(`[shim] ${message}
`);
        }
        if (debug.debugDir && !sessionId) {
          await writeUnknownLog(debug, `${message}
`);
        }
        activeChild?.kill("SIGKILL");
        activeChild = void 0;
        flushAssistantText();
        if (systemEmitted) {
          emit(syntheticErrorMessage("Agent Error", message));
          return await emitFinalResult(true, message);
        }
        process2.stderr.write(`${message}
`);
        await flushStdout();
        return 1;
      }
    }
  } finally {
    process2.removeListener("SIGINT", signalHandler);
    process2.removeListener("SIGTERM", signalHandler);
  }
}
function spawnGemini({
  args,
  cwd,
  geminiModel,
  geminiPath,
  resumeSessionId
}) {
  const isWindows = process2.platform === "win32";
  const geminiArgs = ["--model", geminiModel, "--output-format", "stream-json", "--approval-mode", "yolo"];
  if (resumeSessionId) {
    geminiArgs.push("--resume", resumeSessionId);
  }
  if (args.sandbox === "standard" || args.sandbox === "strict") {
    geminiArgs.push("--sandbox");
  }
  const env = {
    ...process2.env,
    FORCE_COLOR: "0",
    GEMINI_SANDBOX: args.sandbox === "none" ? "false" : process2.env.GEMINI_SANDBOX || "true",
    BASH_ENV: ""
  };
  if (args.sandbox === "strict" && process2.platform === "darwin") {
    env.SEATBELT_PROFILE = "restrictive-open";
  }
  return spawn(geminiPath, geminiArgs, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env,
    shell: isWindows
  });
}
async function* readGeminiEvents(child, debug, verbose) {
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (verbose) {
        process2.stderr.write(`[shim] Skipping non-JSON Gemini stdout line: ${line}
`);
      }
      continue;
    }
    if (debug.sessionId && debug.jsonlPath) {
      await writeJsonDebugLine(debug.jsonlPath, parsed);
    } else {
      debug.bufferedEvents.push(parsed);
    }
    yield parsed;
  }
}
async function waitForSessionFile(sessionId) {
  const started = Date.now();
  while (Date.now() - started <= 2e3) {
    const filePath = await findGeminiSessionFile(sessionId);
    if (filePath) {
      return await readSessionFile(sessionId);
    }
    await sleep(100);
  }
  return await readSessionFile(sessionId);
}
async function runSelfTest() {
  const geminiPath = await which("gemini");
  const authType = await loadGeminiSettingsAuthType();
  const checks = [
    {
      name: "agent_found",
      passed: Boolean(geminiPath),
      message: geminiPath ? `Found Gemini CLI at ${geminiPath}` : "Gemini CLI not found in PATH"
    },
    {
      name: "auth_configured",
      passed: Boolean(process2.env.GEMINI_API_KEY || process2.env.GOOGLE_API_KEY || authType),
      message: process2.env.GEMINI_API_KEY || process2.env.GOOGLE_API_KEY || authType ? `Authentication appears configured (${authType || "environment"})` : "No Gemini auth configuration detected"
    }
  ];
  const overallPassed = checks.every((check) => check.passed);
  const payload = {
    shim: { name: SHIM_NAME, version: SHIM_VERSION },
    agent: { name: "gemini", version: await detectGeminiVersion(), found: Boolean(geminiPath) },
    checks,
    overall: {
      passed: overallPassed,
      message: overallPassed ? "All checks passed" : "One or more checks failed"
    }
  };
  process2.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  return overallPassed ? 0 : 1;
}
async function detectGeminiVersion() {
  const geminiPath = await which("gemini");
  if (!geminiPath) return "unknown";
  return await new Promise((resolve) => {
    const isWindows = process2.platform === "win32";
    const child = spawn(geminiPath, ["--version"], {
      stdio: ["ignore", "pipe", "ignore"],
      shell: isWindows
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("close", () => resolve(output.trim() || "unknown"));
    child.on("error", () => resolve("unknown"));
  });
}

// src/index.ts
async function main() {
  try {
    const args = parseArgs(process3.argv.slice(2));
    if (args.help) {
      printHelp();
      return 0;
    }
    if (args.version) {
      process3.stdout.write(`${SHIM_VERSION}
`);
      return 0;
    }
    if (args.selfTest) {
      return await runSelfTest();
    }
    const prompt = await readStdinTrimmed();
    if (!prompt) {
      return 0;
    }
    return await runShim(args, prompt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process3.stderr.write(`${message}
`);
    return 1;
  }
}
main().then((code) => {
  process3.exit(code);
}).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process3.stderr.write(`${message}
`);
  process3.exit(1);
});
