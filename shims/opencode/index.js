#!/usr/bin/env node

// src/index.ts
import fs4 from "node:fs";
import path4 from "node:path";

// node_modules/@shims/common/src/args.ts
var VALID_SANDBOX_LEVELS = ["none", "standard", "strict"];
function parseArgs(argv, aliases) {
  const args = {
    model: "",
    verbose: false,
    idleTimeout: 120,
    sandbox: "none",
    selfTest: false,
    version: false,
    help: false
  };
  for (let i = 0;i < argv.length; i++) {
    let arg = argv[i];
    if (arg.includes("=")) {
      const [key, value] = arg.split("=", 2);
      argv.splice(i, 1, key, value);
      arg = key;
    }
    if (aliases && arg in aliases) {
      arg = aliases[arg];
    }
    switch (arg) {
      case "--model":
        args.model = argv[++i];
        break;
      case "--resume":
        args.resume = argv[++i];
        break;
      case "--verbose":
        args.verbose = true;
        break;
      case "--append-system-prompt":
        args.appendSystemPrompt = argv[++i];
        break;
      case "--debug-dir":
        args.debugDir = argv[++i];
        break;
      case "--idle-timeout": {
        const val = Number(argv[++i]);
        if (!Number.isFinite(val) || val <= 0) {
          console.error("Invalid --idle-timeout value: must be a positive number");
          process.exit(1);
        }
        args.idleTimeout = val;
        break;
      }
      case "--sandbox": {
        const level = argv[++i];
        if (!VALID_SANDBOX_LEVELS.includes(level)) {
          console.error(`Invalid --sandbox value: must be one of ${VALID_SANDBOX_LEVELS.join(", ")}`);
          process.exit(1);
        }
        args.sandbox = level;
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
    }
  }
  return args;
}
// node_modules/@shims/common/src/sessions.ts
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

class SessionManager {
  sessionsDir;
  constructor(options = {}) {
    if (options.debugDir) {
      this.sessionsDir = path.join(options.debugDir, "sessions");
    } else {
      const home = process.env.HOME || process.env.USERPROFILE || "";
      if (!home) {
        throw new Error("Cannot determine home directory for session storage");
      }
      this.sessionsDir = path.join(home, ".shim", "sessions");
    }
    fs.mkdirSync(this.sessionsDir, { recursive: true });
  }
  generateSessionId() {
    return randomUUID();
  }
  saveSession(data) {
    const sessionPath = path.join(this.sessionsDir, `${data.sessionId}.json`);
    fs.writeFileSync(sessionPath, JSON.stringify(data, null, 2), "utf8");
  }
  loadSession(sessionId) {
    const sessionPath = path.join(this.sessionsDir, `${sessionId}.json`);
    try {
      const content = fs.readFileSync(sessionPath, "utf8");
      return JSON.parse(content);
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error(`Session not found: ${sessionId}`);
      }
      throw error;
    }
  }
  sessionExists(sessionId) {
    const sessionPath = path.join(this.sessionsDir, `${sessionId}.json`);
    return fs.existsSync(sessionPath);
  }
  deleteSession(sessionId) {
    const sessionPath = path.join(this.sessionsDir, `${sessionId}.json`);
    try {
      fs.unlinkSync(sessionPath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  listSessions() {
    try {
      const files = fs.readdirSync(this.sessionsDir);
      return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
    } catch (error) {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }
  getSessionsDir() {
    return this.sessionsDir;
  }
}
// node_modules/@shims/common/src/timeout.ts
class IdleTimeoutError extends Error {
  timeoutMs;
  constructor(timeoutMs) {
    super(`Idle timeout: no events received for ${timeoutMs}ms`);
    this.name = "IdleTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

class BusyStepTimeoutError extends Error {
  timeoutMs;
  constructor(timeoutMs) {
    super(`Busy-step stall timeout: no observed activity for ${timeoutMs}ms`);
    this.name = "BusyStepTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}
async function* withAdaptiveTimeout(events, options) {
  const iterator = events[Symbol.asyncIterator]();
  let state = "idle";
  const busyTimeoutMs = Math.max(options.busyTimeoutMs ?? options.idleTimeoutMs, options.idleTimeoutMs);
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
              reject(state === "busy" ? new BusyStepTimeoutError(timeoutMs) : new IdleTimeoutError(timeoutMs));
            }, timeoutMs);
          })
        ]);
        if (result.done)
          break;
        options.onEvent?.(result.value, controller);
        yield result.value;
      } finally {
        clearTimeout(timeoutId);
      }
    }
  } finally {
    iterator.return?.();
  }
}
// node_modules/@shims/common/src/tools.ts
var STANDARD_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "LS"];
// package.json
var package_default = {
  name: "opencode-shim",
  version: "1.0.0",
  description: "Self-contained Hankweave shim package for the OpenCode CLI",
  type: "module",
  bin: {
    "opencode-shim": "./index.js"
  },
  files: [
    "index.js",
    "dist",
    "src",
    "common",
    "docs",
    "README.md",
    "rebuild.sh",
    "VERSION",
    "THIRDPARTY.md",
    "tsconfig.json"
  ],
  scripts: {
    build: `node -e "const fs=require('fs'); fs.rmSync('./dist',{recursive:true,force:true}); fs.mkdirSync('./dist',{recursive:true});" && bun build ./src/index.ts --target node --format esm --outfile ./dist/index.js`,
    rebuild: "./rebuild.sh",
    test: "bun test",
    typecheck: "tsc --noEmit",
    clean: `node -e "const fs=require('fs'); fs.rmSync('./dist',{recursive:true,force:true}); fs.rmSync('./index.js',{force:true});"`
  },
  dependencies: {
    "@shims/common": "file:./common"
  },
  devDependencies: {
    "@types/bun": "latest",
    typescript: "^5.3.0"
  },
  engines: {
    bun: ">=1.1.0"
  }
};

