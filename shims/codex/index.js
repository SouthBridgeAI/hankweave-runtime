#!/usr/bin/env node

// src/shim.ts
import { spawn as spawn2 } from "child_process";
import fs5 from "fs";
import path6 from "path";

// node_modules/@openai/codex-sdk/dist/index.js
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import path2 from "path";
import readline from "readline";
import { createRequire } from "module";
async function createOutputSchemaFile(schema) {
  if (schema === void 0) {
    return { cleanup: async () => {
    } };
  }
  if (!isJsonObject(schema)) {
    throw new Error("outputSchema must be a plain JSON object");
  }
  const schemaDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-output-schema-"));
  const schemaPath = path.join(schemaDir, "schema.json");
  const cleanup = async () => {
    try {
      await fs.rm(schemaDir, { recursive: true, force: true });
    } catch {
    }
  };
  try {
    await fs.writeFile(schemaPath, JSON.stringify(schema), "utf8");
    return { schemaPath, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
function isJsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var Thread = class {
  _exec;
  _options;
  _id;
  _threadOptions;
  /** Returns the ID of the thread. Populated after the first turn starts. */
  get id() {
    return this._id;
  }
  /* @internal */
  constructor(exec, options, threadOptions, id = null) {
    this._exec = exec;
    this._options = options;
    this._id = id;
    this._threadOptions = threadOptions;
  }
  /** Provides the input to the agent and streams events as they are produced during the turn. */
  async runStreamed(input, turnOptions = {}) {
    return { events: this.runStreamedInternal(input, turnOptions) };
  }
  async *runStreamedInternal(input, turnOptions = {}) {
    const { schemaPath, cleanup } = await createOutputSchemaFile(turnOptions.outputSchema);
    const options = this._threadOptions;
    const { prompt, images } = normalizeInput(input);
    const generator = this._exec.run({
      input: prompt,
      baseUrl: this._options.baseUrl,
      apiKey: this._options.apiKey,
      threadId: this._id,
      images,
      model: options?.model,
      sandboxMode: options?.sandboxMode,
      workingDirectory: options?.workingDirectory,
      skipGitRepoCheck: options?.skipGitRepoCheck,
      outputSchemaFile: schemaPath,
      modelReasoningEffort: options?.modelReasoningEffort,
      signal: turnOptions.signal,
      networkAccessEnabled: options?.networkAccessEnabled,
      webSearchMode: options?.webSearchMode,
      webSearchEnabled: options?.webSearchEnabled,
      approvalPolicy: options?.approvalPolicy,
      additionalDirectories: options?.additionalDirectories
    });
    try {
      for await (const item of generator) {
        let parsed;
        try {
          parsed = JSON.parse(item);
        } catch (error) {
          throw new Error(`Failed to parse item: ${item}`, { cause: error });
        }
        if (parsed.type === "thread.started") {
          this._id = parsed.thread_id;
        }
        yield parsed;
      }
    } finally {
      await cleanup();
    }
  }
  /** Provides the input to the agent and returns the completed turn. */
  async run(input, turnOptions = {}) {
    const generator = this.runStreamedInternal(input, turnOptions);
    const items = [];
    let finalResponse = "";
    let usage = null;
    let turnFailure = null;
    for await (const event of generator) {
      if (event.type === "item.completed") {
        if (event.item.type === "agent_message") {
          finalResponse = event.item.text;
        }
        items.push(event.item);
      } else if (event.type === "turn.completed") {
        usage = event.usage;
      } else if (event.type === "turn.failed") {
        turnFailure = event.error;
        break;
      }
    }
    if (turnFailure) {
      throw new Error(turnFailure.message);
    }
    return { items, finalResponse, usage };
  }
};
function normalizeInput(input) {
  if (typeof input === "string") {
    return { prompt: input, images: [] };
  }
  const promptParts = [];
  const images = [];
  for (const item of input) {
    if (item.type === "text") {
      promptParts.push(item.text);
    } else if (item.type === "local_image") {
      images.push(item.path);
    }
  }
  return { prompt: promptParts.join("\n\n"), images };
}
var INTERNAL_ORIGINATOR_ENV = "CODEX_INTERNAL_ORIGINATOR_OVERRIDE";
var TYPESCRIPT_SDK_ORIGINATOR = "codex_sdk_ts";
var CODEX_NPM_NAME = "@openai/codex";
var PLATFORM_PACKAGE_BY_TARGET = {
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
  "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
  "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64"
};
var moduleRequire = createRequire(import.meta.url);
var CodexExec = class {
  executablePath;
  envOverride;
  configOverrides;
  constructor(executablePath = null, env, configOverrides) {
    this.executablePath = executablePath || findCodexPath();
    this.envOverride = env;
    this.configOverrides = configOverrides;
  }
  async *run(args) {
    const commandArgs = ["exec", "--experimental-json"];
    if (this.configOverrides) {
      for (const override of serializeConfigOverrides(this.configOverrides)) {
        commandArgs.push("--config", override);
      }
    }
    if (args.model) {
      commandArgs.push("--model", args.model);
    }
    if (args.sandboxMode) {
      commandArgs.push("--sandbox", args.sandboxMode);
    }
    if (args.workingDirectory) {
      commandArgs.push("--cd", args.workingDirectory);
    }
    if (args.additionalDirectories?.length) {
      for (const dir of args.additionalDirectories) {
        commandArgs.push("--add-dir", dir);
      }
    }
    if (args.skipGitRepoCheck) {
      commandArgs.push("--skip-git-repo-check");
    }
    if (args.outputSchemaFile) {
      commandArgs.push("--output-schema", args.outputSchemaFile);
    }
    if (args.modelReasoningEffort) {
      commandArgs.push("--config", `model_reasoning_effort="${args.modelReasoningEffort}"`);
    }
    if (args.networkAccessEnabled !== void 0) {
      commandArgs.push(
        "--config",
        `sandbox_workspace_write.network_access=${args.networkAccessEnabled}`
      );
    }
    if (args.webSearchMode) {
      commandArgs.push("--config", `web_search="${args.webSearchMode}"`);
    } else if (args.webSearchEnabled === true) {
      commandArgs.push("--config", `web_search="live"`);
    } else if (args.webSearchEnabled === false) {
      commandArgs.push("--config", `web_search="disabled"`);
    }
    if (args.approvalPolicy) {
      commandArgs.push("--config", `approval_policy="${args.approvalPolicy}"`);
    }
    if (args.threadId) {
      commandArgs.push("resume", args.threadId);
    }
    if (args.images?.length) {
      for (const image of args.images) {
        commandArgs.push("--image", image);
      }
    }
    const env = {};
    if (this.envOverride) {
      Object.assign(env, this.envOverride);
    } else {
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== void 0) {
          env[key] = value;
        }
      }
    }
    if (!env[INTERNAL_ORIGINATOR_ENV]) {
      env[INTERNAL_ORIGINATOR_ENV] = TYPESCRIPT_SDK_ORIGINATOR;
    }
    if (args.baseUrl) {
      env.OPENAI_BASE_URL = args.baseUrl;
    }
    if (args.apiKey) {
      env.CODEX_API_KEY = args.apiKey;
    }
    const child = spawn(this.executablePath, commandArgs, {
      env,
      signal: args.signal
    });
    let spawnError = null;
    child.once("error", (err) => spawnError = err);
    if (!child.stdin) {
      child.kill();
      throw new Error("Child process has no stdin");
    }
    child.stdin.write(args.input);
    child.stdin.end();
    if (!child.stdout) {
      child.kill();
      throw new Error("Child process has no stdout");
    }
    const stderrChunks = [];
    if (child.stderr) {
      child.stderr.on("data", (data) => {
        stderrChunks.push(data);
      });
    }
    const exitPromise = new Promise(
      (resolve) => {
        child.once("exit", (code, signal) => {
          resolve({ code, signal });
        });
      }
    );
    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity
    });
    try {
      for await (const line of rl) {
        yield line;
      }
      if (spawnError) throw spawnError;
      const { code, signal } = await exitPromise;
      if (code !== 0 || signal) {
        const stderrBuffer = Buffer.concat(stderrChunks);
        const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
        throw new Error(`Codex Exec exited with ${detail}: ${stderrBuffer.toString("utf8")}`);
      }
    } finally {
      rl.close();
      child.removeAllListeners();
      try {
        if (!child.killed) child.kill();
      } catch {
      }
    }
  }
};
function serializeConfigOverrides(configOverrides) {
  const overrides = [];
  flattenConfigOverrides(configOverrides, "", overrides);
  return overrides;
}
function flattenConfigOverrides(value, prefix, overrides) {
  if (!isPlainObject(value)) {
    if (prefix) {
      overrides.push(`${prefix}=${toTomlValue(value, prefix)}`);
      return;
    } else {
      throw new Error("Codex config overrides must be a plain object");
    }
  }
  const entries = Object.entries(value);
  if (!prefix && entries.length === 0) {
    return;
  }
  if (prefix && entries.length === 0) {
    overrides.push(`${prefix}={}`);
    return;
  }
  for (const [key, child] of entries) {
    if (!key) {
      throw new Error("Codex config override keys must be non-empty strings");
    }
    if (child === void 0) {
      continue;
    }
    const path32 = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(child)) {
      flattenConfigOverrides(child, path32, overrides);
    } else {
      overrides.push(`${path32}=${toTomlValue(child, path32)}`);
    }
  }
}
function toTomlValue(value, path32) {
  if (typeof value === "string") {
    return JSON.stringify(value);
  } else if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Codex config override at ${path32} must be a finite number`);
    }
    return `${value}`;
  } else if (typeof value === "boolean") {
    return value ? "true" : "false";
  } else if (Array.isArray(value)) {
    const rendered = value.map((item, index) => toTomlValue(item, `${path32}[${index}]`));
    return `[${rendered.join(", ")}]`;
  } else if (isPlainObject(value)) {
    const parts = [];
    for (const [key, child] of Object.entries(value)) {
      if (!key) {
        throw new Error("Codex config override keys must be non-empty strings");
      }
      if (child === void 0) {
        continue;
      }
      parts.push(`${formatTomlKey(key)} = ${toTomlValue(child, `${path32}.${key}`)}`);
    }
    return `{${parts.join(", ")}}`;
  } else if (value === null) {
    throw new Error(`Codex config override at ${path32} cannot be null`);
  } else {
    const typeName = typeof value;
    throw new Error(`Unsupported Codex config override value at ${path32}: ${typeName}`);
  }
}
var TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;
function formatTomlKey(key) {
  return TOML_BARE_KEY.test(key) ? key : JSON.stringify(key);
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function findCodexPath() {
  const { platform, arch } = process;
  let targetTriple = null;
  switch (platform) {
    case "linux":
    case "android":
      switch (arch) {
        case "x64":
          targetTriple = "x86_64-unknown-linux-musl";
          break;
        case "arm64":
          targetTriple = "aarch64-unknown-linux-musl";
          break;
        default:
          break;
      }
      break;
    case "darwin":
      switch (arch) {
        case "x64":
          targetTriple = "x86_64-apple-darwin";
          break;
        case "arm64":
          targetTriple = "aarch64-apple-darwin";
          break;
        default:
          break;
      }
      break;
    case "win32":
      switch (arch) {
        case "x64":
          targetTriple = "x86_64-pc-windows-msvc";
          break;
        case "arm64":
          targetTriple = "aarch64-pc-windows-msvc";
          break;
        default:
          break;
      }
      break;
    default:
      break;
  }
  if (!targetTriple) {
    throw new Error(`Unsupported platform: ${platform} (${arch})`);
  }
  const platformPackage = PLATFORM_PACKAGE_BY_TARGET[targetTriple];
  if (!platformPackage) {
    throw new Error(`Unsupported target triple: ${targetTriple}`);
  }
  let vendorRoot;
  try {
    const codexPackageJsonPath = moduleRequire.resolve(`${CODEX_NPM_NAME}/package.json`);
    const codexRequire = createRequire(codexPackageJsonPath);
    const platformPackageJsonPath = codexRequire.resolve(`${platformPackage}/package.json`);
    vendorRoot = path2.join(path2.dirname(platformPackageJsonPath), "vendor");
  } catch {
    throw new Error(
      `Unable to locate Codex CLI binaries. Ensure ${CODEX_NPM_NAME} is installed with optional dependencies.`
    );
  }
  const archRoot = path2.join(vendorRoot, targetTriple);
  const codexBinaryName = process.platform === "win32" ? "codex.exe" : "codex";
  const binaryPath = path2.join(archRoot, "codex", codexBinaryName);
  return binaryPath;
}
var Codex = class {
  exec;
  options;
  constructor(options = {}) {
    const { codexPathOverride, env, config } = options;
    this.exec = new CodexExec(codexPathOverride, env, config);
    this.options = options;
  }
  /**
   * Starts a new conversation with an agent.
   * @returns A new thread instance.
   */
  startThread(options = {}) {
    return new Thread(this.exec, this.options, options);
  }
  /**
   * Resumes a conversation with an agent based on the thread id.
   * Threads are persisted in ~/.codex/sessions.
   *
   * @param id The id of the thread to resume.
   * @returns A new thread instance.
   */
  resumeThread(id, options = {}) {
    return new Thread(this.exec, this.options, options, id);
  }
};

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
  for (let i = 0; i < argv.length; i++) {
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
          console.error(
            `Invalid --sandbox value: must be one of ${VALID_SANDBOX_LEVELS.join(", ")}`
          );
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
import { randomUUID } from "crypto";
import fs2 from "fs";
import path3 from "path";
var SessionManager = class {
  sessionsDir;
  constructor(options = {}) {
    if (options.debugDir) {
      this.sessionsDir = path3.join(options.debugDir, "sessions");
    } else {
      const home = process.env.HOME || process.env.USERPROFILE || "";
      if (!home) {
        throw new Error("Cannot determine home directory for session storage");
      }
      this.sessionsDir = path3.join(home, ".shim", "sessions");
    }
  }
  /**
   * Generate a new UUID v4 session ID
   */
  generateSessionId() {
    return randomUUID();
  }
  /**
   * Save session data
   */
  saveSession(data) {
    this.ensureSessionsDir();
    const sessionPath = path3.join(this.sessionsDir, `${data.sessionId}.json`);
    fs2.writeFileSync(sessionPath, JSON.stringify(data, null, 2), "utf8");
  }
  /**
   * Load session data by session ID
   * @throws Error if session not found
   */
  loadSession(sessionId) {
    const sessionPath = path3.join(this.sessionsDir, `${sessionId}.json`);
    try {
      const content = fs2.readFileSync(sessionPath, "utf8");
      return JSON.parse(content);
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error(`Session not found: ${sessionId}`);
      }
      throw error;
    }
  }
  /**
   * Check if session exists
   */
  sessionExists(sessionId) {
    const sessionPath = path3.join(this.sessionsDir, `${sessionId}.json`);
    return fs2.existsSync(sessionPath);
  }
  /**
   * Delete session data
   */
  deleteSession(sessionId) {
    const sessionPath = path3.join(this.sessionsDir, `${sessionId}.json`);
    try {
      fs2.unlinkSync(sessionPath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  /**
   * List all session IDs
   */
  listSessions() {
    try {
      const files = fs2.readdirSync(this.sessionsDir);
      return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
    } catch (error) {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }
  /**
   * Get the sessions directory path
   */
  getSessionsDir() {
    return this.sessionsDir;
  }
  ensureSessionsDir() {
    fs2.mkdirSync(this.sessionsDir, { recursive: true });
  }
};

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
import fs3 from "fs";
import path4 from "path";
var DebugRecorder = class {
  debugDir;
  rawJsonlPath;
  rawLogPath;
  constructor(debugDir) {
    this.debugDir = debugDir;
  }
  setSession(sessionId, init) {
    if (!this.debugDir) {
      return;
    }
    fs3.mkdirSync(this.debugDir, { recursive: true });
    this.rawJsonlPath = path4.join(this.debugDir, `session-${sessionId}.raw.jsonl`);
    this.rawLogPath = path4.join(this.debugDir, `session-${sessionId}.raw.log`);
    this.touch(this.rawJsonlPath);
    this.touch(this.rawLogPath);
    this.logJson({
      type: "init",
      session_id: sessionId,
      cwd: init.cwd,
      model: init.model,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    });
  }
  logSdkEvent(event) {
    this.logJson(event);
  }
  logResult(status, extra = {}) {
    this.logJson({
      type: "result",
      status,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      ...extra
    });
  }
  logLine(line) {
    if (!this.rawLogPath) {
      return;
    }
    fs3.appendFileSync(this.rawLogPath, line.endsWith("\n") ? line : `${line}
`, "utf8");
  }
  static logStartupError(debugDir, line) {
    if (!debugDir) {
      return;
    }
    fs3.mkdirSync(debugDir, { recursive: true });
    const rawLogPath = path4.join(debugDir, "session-unknown.raw.log");
    fs3.appendFileSync(rawLogPath, line.endsWith("\n") ? line : `${line}
`, "utf8");
  }
  logJson(value) {
    if (!this.rawJsonlPath) {
      return;
    }
    fs3.appendFileSync(this.rawJsonlPath, `${JSON.stringify(value)}
`, "utf8");
  }
  touch(filePath) {
    fs3.closeSync(fs3.openSync(filePath, "a"));
  }
};

// src/utils.ts
import { randomBytes, randomUUID as randomUUID2 } from "crypto";
import fs4 from "fs";
import os2 from "os";
import path5 from "path";
var NIL_UUID = "00000000-0000-0000-0000-000000000000";
var SESSION_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function generateSessionId() {
  return randomUUID2();
}
function generateMessageId() {
  return `msg_${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;
}
function generateToolUseId() {
  return `toolu_${Date.now().toString(36)}${randomBytes(8).toString("hex")}`;
}
function isValidSessionId(value) {
  return typeof value === "string" && SESSION_ID_REGEX.test(value);
}
function resolveModel(modelFromArgs) {
  const requestedModel = modelFromArgs?.trim() || process.env.MODEL?.trim() || "gpt-5.1-codex-max";
  let sdkModel = requestedModel;
  if (sdkModel.includes("/")) {
    const [provider, model] = sdkModel.split("/", 2);
    if (provider.toLowerCase() === "openai" && model) {
      sdkModel = model;
    }
  }
  let reasoningEffort = "high";
  const effortMatch = sdkModel.match(/^(.*)-(minimal|low|medium|high|xhigh)$/);
  if (effortMatch) {
    sdkModel = effortMatch[1];
    reasoningEffort = effortMatch[2];
  }
  const publicModel = `openai/${sdkModel}`;
  return {
    requestedModel,
    publicModel,
    sdkModel,
    reasoningEffort
  };
}
function mapSandbox(level) {
  switch (level) {
    case "strict":
      return "read-only";
    case "standard":
      return "workspace-write";
    case "none":
    default:
      return "danger-full-access";
  }
}
function detectApiKeySource() {
  if (process.env.OPENAI_API_KEY) {
    return "OPENAI_API_KEY";
  }
  if (process.env.CODEX_API_KEY) {
    return "CODEX_API_KEY";
  }
  const authPath = path5.join(os2.homedir(), ".codex", "auth.json");
  if (fs4.existsSync(authPath)) {
    return "~/.codex/auth.json";
  }
  return "none";
}
function hasAnyAuthConfigured() {
  return detectApiKeySource() !== "none";
}
function getCodexPathOverride() {
  const value = process.env.CODEX_PATH_OVERRIDE?.trim();
  return value ? value : void 0;
}
function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function camelToSnakeKey(key) {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
function topLevelCamelToSnake(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return void 0;
  }
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    result[camelToSnakeKey(key)] = entry;
  }
  return result;
}
async function flushStdout() {
  await new Promise((resolve, reject) => {
    const done = (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    if (process.stdout.write("")) {
      done();
      return;
    }
    process.stdout.once("drain", () => done());
    process.stdout.once("error", (error) => done(error));
  });
}
function makeAbsoluteCwd(cwd) {
  return path5.resolve(cwd);
}
function toRelativePath(filePath, cwd) {
  const absoluteCwd = path5.resolve(cwd);
  const absolutePath = path5.resolve(filePath);
  const relative = path5.relative(absoluteCwd, absolutePath);
  return relative && !relative.startsWith("..") ? relative : absolutePath;
}

// src/tools.ts
function normalizeToolUse(item, cwd) {
  switch (item.type) {
    case "command_execution":
      return normalizeCommandExecution(item);
    case "file_change":
      return normalizeFileChange(item, cwd);
    case "mcp_tool_call":
      return normalizeMcpToolCall(item);
    case "web_search":
      return normalizeWebSearch(item);
    default:
      return null;
  }
}
function normalizeToolResult(item, cwd) {
  switch (item.type) {
    case "command_execution":
      return normalizeCommandExecutionResult(item);
    case "file_change":
      return normalizeFileChangeResult(item, cwd);
    case "mcp_tool_call":
      return normalizeMcpToolCallResult(item);
    case "web_search":
      return {
        isError: false,
        content: `Web search completed for query: ${item.query}`
      };
    default:
      return null;
  }
}
function normalizeCommandExecution(item) {
  const innerCommand = extractInnerCommand(item.command);
  const simpleWrite = parseSimpleShellWrite(innerCommand);
  if (simpleWrite) {
    return {
      name: "Write",
      input: {
        file_path: simpleWrite.filePath,
        content: simpleWrite.content
      }
    };
  }
  const readMatch = innerCommand.match(/^cat\s+([^\s;&|]+)$/);
  if (readMatch) {
    return {
      name: "Read",
      input: { file_path: stripQuotes(readMatch[1]) }
    };
  }
  const lsMatch = innerCommand.match(/^ls(?:\s+(-[A-Za-z-]+))*?(?:\s+([^;&|]+))?$/);
  if (lsMatch) {
    const target = lsMatch[2]?.trim();
    return {
      name: "LS",
      input: target ? { path: stripQuotes(target) } : void 0
    };
  }
  const grepMatch = innerCommand.match(/^(?:rg|grep)\b(.*)$/);
  if (grepMatch) {
    return {
      name: "Grep",
      input: { command: innerCommand }
    };
  }
  const globMatch = innerCommand.match(/^(?:find|fd)\b(.*)$/);
  if (globMatch) {
    return {
      name: "Glob",
      input: { command: innerCommand }
    };
  }
  return {
    name: "Bash",
    input: { command: innerCommand }
  };
}
function normalizeCommandExecutionResult(item) {
  const output = item.aggregated_output;
  const innerCommand = extractInnerCommand(item.command);
  const simpleWrite = parseSimpleShellWrite(innerCommand);
  if (item.status === "failed" || typeof item.exit_code === "number" && item.exit_code !== 0) {
    return {
      isError: true,
      content: {
        is_error: true,
        error: output.trim() || `Command failed with exit code ${item.exit_code ?? "unknown"}`
      }
    };
  }
  if (output.trim().length > 0) {
    return {
      isError: false,
      content: output
    };
  }
  if (simpleWrite) {
    return {
      isError: false,
      content: `Wrote ${simpleWrite.filePath}`
    };
  }
  return {
    isError: false,
    content: `Command completed with exit code ${item.exit_code ?? 0} (no output).`
  };
}
function normalizeFileChange(item, cwd) {
  const paths = item.changes.map((change) => toRelativePath(change.path, cwd));
  const allAdds = item.changes.every((change) => change.kind === "add");
  return {
    name: allAdds ? "Write" : "Edit",
    input: paths.length === 1 ? { file_path: paths[0] } : { paths }
  };
}
function normalizeFileChangeResult(item, cwd) {
  const summary = item.changes.map((change) => `${change.kind} ${toRelativePath(change.path, cwd)}`).join(", ");
  if (item.status === "failed") {
    return {
      isError: true,
      content: {
        is_error: true,
        error: summary || "File change failed"
      }
    };
  }
  return {
    isError: false,
    content: summary ? `Applied file change: ${summary}` : "Applied file change."
  };
}
function normalizeMcpToolCall(item) {
  const lowerServer = item.server.toLowerCase();
  const lowerTool = item.tool.toLowerCase();
  if (lowerTool.includes("search") || lowerServer.includes("search") || lowerServer.includes("web")) {
    return {
      name: "WebSearch",
      input: topLevelCamelToSnake(item.arguments) ?? { arguments: item.arguments }
    };
  }
  if (lowerTool.includes("fetch") || lowerTool.includes("browse")) {
    return {
      name: "WebFetch",
      input: topLevelCamelToSnake(item.arguments) ?? { arguments: item.arguments }
    };
  }
  return {
    name: `${item.server}:${item.tool}`,
    input: topLevelCamelToSnake(item.arguments) ?? { arguments: item.arguments }
  };
}
function normalizeMcpToolCallResult(item) {
  if (item.status === "failed") {
    return {
      isError: true,
      content: {
        is_error: true,
        error: item.error?.message || "MCP tool call failed"
      }
    };
  }
  const textParts = item.result?.content?.map((block) => {
    if (block.type === "text") {
      return block.text;
    }
    return JSON.stringify(block);
  }).filter((value) => typeof value === "string" && value.length > 0);
  const combinedText = textParts?.join("\n").trim();
  return {
    isError: false,
    content: combinedText || (item.result?.structured_content !== void 0 ? JSON.stringify(item.result.structured_content) : `${item.server}:${item.tool} completed successfully.`)
  };
}
function normalizeWebSearch(item) {
  return {
    name: "WebSearch",
    input: { query: item.query }
  };
}
function shouldTreatAsToolItem(item) {
  return item.type === "command_execution" || item.type === "file_change" || item.type === "mcp_tool_call" || item.type === "web_search";
}
function extractInnerCommand(command) {
  const trimmed = command.trim();
  const zshMatch = trimmed.match(/-lc\s+([\s\S]+)$/);
  const shellCommand = zshMatch ? stripQuotes(zshMatch[1].trim()) : trimmed;
  return stripLeadingCdPrefix(shellCommand);
}
function stripLeadingCdPrefix(command) {
  const match = command.match(/^cd\s+(.+?)\s*&&\s*([\s\S]+)$/);
  if (!match) {
    return command;
  }
  return match[2].trim();
}
function parseSimpleShellWrite(command) {
  return parseHereDocShellWrite(command) ?? parseRedirectShellWrite(command);
}
function parseHereDocShellWrite(command) {
  const redirectFirst = command.match(
    /^cat\s*>\s*("(?:[^"\\]|\\.)+"|'(?:[^'\\]|\\.)+'|[^\s;&|]+)\s*<<['"]?([A-Za-z0-9_-]+)['"]?\n([\s\S]*?)\n\2$/
  );
  if (redirectFirst) {
    const [, rawFilePath, , body] = redirectFirst;
    return {
      filePath: stripQuotes(rawFilePath.trim()),
      content: `${body}
`
    };
  }
  const heredocFirst = command.match(
    /^cat\s*<<['"]?([A-Za-z0-9_-]+)['"]?\s*>\s*("(?:[^"\\]|\\.)+"|'(?:[^'\\]|\\.)+'|[^\s;&|]+)\n([\s\S]*?)\n\1$/
  );
  if (heredocFirst) {
    const [, , rawFilePath, body] = heredocFirst;
    return {
      filePath: stripQuotes(rawFilePath.trim()),
      content: `${body}
`
    };
  }
  return null;
}
function parseRedirectShellWrite(command) {
  const match = command.match(
    /^(printf|echo)(?:\s+(-n))?\s+([\s\S]+?)\s*>\s*("(?:[^"\\]|\\.)+"|'(?:[^'\\]|\\.)+'|[^\s;&|]+)$/
  );
  if (!match) {
    return null;
  }
  const [, commandName, noNewlineFlag, rawContent, rawFilePath] = match;
  const parsedContent = parseSimpleShellTextLiteral(rawContent.trim());
  if (parsedContent === void 0) {
    return null;
  }
  const content = commandName === "printf" ? decodePrintfEscapes(parsedContent) : noNewlineFlag === "-n" ? parsedContent : `${parsedContent}
`;
  return {
    filePath: stripQuotes(rawFilePath.trim()),
    content
  };
}
function parseSimpleShellTextLiteral(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') || trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return stripQuotes(trimmed);
  }
  if (/^[^\s;&|<>]+$/.test(trimmed)) {
    return trimmed;
  }
  return void 0;
}
function decodePrintfEscapes(value) {
  return value.replace(/\\\\/g, "\\").replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "	");
}
function stripQuotes(value) {
  if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

// src/timeout-state.ts
function shouldTreatTurnStartAsBusy(idleTimeoutMs) {
  return idleTimeoutMs > 1e3;
}
function updateCodexTimeoutState(event, controller, idleTimeoutMs) {
  const turnBusy = shouldTreatTurnStartAsBusy(idleTimeoutMs);
  switch (event.type) {
    case "turn.started": {
      if (turnBusy) {
        controller.markBusy();
      }
      return;
    }
    case "item.started":
    case "item.updated":
    case "item.completed": {
      if (turnBusy || shouldTreatAsToolItem(event.item)) {
        controller.markBusy();
      }
      return;
    }
    case "turn.completed":
    case "turn.failed": {
      controller.markIdle();
      return;
    }
    default:
      return;
  }
}

// package.json
var package_default = {
  name: "codex-shim",
  version: "0.1.0",
  private: true,
  description: "Self-contained Hankweave shim for OpenAI Codex via @openai/codex-sdk",
  type: "module",
  bin: {
    "codex-shim": "./index.js"
  },
  files: [
    "index.js",
    "dist",
    "src",
    "tests",
    "common",
    "docs",
    "README.md",
    "rebuild.sh",
    "VERSION",
    "THIRDPARTY.md",
    "tsconfig.json",
    "tsup.config.ts",
    "bun.lock"
  ],
  engines: {
    node: ">=18",
    bun: ">=1.1.0"
  },
  scripts: {
    build: "tsup",
    rebuild: "./rebuild.sh",
    test: "bun test",
    typecheck: "tsc --noEmit -p tsconfig.json",
    clean: `node -e "const fs=require('fs'); fs.rmSync('dist',{recursive:true,force:true}); fs.rmSync('index.js',{force:true});"`
  },
  dependencies: {
    "@openai/codex-sdk": "^0.112.0",
    "@shims/common": "file:./common"
  },
  devDependencies: {
    "@types/bun": "latest",
    "@types/node": "^20.10.0",
    tsup: "^8.0.1",
    typescript: "^5.3.0"
  }
};

// src/shim.ts
var DEFAULT_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "LS", "WebSearch"];
var HELP_TEXT = `codex-shim

Usage:
  codex-shim --model <model> [options]

Options:
  -p
  --model <model>
  --resume <session_id>
  --verbose
  --append-system-prompt <text>
  --idle-timeout <seconds>
  --debug-dir <path>
  --sandbox <none|standard|strict>
  --self-test
  --version
  --help
`;
function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}
`);
}
function usageToTokenUsage(usage) {
  if (!usage) {
    return void 0;
  }
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_input_tokens: usage.cached_input_tokens
  };
}
function createSystemMessage(cwd, sessionId, model) {
  return {
    type: "system",
    subtype: "init",
    cwd,
    session_id: sessionId,
    tools: DEFAULT_TOOLS,
    model,
    permissionMode: "bypassPermissions",
    apiKeySource: detectApiKeySource(),
    mcp_servers: []
  };
}
function createAssistantMessage(model, content, stopReason = null, usage, id = generateMessageId()) {
  return {
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content,
      stop_reason: stopReason,
      ...usage ? { usage } : {}
    }
  };
}
function createToolResultMessage(toolUseId, content) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content
        }
      ]
    }
  };
}
function createResultMessage(ok, durationMs, durationApiMs, numTurns, summary, sessionId, usage) {
  return {
    type: "result",
    subtype: ok ? "success" : "error",
    is_error: !ok,
    duration_ms: durationMs,
    duration_api_ms: durationApiMs,
    num_turns: numTurns,
    result: summary,
    session_id: sessionId,
    ...usage ? { usage } : {}
  };
}
function composePrompt(prompt, appendSystemPrompt) {
  if (!appendSystemPrompt?.trim()) {
    return prompt;
  }
  return [
    "<SYSTEM_INSTRUCTIONS>",
    appendSystemPrompt.trim(),
    "</SYSTEM_INSTRUCTIONS>",
    "",
    "<USER_REQUEST>",
    prompt,
    "</USER_REQUEST>"
  ].join("\n");
}
function classifyRuntimeError(error) {
  if (error instanceof IdleTimeoutError || error instanceof BusyStepTimeoutError) {
    return `Agent Error: ${error.message}`;
  }
  const message = toErrorMessage(error);
  if (/rate limit|authentication|not supported|invalid model|insufficient|quota|api|unsupported/i.test(
    message
  )) {
    return `API Error: ${message}`;
  }
  return `Agent Error: ${message}`;
}
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}
function writeStartupError(message, debugDir) {
  DebugRecorder.logStartupError(debugDir, message);
  process.stderr.write(`${message}