// src/selftest.ts
import { spawn as spawn2 } from "node:child_process";

// src/agent/opencode.ts
import fs2 from "node:fs";
import os from "node:os";
import path2 from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";

// src/utils/prompt.ts
var INTERNAL_INSTRUCTIONS = [
  "Operate headlessly and do not ask the user for confirmation.",
  "Finish all explicit user-requested steps before ending the turn unless a real error prevents completion.",
  "If the user requested multiple ordered actions, do not stop after only a partial subset.",
  "Only use files and absolute paths inside the current working directory unless the user explicitly asks for an external path."
];
function buildInstructionFileContents(params) {
  const sections = [
    "# Instructions injected by opencode-shim",
    "",
    "## Internal runtime requirements",
    "",
    ...INTERNAL_INSTRUCTIONS.map((line) => `- ${line}`),
    `- Current working directory: ${params.cwd}`
  ];
  if (params.appendSystemPrompt?.trim()) {
    sections.push("", "## Additional caller-provided instruction", "", params.appendSystemPrompt.trim(), "", "Treat the caller-provided instruction above as higher priority than the user message.");
  }
  return sections.join(`
`);
}

// src/utils/output.ts
function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}
`);
}
async function flushStdout() {
  await new Promise((resolve) => {
    process.stdout.write("", () => resolve());
  });
}
function verboseLog(enabled, message, data) {
  if (!enabled)
    return;
  if (data === undefined) {
    process.stderr.write(`[opencode-shim] ${message}
`);
    return;
  }
  const rendered = typeof data === "string" ? data : JSON.stringify(data);
  process.stderr.write(`[opencode-shim] ${message}: ${rendered}
`);
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/agent/opencode.ts
async function ensureOpencodeAvailable() {
  const envPath = process.env.OPENCODE_BIN?.trim();
  const candidates = [
    envPath,
    path2.join(os.homedir(), ".opencode", "bin", process.platform === "win32" ? "opencode.cmd" : "opencode"),
    path2.join(os.homedir(), ".opencode", "bin", "opencode"),
    "opencode"
  ].filter((value) => Boolean(value));
  for (const candidate of candidates) {
    if (candidate.includes(path2.sep) || candidate.startsWith(".")) {
      if (fs2.existsSync(candidate)) {
        return candidate;
      }
      continue;
    }
    const resolved = await findOnPath(candidate);
    if (resolved) {
      return resolved;
    }
  }
  throw new Error("OpenCode CLI not found. Set OPENCODE_BIN or install opencode.");
}
async function findOnPath(command) {
  const locator = process.platform === "win32" ? "where" : "which";
  const isWindows = process.platform === "win32";
  return await new Promise((resolve) => {
    const proc = spawn(locator, [command], {
      stdio: ["ignore", "pipe", "ignore"],
      shell: isWindows
    });
    let output = "";
    proc.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) {
        const first = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
        resolve(first);
        return;
      }
      resolve(undefined);
    });
    proc.on("error", () => resolve(undefined));
  });
}
async function runOpencodeCommand(binaryPath, args2) {
  const isWindows = process.platform === "win32";
  return await new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args2, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWindows,
      env: process.env
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}
async function findSessionIdByTitle(title) {
  const binaryPath = await ensureOpencodeAvailable();
  const result = await runOpencodeCommand(binaryPath, ["session", "list"]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "Failed to list OpenCode sessions.");
  }
  const normalizedTitle = title.trim();
  for (const rawLine of result.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("ses_"))
      continue;
    const match = line.match(/^(ses_[A-Za-z0-9]+)\s+(.*)$/);
    if (!match)
      continue;
    const [, nativeSessionId, remainder] = match;
    if (remainder.includes(normalizedTitle)) {
      return nativeSessionId;
    }
  }
  return;
}
async function deleteSessionById(sessionId) {
  const binaryPath = await ensureOpencodeAvailable();
  const result = await runOpencodeCommand(binaryPath, ["session", "delete", sessionId]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `Failed to delete OpenCode session ${sessionId}.`);
  }
}
function createTemporaryInstructionContext(options) {
  const config = {
    permission: "allow"
  };
  const baseDir = options.debugDir ?? fs2.mkdtempSync(path2.join(os.tmpdir(), "opencode-shim-"));
  fs2.mkdirSync(baseDir, { recursive: true });
  const instructionPath = path2.join(baseDir, `system-prompt-${options.shimSessionId}.md`);
  fs2.writeFileSync(instructionPath, `${buildInstructionFileContents({ cwd: options.cwd, appendSystemPrompt: options.appendSystemPrompt })}
`, "utf8");
  config.instructions = [instructionPath];
  return {
    envConfigContent: JSON.stringify(config),
    cleanup() {
      try {
        fs2.rmSync(instructionPath, { force: true });
      } catch {}
      if (!options.debugDir) {
        try {
          fs2.rmSync(baseDir, { recursive: true, force: true });
        } catch {}
      }
    }
  };
}
function createDebugWriters(debugDir, shimSessionId) {
  if (!debugDir) {
    return {};
  }
  fs2.mkdirSync(debugDir, { recursive: true });
  return {
    rawJsonlPath: path2.join(debugDir, `session-${shimSessionId}.raw.jsonl`),
    rawStderrPath: path2.join(debugDir, `session-${shimSessionId}.raw.log`)
  };
}
function appendDebug(pathname, chunk) {
  if (!pathname)
    return;
  fs2.appendFileSync(pathname, chunk, "utf8");
}
async function spawnOpencodeRun(options) {
  const binaryPath = await ensureOpencodeAvailable();
  const tempInstructionContext = createTemporaryInstructionContext(options);
  const debugWriters = createDebugWriters(options.debugDir, options.shimSessionId);
  const isWindows = process.platform === "win32";
  if (options.sandbox !== "none") {
    verboseLog(options.verbose, `OpenCode CLI has no documented sandbox flag for run mode; ignoring --sandbox=${options.sandbox}`);
  }
  const args2 = [
    "run",
    "--format",
    "json",
    "--model",
    options.model,
    "--dir",
    options.cwd
  ];
  if (options.nativeSessionId) {
    args2.push("--session", options.nativeSessionId);
  } else {
    args2.push("--title", options.shimSessionId);
  }
  const child = spawn(binaryPath, args2, {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    shell: isWindows,
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: tempInstructionContext.envConfigContent
    }
  });
  child.stdin.write(options.prompt);
  child.stdin.end();
  let stderrBuffer = "";
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderrBuffer += text;
    appendDebug(debugWriters.rawStderrPath, text);
  });
  const events = createEventStream(child, debugWriters.rawJsonlPath, options.verbose, options.idleTimeoutMs);
  const exitPromise = new Promise((resolve, reject) => {
    child.once("error", (error) => reject(error));
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => {
    tempInstructionContext.cleanup();
  });
  return {
    binaryPath,
    events,
    async waitForExit() {
      return exitPromise;
    },
    kill(signal = "SIGTERM") {
      if (!child.killed) {
        try {
          child.kill(signal);
        } catch {}
      }
    },
    getStderr() {
      return stderrBuffer;
    }
  };
}
function computeBusyTimeoutMs(idleTimeoutMs) {
  return Math.max(300000, Math.min(900000, idleTimeoutMs * 5));
}
function createEventStream(child, rawJsonlPath, verbose, idleTimeoutMs) {
  const lineStream = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const parsedEvents = async function* () {
    for await (const rawLine of lineStream) {
      const line = rawLine.trim();
      if (!line)
        continue;
      appendDebug(rawJsonlPath, `${line}
`);
      try {
        yield JSON.parse(line);
      } catch (error) {
        verboseLog(verbose, "Skipping non-JSON stdout line", {
          line,
          error: errorMessage(error)
        });
      }
    }
  }();
  return withAdaptiveTimeout(parsedEvents, {
    idleTimeoutMs,
    busyTimeoutMs: computeBusyTimeoutMs(idleTimeoutMs),
    onEvent(event, controller) {
      if (event.type === "step_start") {
        controller.markBusy();
        return;
      }
      if (event.type === "step_finish" || event.type === "error") {
        controller.markIdle();
      }
    }
  });
}
function filterDiagnosticStderr(stderr) {
  return stderr.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    if (!trimmed)
      return false;
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed?.type !== "string";
    } catch {
      return true;
    }
  }).join(`
`).trim();
}

// src/selftest.ts
async function runCommand(command, args2) {
  const isWindows = process.platform === "win32";
  return await new Promise((resolve) => {
    const child = spawn2(command, args2, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWindows,
      env: process.env
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", () => resolve({ code: 1, stdout, stderr }));
  });
}
async function runSelfTest(version) {
  const checks = [];
  let binary = "";
  let opencodeVersion = "unknown";
  try {
    binary = await ensureOpencodeAvailable();
    checks.push({
      name: "agent_found",
      passed: true,
      message: `Found OpenCode at ${binary}`
    });
    const versionResult = await runCommand(binary, ["--version"]);
    if (versionResult.code === 0) {
      opencodeVersion = versionResult.stdout.trim() || "unknown";
      checks.push({
        name: "agent_version",
        passed: true,
        message: `OpenCode version ${opencodeVersion}`
      });
    } else {
      checks.push({
        name: "agent_version",
        passed: false,
        message: versionResult.stderr.trim() || "Unable to read OpenCode version"
      });
    }
    const modelsResult = await runCommand(binary, ["models", "google"]);
    checks.push({
      name: "models_command",
      passed: modelsResult.code === 0 && modelsResult.stdout.trim().length > 0,
      message: modelsResult.code === 0 ? "OpenCode model listing succeeded" : modelsResult.stderr.trim() || "OpenCode model listing failed"
    });
  } catch (error) {
    checks.push({
      name: "agent_found",
      passed: false,
      message: errorMessage(error)
    });
  }
  const hasEnvKey = Boolean(process.env.GOOGLE_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
  checks.push({
    name: "api_key_hint",
    passed: true,
    message: hasEnvKey ? "Detected at least one provider API key in environment" : "No provider API key detected in environment; OpenCode may still rely on stored auth"
  });
  const overallPassed = checks.every((check) => check.passed);
  process.stdout.write(`${JSON.stringify({
    shim: { name: "opencode-shim", version },
    agent: { name: "opencode", version: opencodeVersion, found: checks.some((c) => c.name === "agent_found" && c.passed) },
    checks,
    overall: {
      passed: overallPassed,
      message: overallPassed ? "All checks passed" : "One or more checks failed"
    }
  }, null, 2)}