`);
  process.exit(1);
}
function findVendoredCodexExe(npmPrefix) {
  const arch = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const pkgName = process.arch === "arm64" ? "@openai/codex-win32-arm64" : "@openai/codex-win32-x64";
  const tail = path6.join(...pkgName.split("/"), "vendor", arch, "codex", "codex.exe");
  const candidates = [
    path6.join(npmPrefix, "node_modules", tail),
    path6.join(npmPrefix, "node_modules", "@openai", "codex", "node_modules", tail)
  ];
  for (const candidate of candidates) {
    if (fs5.existsSync(candidate)) return candidate;
  }
  return null;
}
async function resolveCodexPath(command) {
  const isWindows = process.platform === "win32";
  if (path6.isAbsolute(command) || command.includes(path6.sep)) {
    if (fs5.existsSync(command)) return command;
    if (isWindows) {
      for (const ext of [".cmd", ".exe"]) {
        if (fs5.existsSync(command + ext)) return command + ext;
      }
    }
    return null;
  }
  const whichCommand = isWindows ? "where" : "which";
  const resolved = await new Promise((resolve) => {
    const proc = spawn2(whichCommand, [command], {
      shell: isWindows,
      stdio: ["ignore", "pipe", "ignore"],
      env: process.env
    });
    let stdout = "";
    proc.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.on("error", () => resolve(null));
    proc.on("close", (code) => {
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim().split(/\r?\n/)[0]);
      } else {
        resolve(null);
      }
    });
  });
  if (!resolved) return null;
  if (isWindows) {
    const npmPrefix = path6.dirname(resolved);
    const vendored = findVendoredCodexExe(npmPrefix);
    if (vendored) return vendored;
  }
  return resolved;
}
async function resolveAgentVersion(codexPath) {
  const isWindows = process.platform === "win32";
  return await new Promise((resolve) => {
    const proc = spawn2(codexPath, ["--version"], {
      shell: isWindows,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", () => resolve("unknown"));
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim() || stderr.trim() || package_default.dependencies["@openai/codex-sdk"] || "unknown");
      } else {
        resolve("unknown");
      }
    });
  });
}
async function runSelfTest() {
  const apiKeySource = detectApiKeySource();
  const override = getCodexPathOverride() || "codex";
  const resolvedPath = await resolveCodexPath(override);
  const agentFound = resolvedPath !== null;
  const agentVersion = resolvedPath ? await resolveAgentVersion(resolvedPath) : "unknown";
  const checks = [
    {
      name: "agent_found",
      passed: agentFound,
      message: agentFound ? `Found codex at ${resolvedPath}` : `Could not find codex via ${override}`
    },
    {
      name: "api_key",
      passed: apiKeySource !== "none",
      message: apiKeySource !== "none" ? `Authentication source available: ${apiKeySource}` : "No OPENAI_API_KEY, CODEX_API_KEY, or ~/.codex/auth.json found"
    }
  ];
  const overallPassed = checks.every((check) => check.passed);
  process.stdout.write(
    `${JSON.stringify(
      {
        shim: { name: "codex-shim", version: package_default.version },
        agent: { name: "codex", version: agentVersion, found: agentFound },
        checks,
        overall: {
          passed: overallPassed,
          message: overallPassed ? "All checks passed" : "One or more checks failed"
        }
      },
      null,
      2
    )}