`);
  return overallPassed ? 0 : 1;
}

// src/shim.ts
import fs3 from "node:fs";
import path3 from "node:path";

// src/utils/ids.ts
import { randomBytes, randomUUID as randomUUID2 } from "node:crypto";
var NIL_UUID = "00000000-0000-0000-0000-000000000000";
function generateSessionId() {
  return randomUUID2();
}
function generateMessageId() {
  return `msg_${randomBytes(8).toString("hex")}`;
}
function generateToolUseId() {
  return `toolu_${randomBytes(10).toString("hex")}`;
}
function isUuidLike(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) || value === NIL_UUID;
}
function normalizeMessageId(value) {
  if (typeof value === "string" && /^(msg_[a-zA-Z0-9]+|[0-9a-f-]{36})$/i.test(value)) {
    return value;
  }
  return generateMessageId();
}

// src/utils/models.ts
var SHORTNAME_MAP = {
  sonnet: "anthropic/claude-sonnet-4-20250514",
  haiku: "anthropic/claude-3-haiku-20240307",
  opus: "anthropic/claude-opus-4-20250514",
  flash: "google/gemini-2.5-flash",
  pro: "google/gemini-2.5-pro",
  gpt5: "openai/gpt-5"
};
function resolveModel(input) {
  const raw = input.trim();
  if (!raw) {
    return process.env.MODEL?.trim() || "anthropic/claude-sonnet-4-20250514";
  }
  const lowered = raw.toLowerCase();
  if (SHORTNAME_MAP[lowered]) {
    return SHORTNAME_MAP[lowered];
  }
  if (raw.includes("/")) {
    return raw;
  }
  if (lowered.startsWith("claude") || lowered.includes("sonnet") || lowered.includes("haiku") || lowered.includes("opus")) {
    return `anthropic/${raw}`;
  }
  if (lowered.startsWith("gemini") || lowered.includes("flash") || lowered.includes("gemini-")) {
    return `google/${raw}`;
  }
  if (lowered.startsWith("gpt") || lowered.startsWith("o1") || lowered.startsWith("o3") || lowered.startsWith("o4")) {
    return `openai/${raw}`;
  }
  return raw;
}
function providerFromModel(model) {
  const [provider] = model.split("/", 1);
  return provider && model.includes("/") ? provider : undefined;
}
function detectApiKeySource(model) {
  const provider = providerFromModel(model);
  const providerEnv = provider === "anthropic" ? "ANTHROPIC_API_KEY" : provider === "google" ? "GOOGLE_API_KEY" : provider === "openai" ? "OPENAI_API_KEY" : provider === "groq" ? "GROQ_API_KEY" : provider === "cerebras" ? "CEREBRAS_API_KEY" : undefined;
  if (providerEnv && process.env[providerEnv]) {
    return providerEnv;
  }
  if (process.env.ANTHROPIC_API_KEY || process.env.GOOGLE_API_KEY || process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY || process.env.CEREBRAS_API_KEY) {
    return "env";
  }
  return "none";
}
function supportsGeminiEmptyRetry(model) {
  return model.startsWith("google/gemini");
}

// src/utils/tools.ts
var TOOL_NAME_MAP = {
  read: "Read",
  file_read: "Read",
  readfile: "Read",
  write: "Write",
  file_write: "Write",
  writefile: "Write",
  edit: "Edit",
  str_replace_editor: "Edit",
  bash: "Bash",
  shell: "Bash",
  execute_bash: "Bash",
  glob: "Glob",
  find_files: "Glob",
  grep: "Grep",
  search_files: "Grep",
  ls: "LS",
  list: "LS",
  list_directory: "LS"
};
function normalizeToolName(name) {
  if (typeof name !== "string" || !name.trim()) {
    return "Tool";
  }
  const trimmed = name.trim();
  const normalizedKey = trimmed.toLowerCase().replace(/[\s-]+/g, "_");
  return TOOL_NAME_MAP[normalizedKey] ?? trimmed;
}
function camelToSnakeKey(value) {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizeToolInput(toolName, input) {
  if (!isRecord(input)) {
    return;
  }
  const normalized = {};
  for (const [key, value] of Object.entries(input)) {
    normalized[camelToSnakeKey(key)] = value;
  }
  switch (toolName) {
    case "Bash": {
      if (typeof normalized.command === "string") {
        return { command: normalized.command };
      }
      return normalized;
    }
    case "Read": {
      if (typeof normalized.file_path === "string") {
        return { file_path: normalized.file_path };
      }
      return normalized;
    }
    case "Write": {
      const result = {};
      if (typeof normalized.file_path === "string")
        result.file_path = normalized.file_path;
      if (typeof normalized.content === "string")
        result.content = normalized.content;
      return Object.keys(result).length > 0 ? result : normalized;
    }
    case "Edit": {
      const result = {};
      if (typeof normalized.file_path === "string")
        result.file_path = normalized.file_path;
      if (typeof normalized.old_string === "string")
        result.old_string = normalized.old_string;
      if (typeof normalized.new_string === "string")
        result.new_string = normalized.new_string;
      return Object.keys(result).length > 0 ? result : normalized;
    }
    default:
      return normalized;
  }
}
function stringifyToolOutput(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return "";
  }
  return JSON.stringify(value);
}
function extractToolResultContent(toolName, state) {
  const rawOutput = stringifyToolOutput(state.output);
  const metadata = isRecord(state.metadata) ? state.metadata : undefined;
  const input = isRecord(state.input) ? state.input : undefined;
  const exitCode = typeof metadata?.exit === "number" ? metadata.exit : undefined;
  const status = typeof state.status === "string" ? state.status : undefined;
  if (status === "error") {
    const errorText = rawOutput || stringifyToolOutput(metadata?.error) || `${toolName} failed`;
    return { is_error: true, error: errorText };
  }
  if (toolName === "Bash" && exitCode !== undefined && exitCode !== 0) {
    const detail = rawOutput.trim();
    return {
      is_error: true,
      error: detail ? `Exit code ${exitCode}: ${detail}` : `Exit code ${exitCode}`
    };
  }
  if (rawOutput.length > 0) {
    return rawOutput;
  }
  if (toolName === "Write" && typeof input?.filePath === "string") {
    return `File written: ${String(input.filePath)}`;
  }
  if (toolName === "Write" && typeof input?.file_path === "string") {
    return `File written: ${String(input.file_path)}`;
  }
  if (toolName === "Read") {
    const filePath = typeof input?.filePath === "string" ? input.filePath : input?.file_path;
    if (typeof filePath === "string") {
      return `Read file: ${filePath}`;
    }
  }
  if (toolName === "Bash") {
    return exitCode === 0 || exitCode === undefined ? "Command completed successfully with no output." : `Exit code ${exitCode}`;
  }
  if (typeof state.title === "string" && state.title) {
    return state.title;
  }
  return `${toolName} completed.`;
}

// src/shim.ts
var MAX_EMPTY_RETRIES = 5;
function emptyUsage() {
  return {};
}
function debugJsonlPath(debugDir, sessionId) {
  return debugDir ? path3.join(debugDir, `session-${sessionId}.raw.jsonl`) : undefined;
}
function debugLogPath(debugDir, sessionId) {
  return debugDir ? path3.join(debugDir, `session-${sessionId}.raw.log`) : undefined;
}
function appendDebugJson(debugDir, sessionId, payload) {
  const filePath = debugJsonlPath(debugDir, sessionId);
  if (!filePath)
    return;
  fs3.mkdirSync(path3.dirname(filePath), { recursive: true });
  fs3.appendFileSync(filePath, `${JSON.stringify(payload)}
`, "utf8");
}
function appendDebugLog(debugDir, sessionId, text) {
  const filePath = debugLogPath(debugDir, sessionId);
  if (!filePath)
    return;
  fs3.mkdirSync(path3.dirname(filePath), { recursive: true });
  fs3.appendFileSync(filePath, text.endsWith(`
`) ? text : `${text}
`, "utf8");
}
function touchDebugLog(debugDir, sessionId) {
  const filePath = debugLogPath(debugDir, sessionId);
  if (!filePath)
    return;
  fs3.mkdirSync(path3.dirname(filePath), { recursive: true });
  if (!fs3.existsSync(filePath)) {
    fs3.writeFileSync(filePath, "", "utf8");
  }
}
function addUsage(target, incoming) {
  if (!incoming)
    return;
  for (const key of [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens"
  ]) {
    const value = incoming[key];
    if (typeof value === "number") {
      target[key] = (target[key] ?? 0) + value;
    }
  }
}
function usageFromStepTokens(tokens) {
  if (!tokens)
    return;
  const cache = typeof tokens.cache === "object" && tokens.cache !== null ? tokens.cache : undefined;
  return {
    input_tokens: typeof tokens.input === "number" ? tokens.input : undefined,
    output_tokens: typeof tokens.output === "number" ? tokens.output : undefined,
    cache_creation_input_tokens: typeof cache?.write === "number" ? cache.write : undefined,
    cache_read_input_tokens: typeof cache?.read === "number" ? cache.read : undefined
  };
}
function summarizeAssistantText(step) {
  return step.contentBlocks.filter((block) => block.type === "text").map((block) => block.text).join(`