`
  );
  return overallPassed ? 0 : 1;
}
var CodexShim = class {
  args;
  prompt;
  cwd;
  debug;
  model;
  sessionManager;
  runtime = {
    numTurns: 0,
    finalText: ""
  };
  toolIdMap = /* @__PURE__ */ new Map();
  codex;
  sessionId;
  interrupted = false;
  currentAbortController;
  constructor(args, prompt) {
    this.args = args;
    this.prompt = prompt;
    this.cwd = makeAbsoluteCwd(process.cwd());
    this.debug = new DebugRecorder(args.debugDir);
    this.model = resolveModel(this.args.model);
    this.sessionManager = new SessionManager({ debugDir: args.debugDir });
    this.sessionId = args.resume || generateSessionId();
  }
  async run() {
    const codexPath = await resolveCodexPath(getCodexPathOverride() || "codex");
    if (!codexPath) {
      writeStartupError("Agent not found: could not locate codex via CODEX_PATH_OVERRIDE or PATH", this.args.debugDir);
    }
    if (!hasAnyAuthConfigured()) {
      writeStartupError("Missing API key: set OPENAI_API_KEY, CODEX_API_KEY, or ~/.codex/auth.json", this.args.debugDir);
    }
    this.codex = new Codex({
      apiKey: process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY,
      codexPathOverride: codexPath,
      env: Object.fromEntries(
        Object.entries(process.env).filter((entry) => entry[1] !== void 0)
      )
    });
    let thread;
    if (this.args.resume) {
      if (!isValidSessionId(this.args.resume)) {
        writeStartupError(`Invalid session ID: ${this.args.resume}`, this.args.debugDir);
      }
      let sessionData;
      try {
        sessionData = this.sessionManager.loadSession(this.args.resume);
      } catch (error) {
        writeStartupError(toErrorMessage(error), this.args.debugDir);
      }
      this.logVerbose(`Resuming session ${this.args.resume} -> ${sessionData.agentSessionId}`);
      thread = this.codex.resumeThread(sessionData.agentSessionId, this.getThreadOptions());
      this.sessionId = this.args.resume;
    } else {
      thread = this.codex.startThread(this.getThreadOptions());
    }
    const systemMessage = createSystemMessage(this.cwd, this.sessionId, this.model.publicModel);
    emit(systemMessage);
    this.debug.setSession(this.sessionId, { cwd: this.cwd, model: this.model.publicModel });
    const startedAt = Date.now();
    const apiStartedAt = Date.now();
    this.installSignalHandlers();
    try {
      const prompt = composePrompt(this.prompt, this.args.appendSystemPrompt);
      const stream = await thread.runStreamed(prompt, { signal: this.getAbortController().signal });
      await this.consumeEvents(stream.events);
      const durationMs = Date.now() - startedAt;
      const durationApiMs = Date.now() - apiStartedAt;
      const resultMessage = createResultMessage(
        true,
        durationMs,
        durationApiMs,
        Math.max(this.runtime.numTurns, 1),
        this.runtime.finalText || "Completed successfully.",
        this.sessionId,
        this.runtime.lastUsage
      );
      emit(resultMessage);
      this.debug.logResult("success", {
        session_id: this.sessionId,
        usage: this.runtime.lastUsage
      });
      await flushStdout();
      return 0;
    } catch (error) {
      const summary = classifyRuntimeError(error);
      const durationMs = Date.now() - startedAt;
      const durationApiMs = Date.now() - apiStartedAt;
      emit(
        createAssistantMessage(
          "<synthetic>",
          [{ type: "text", text: summary }],
          null,
          void 0,
          NIL_UUID
        )
      );
      const resultMessage = createResultMessage(
        false,
        durationMs,
        durationApiMs,
        Math.max(this.runtime.numTurns, 1),
        summary,
        this.sessionId,
        this.runtime.lastUsage
      );
      emit(resultMessage);
      this.debug.logLine(summary);
      this.debug.logResult("error", {
        session_id: this.sessionId,
        error: summary
      });
      await flushStdout();
      return 1;
    }
  }
  getThreadOptions() {
    return {
      model: this.model.sdkModel,
      modelReasoningEffort: this.model.reasoningEffort,
      sandboxMode: mapSandbox(this.args.sandbox),
      workingDirectory: this.cwd,
      skipGitRepoCheck: true,
      approvalPolicy: "never"
    };
  }
  async consumeEvents(events) {
    const idleTimeoutMs = this.args.idleTimeout * 1e3;
    const timedEvents = withAdaptiveTimeout(events, {
      idleTimeoutMs,
      busyTimeoutMs: Math.max(idleTimeoutMs, 3e5),
      onEvent: (event, controller) => {
        updateCodexTimeoutState(event, controller, idleTimeoutMs);
      }
    });
    for await (const event of timedEvents) {
      this.debug.logSdkEvent(event);
      this.logVerbose(`SDK event: ${event.type}`);
      await this.handleEvent(event);
    }
  }
  async handleEvent(event) {
    switch (event.type) {
      case "thread.started": {
        this.sessionManager.saveSession({
          sessionId: this.sessionId,
          agentSessionId: event.thread_id,
          timestamp: (/* @__PURE__ */ new Date()).toISOString(),
          metadata: {
            model: this.model.publicModel,
            cwd: this.cwd
          }
        });
        break;
      }
      case "turn.started": {
        break;
      }
      case "turn.completed": {
        this.runtime.numTurns += 1;
        this.runtime.lastUsage = usageToTokenUsage(event.usage);
        break;
      }
      case "turn.failed": {
        this.runtime.numTurns += 1;
        throw new Error(event.error.message);
      }
      case "error": {
        throw new Error(event.message);
      }
      case "item.started": {
        await this.emitToolUseIfNeeded(event.item);
        break;
      }
      case "item.updated": {
        await this.emitToolUseIfNeeded(event.item);
        break;
      }
      case "item.completed": {
        await this.handleCompletedItem(event.item);
        break;
      }
      default:
        break;
    }
  }
  async handleCompletedItem(item) {
    if (item.type === "reasoning") {
      emit(
        createAssistantMessage(this.model.publicModel, [
          {
            type: "thinking",
            thinking: item.text
          }
        ])
      );
      return;
    }
    if (item.type === "agent_message") {
      this.runtime.finalText = item.text;
      emit(
        createAssistantMessage(this.model.publicModel, [
          {
            type: "text",
            text: item.text
          }
        ], "end_turn")
      );
      return;
    }
    if (item.type === "error") {
      throw new Error(item.message);
    }
    if (shouldTreatAsToolItem(item)) {
      const toolId = await this.emitToolUseIfNeeded(item);
      const normalizedResult = normalizeToolResult(item, this.cwd);
      if (!toolId || !normalizedResult) {
        return;
      }
      emit(createToolResultMessage(toolId, normalizedResult.content));
    }
  }
  async emitToolUseIfNeeded(item) {
    if (!shouldTreatAsToolItem(item)) {
      return void 0;
    }
    const existing = this.toolIdMap.get(item.id);
    if (existing) {
      return existing;
    }
    const normalizedTool = normalizeToolUse(item, this.cwd);
    if (!normalizedTool) {
      return void 0;
    }
    const publicId = generateToolUseId();
    this.toolIdMap.set(item.id, publicId);
    emit(
      createAssistantMessage(this.model.publicModel, [
        {
          type: "tool_use",
          id: publicId,
          name: normalizedTool.name,
          ...normalizedTool.input ? { input: normalizedTool.input } : {}
        }
      ], "tool_use")
    );
    return publicId;
  }
  getAbortController() {
    if (!this.currentAbortController) {
      this.currentAbortController = new AbortController();
    }
    return this.currentAbortController;
  }
  installSignalHandlers() {
    const handle = (signal) => {
      if (this.interrupted) {
        return;
      }
      this.interrupted = true;
      this.logVerbose(`Received ${signal}, aborting current turn`);
      this.debug.logLine(`Received ${signal}, aborting current turn`);
      this.currentAbortController?.abort();
    };
    process.once("SIGINT", () => handle("SIGINT"));
    process.once("SIGTERM", () => handle("SIGTERM"));
  }
  logVerbose(message) {
    if (!this.args.verbose) {
      return;
    }
    process.stderr.write(`${message}
`);
    this.debug.logLine(message);
  }
};
async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, { "-h": "--help" });
  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if (args.version) {
    process.stdout.write(`${package_default.version}
`);
    return 0;
  }
  if (args.selfTest) {
    return await runSelfTest();
  }
  const prompt = await readStdin();
  if (!prompt) {
    return 0;
  }
  const shim = new CodexShim(args, prompt);
  return await shim.run();
}
async function runCli() {
  try {
    const exitCode = await main();
    await flushStdout();
    process.exit(exitCode);
  } catch (error) {
    const message = toErrorMessage(error);
    process.stderr.write(`${message}
`);
    await flushStdout();
    process.exit(1);
  }
}

// src/index.ts
await runCli();