`).trim();
}
function summarizeLastToolResult(step) {
  const last = step.toolResults.at(-1);
  if (!last)
    return "";
  return typeof last.content === "string" ? last.content : last.content.error;
}
function humanizeToolSummary(summary) {
  const contentMatch = summary.match(/<content>([\s\S]*?)<\/content>/i);
  const body = (contentMatch?.[1] ?? summary).trim();
  return body || summary;
}
function createStepAccumulator(messageId) {
  return {
    messageId: normalizeMessageId(messageId),
    contentBlocks: [],
    toolResults: []
  };
}
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}
function extractEventError(event) {
  const err = asRecord(event.error);
  const data = asRecord(err?.data);
  return typeof data?.message === "string" && data.message || typeof err?.message === "string" && err.message || "Unknown OpenCode error";
}
function isRetryableEmptyGeminiResponse(summary) {
  return !summary.sawAnyContent && summary.numTurns > 0 && (summary.totalUsage.output_tokens ?? 0) === 0 && summary.totalCostUsd > 0;
}
function classifyRuntimeError(message) {
  if (/timeout|rate limit|auth|unauthorized|forbidden|model not found|api/i.test(message)) {
    return `API Error: ${message}`;
  }
  return `Agent Error: ${message}`;
}
function detectSuspiciousWorkspacePath(toolName, input, cwd) {
  if (!input)
    return;
  if (!["Write", "Read", "Edit", "Glob", "Grep", "LS"].includes(toolName)) {
    return;
  }
  const candidates = [input.file_path, input.path];
  for (const value of candidates) {
    if (typeof value !== "string")
      continue;
    if (!path3.isAbsolute(value))
      continue;
    const relative = path3.relative(cwd, value);
    if (relative.startsWith("..") || path3.isAbsolute(relative)) {
      return value;
    }
  }
  return;
}
function syntheticErrorAssistant(message) {
  return {
    type: "assistant",
    message: {
      id: NIL_UUID,
      type: "message",
      role: "assistant",
      model: "<synthetic>",
      content: [{ type: "text", text: message }],
      stop_reason: "end_turn"
    }
  };
}
function resultMessage(params) {
  return {
    type: "result",
    subtype: params.isError ? "error" : "success",
    is_error: params.isError,
    duration_ms: params.durationMs,
    duration_api_ms: params.durationApiMs,
    num_turns: params.numTurns,
    result: params.result,
    session_id: params.sessionId,
    total_cost_usd: params.totalCostUsd,
    usage: params.usage
  };
}
async function processAttempt(params) {
  const handle = await spawnOpencodeRun({
    prompt: params.prompt,
    model: params.model,
    cwd: params.cwd,
    nativeSessionId: params.nativeSessionId,
    appendSystemPrompt: params.args.appendSystemPrompt,
    verbose: params.args.verbose,
    debugDir: params.args.debugDir,
    sandbox: params.args.sandbox,
    shimSessionId: params.shimSessionId,
    idleTimeoutMs: params.args.idleTimeout * 1000
  });
  params.onHandle?.(() => handle.kill("SIGTERM"));
  let currentStep;
  const toolIdMap = new Map;
  const bufferedMessages = [];
  let suspiciousWorkspacePath;
  const summary = {
    sawAnyContent: false,
    sawTerminalStop: false,
    totalCostUsd: 0,
    totalUsage: emptyUsage(),
    numTurns: 0,
    finalResultText: "",
    lastToolSummary: ""
  };
  const ensureCurrentStep = (part) => {
    if (!currentStep) {
      currentStep = createStepAccumulator(part?.messageID);
    }
    return currentStep;
  };
  const flushStep = (reason, usage) => {
    if (!currentStep)
      return;
    const hasAssistantContent = currentStep.contentBlocks.length > 0;
    if (hasAssistantContent) {
      const assistantMsg = {
        type: "assistant",
        message: {
          id: currentStep.messageId || generateMessageId(),
          type: "message",
          role: "assistant",
          model: params.model,
          content: currentStep.contentBlocks,
          usage,
          stop_reason: reason === "tool-calls" ? "tool_use" : "end_turn"
        }
      };
      emit(assistantMsg);
      bufferedMessages.push(assistantMsg);
    }
    if (currentStep.toolResults.length > 0) {
      const userMessage = {
        type: "user",
        message: {
          role: "user",
          content: currentStep.toolResults
        }
      };
      emit(userMessage);
      bufferedMessages.push(userMessage);
    }
    const textSummary = summarizeAssistantText(currentStep);
    if (textSummary) {
      summary.finalResultText = textSummary;
    }
    const toolSummary = summarizeLastToolResult(currentStep);
    if (toolSummary && toolSummary.length >= summary.lastToolSummary.length) {
      summary.lastToolSummary = toolSummary;
    }
    currentStep = undefined;
  };
  try {
    for await (const event of handle.events) {
      if (typeof event.timestamp === "number") {
        summary.firstEventTimestamp ??= event.timestamp;
        summary.lastEventTimestamp = event.timestamp;
      }
      if (typeof event.sessionID === "string") {
        summary.opencodeSessionId = event.sessionID;
      }
      switch (event.type) {
        case "step_start": {
          const part = asRecord(event.part);
          currentStep = createStepAccumulator(part?.messageID);
          break;
        }
        case "text": {
          const part = asRecord(event.part);
          const step = ensureCurrentStep(part);
          if (typeof part?.text === "string" && part.text.length > 0) {
            step.contentBlocks.push({ type: "text", text: part.text });
            summary.sawAnyContent = true;
          }
          break;
        }
        case "reasoning": {
          const part = asRecord(event.part);
          const step = ensureCurrentStep(part);
          const thinking = typeof part?.text === "string" ? part.text : typeof part?.reasoning === "string" ? part.reasoning : undefined;
          if (thinking) {
            step.contentBlocks.push({ type: "thinking", thinking });
            summary.sawAnyContent = true;
          }
          break;
        }
        case "tool_use": {
          const part = asRecord(event.part);
          const step = ensureCurrentStep(part);
          const toolName = normalizeToolName(part?.tool);
          const nativeToolId = typeof part?.callID === "string" ? part.callID : generateToolUseId();
          const publicToolId = toolIdMap.get(nativeToolId) ?? generateToolUseId();
          toolIdMap.set(nativeToolId, publicToolId);
          const state = asRecord(part?.state) ?? {};
          const normalizedInput = normalizeToolInput(toolName, state.input);
          suspiciousWorkspacePath ??= detectSuspiciousWorkspacePath(toolName, normalizedInput, params.cwd);
          step.contentBlocks.push({
            type: "tool_use",
            id: publicToolId,
            name: toolName,
            input: normalizedInput
          });
          step.toolResults.push({
            type: "tool_result",
            tool_use_id: publicToolId,
            content: extractToolResultContent(toolName, state)
          });
          summary.sawAnyContent = true;
          break;
        }
        case "step_finish": {
          const part = asRecord(event.part);
          const usage = usageFromStepTokens(asRecord(part?.tokens));
          addUsage(summary.totalUsage, usage);
          if (typeof part?.cost === "number") {
            summary.totalCostUsd += part.cost;
          }
          summary.numTurns += 1;
          const reason = typeof part?.reason === "string" ? part.reason : undefined;
          if (reason === "stop") {
            summary.sawTerminalStop = true;
          }
          flushStep(reason, usage);
          break;
        }
        case "error": {
          throw new Error(extractEventError(event));
        }
        default: {
          break;
        }
      }
    }
  } catch (error) {
    handle.kill("SIGTERM");
    try {
      await handle.waitForExit();
    } catch {}
    throw error;
  }
  const exitStatus = await handle.waitForExit();
  return {
    summary,
    messages: bufferedMessages,
    exitCode: exitStatus.code,
    signal: exitStatus.signal,
    stderr: filterDiagnosticStderr(handle.getStderr()),
    suspiciousWorkspacePath
  };
}
function buildPrompt(prompt, retryNote) {
  const normalized = prompt.endsWith(`
`) ? prompt : `${prompt}
`;
  if (!retryNote) {
    return normalized;
  }
  return `${normalized}
[Internal retry note: ${retryNote}. Do not mention or repeat this note.]
`;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function runShim({ prompt, args: args2 }) {
  const cwd = process.cwd();
  const model = resolveModel(args2.model || process.env.MODEL || "sonnet");
  const sessionManager = args2.debugDir ? new SessionManager({ debugDir: args2.debugDir }) : undefined;
  await ensureOpencodeAvailable();
  let shimSessionId = args2.resume ? args2.resume : generateSessionId();
  let nativeSessionId;
  if (args2.resume) {
    if (!isUuidLike(args2.resume)) {
      const message = `Invalid session ID: ${args2.resume}`;
      appendDebugLog(args2.debugDir, "unknown", message);
      process.stderr.write(`${message}
`);
      return 1;
    }
    try {
      if (sessionManager) {
        try {
          const saved = sessionManager.loadSession(args2.resume);
          nativeSessionId = saved.agentSessionId;
          shimSessionId = saved.sessionId;
        } catch {
          nativeSessionId = await findSessionIdByTitle(args2.resume);
          if (!nativeSessionId) {
            throw new Error(`Session not found: ${args2.resume}`);
          }
        }
      } else {
        nativeSessionId = await findSessionIdByTitle(args2.resume);
        if (!nativeSessionId) {
          throw new Error(`Session not found: ${args2.resume}`);
        }
      }
    } catch (error) {
      const message = errorMessage(error);
      appendDebugLog(args2.debugDir, "unknown", message);
      process.stderr.write(`${message}
`);
      return 1;
    }
  }
  const system = {
    type: "system",
    subtype: "init",
    cwd: path3.resolve(cwd),
    session_id: shimSessionId,
    tools: [...STANDARD_TOOLS],
    model,
    permissionMode: "bypassPermissions",
    apiKeySource: detectApiKeySource(model),
    mcp_servers: []
  };
  touchDebugLog(args2.debugDir, shimSessionId);
  appendDebugJson(args2.debugDir, shimSessionId, {
    type: "init",
    session_id: shimSessionId,
    cwd: system.cwd,
    model
  });
  emit(system);
  const startTime = Date.now();
  const interruptedRef = { value: false };
  let activeKill;
  const onSignal = () => {
    if (interruptedRef.value)
      return;
    interruptedRef.value = true;
    activeKill?.();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const grandUsage = emptyUsage();
  let grandCostUsd = 0;
  let finalSummary;
  let finalStderr = "";
  let retryNote;
  try {
    for (let attempt = 0;attempt <= MAX_EMPTY_RETRIES; attempt++) {
      verboseLog(args2.verbose, "Starting attempt", { attempt: attempt + 1, model, resumed: Boolean(args2.resume) });
      if (args2.verbose) {
        appendDebugLog(args2.debugDir, shimSessionId, `[opencode-shim] Starting attempt ${attempt + 1} model=${model} resumed=${Boolean(args2.resume)}`);
      }
      const attemptPromise = processAttempt({
        prompt: buildPrompt(prompt, retryNote),
        args: args2,
        model,
        cwd,
        shimSessionId,
        nativeSessionId,
        interruptedRef,
        onHandle(kill) {
          activeKill = kill;
          if (interruptedRef.value) {
            kill();
          }
        }
      });
      const outcome = await attemptPromise;
      activeKill = undefined;
      finalStderr = outcome.stderr;
      addUsage(grandUsage, outcome.summary.totalUsage);
      grandCostUsd += outcome.summary.totalCostUsd;
      if (outcome.summary.opencodeSessionId) {
        nativeSessionId = outcome.summary.opencodeSessionId;
      }
      const retryableEmpty = !args2.resume && !interruptedRef.value && supportsGeminiEmptyRetry(model) && isRetryableEmptyGeminiResponse(outcome.summary);
      const retryableStaleWorkspace = !args2.resume && !interruptedRef.value && supportsGeminiEmptyRetry(model) && Boolean(outcome.suspiciousWorkspacePath);
      if (retryableEmpty || retryableStaleWorkspace) {
        retryNote = retryableEmpty ? `Retry token ${Date.now()}-${attempt}. A previous hidden attempt returned an empty response with zero output tokens. Produce a fresh non-empty answer and do not reuse any cached empty response` : `Retry token ${Date.now()}-${attempt}. A previous hidden attempt referenced the stale path ${outcome.suspiciousWorkspacePath}. The current working directory is ${cwd}. Redo the task from scratch and only use files inside ${cwd}`;
      }
      if ((retryableEmpty || retryableStaleWorkspace) && attempt < MAX_EMPTY_RETRIES) {
        const backoffMs = Math.min(1000 * 2 ** attempt, 8000);
        verboseLog(args2.verbose, retryableEmpty ? "Retrying empty Gemini response" : "Retrying suspicious workspace response", {
          attempt: attempt + 1,
          backoffMs,
          suspiciousWorkspacePath: outcome.suspiciousWorkspacePath
        });
        if (args2.verbose) {
          appendDebugLog(args2.debugDir, shimSessionId, `[opencode-shim] retry reason=${retryableEmpty ? "empty-response" : "suspicious-workspace"} attempt=${attempt + 1} backoff_ms=${backoffMs}`);
        }
        if (outcome.summary.opencodeSessionId) {
          try {
            await deleteSessionById(outcome.summary.opencodeSessionId);
          } catch (cleanupError) {
            verboseLog(args2.verbose, "Failed to delete discarded OpenCode retry session", {
              sessionId: outcome.summary.opencodeSessionId,
              error: errorMessage(cleanupError)
            });
          }
        }
        nativeSessionId = undefined;
        await sleep(backoffMs);
        continue;
      }
      if (retryableEmpty || retryableStaleWorkspace) {
        throw new Error(retryableEmpty ? "Provider returned repeated empty responses after retries" : `Provider returned stale workspace tool paths after retries: ${outcome.suspiciousWorkspacePath}`);
      }
      finalSummary = outcome.summary;
      if (interruptedRef.value) {
        break;
      }
      if (outcome.exitCode !== 0 && outcome.exitCode !== null) {
        throw new Error(outcome.stderr || `OpenCode exited with code ${outcome.exitCode}`);
      }
      if (outcome.signal && !interruptedRef.value) {
        throw new Error(`OpenCode exited due to signal ${outcome.signal}`);
      }
      break;
    }
    if (!finalSummary) {
      throw new Error("OpenCode produced no final summary.");
    }
    if (!interruptedRef.value && !finalSummary.sawTerminalStop) {
      throw new Error('OpenCode exited without a terminal step_finish reason "stop".');
    }
    if (sessionManager && nativeSessionId && shimSessionId !== NIL_UUID) {
      sessionManager.saveSession({
        sessionId: shimSessionId,
        agentSessionId: nativeSessionId,
        timestamp: new Date().toISOString(),
        metadata: { cwd, model }
      });
    }
    const durationMs = Date.now() - startTime;
    const durationApiMs = durationMs;
    if (!finalSummary.finalResultText && finalSummary.lastToolSummary) {
      emit({
        type: "assistant",
        message: {
          id: generateMessageId(),
          type: "message",
          role: "assistant",
          model: "<synthetic>",
          content: [{ type: "text", text: humanizeToolSummary(finalSummary.lastToolSummary) }],
          stop_reason: "end_turn"
        }
      });
    }
    const resultText = interruptedRef.value ? finalSummary.finalResultText || humanizeToolSummary(finalSummary.lastToolSummary) || "Interrupted" : finalSummary.finalResultText || humanizeToolSummary(finalSummary.lastToolSummary) || "Completed successfully.";
    const finalResultMessage = resultMessage({
      isError: false,
      durationMs,
      durationApiMs,
      numTurns: finalSummary.numTurns,
      result: resultText,
      sessionId: shimSessionId,
      usage: grandUsage,
      totalCostUsd: grandCostUsd
    });
    emit(finalResultMessage);
    appendDebugJson(args2.debugDir, shimSessionId, {
      type: "result",
      status: "success",
      exit_code: 0,
      duration_ms: durationMs
    });
    await flushStdout();
    return 0;
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const durationApiMs = durationMs;
    const rawMessage = error instanceof IdleTimeoutError || error instanceof BusyStepTimeoutError ? error.message : errorMessage(error) || finalStderr || "Unknown runtime failure";
    const classified = classifyRuntimeError(rawMessage);
    emit(syntheticErrorAssistant(classified));
    const finalResultMessage = resultMessage({
      isError: true,
      durationMs,
      durationApiMs,
      numTurns: finalSummary?.numTurns ?? 0,
      result: classified,
      sessionId: shimSessionId,
      usage: grandUsage,
      totalCostUsd: grandCostUsd
    });
    emit(finalResultMessage);
    appendDebugJson(args2.debugDir, shimSessionId, {
      type: "result",
      status: "error",
      exit_code: 1,
      duration_ms: durationMs,
      error: classified
    });
    appendDebugLog(args2.debugDir, shimSessionId, classified);
    await flushStdout();
    return 1;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

// src/index.ts
function printHelp() {
  process.stdout.write(`opencode-shim

Usage:
  echo "prompt" | opencode-shim --model google/gemini-2.5-flash

Options:
  --model <model>                Model name (required in normal mode)
  --resume <session_id>          Resume a prior shim session
  --verbose                      Verbose logs to stderr
  --append-system-prompt <text>  Extra instruction to inject via OpenCode instructions
  --idle-timeout <seconds>       Baseline idle timeout (default: 120)
  --debug-dir <path>             Debug/session directory
  --sandbox <level>              none | standard | strict
  --self-test                    Run environment checks
  --version                      Print version
  --help                         Show help
`);
}
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
function appendUnknownDebugLog(debugDir, message) {
  if (!debugDir)
    return;
  fs4.mkdirSync(debugDir, { recursive: true });
  fs4.appendFileSync(path4.join(debugDir, "session-unknown.raw.log"), `${message}
`, "utf8");
}
async function main() {
  const args2 = parseArgs(process.argv.slice(2), {
    "-m": "--model",
    "-h": "--help",
    "-v": "--version"
  });
  if (args2.help) {
    printHelp();
    return 0;
  }
  if (args2.version) {
    process.stdout.write(`${package_default.version}
`);
    return 0;
  }
  if (args2.selfTest) {
    return await runSelfTest(package_default.version);
  }
  const prompt = (await readStdin()).trim();
  if (!prompt) {
    return 0;
  }
  if (!args2.model && !process.env.MODEL) {
    const message = "Missing required --model";
    appendUnknownDebugLog(args2.debugDir, message);
    process.stderr.write(`${message}
`);
    return 1;
  }
  try {
    return await runShim({ prompt, args: args2 });
  } catch (error) {
    const message = errorMessage(error);
    appendUnknownDebugLog(args2.debugDir, message);
    process.stderr.write(`${message}
`);
    return 1;
  }
}
var exitCode = await main();
process.exitCode = exitCode;
