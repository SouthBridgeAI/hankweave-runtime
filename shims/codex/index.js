#!/usr/bin/env node

// src/selftest.ts
import { spawn } from "child_process";
import { existsSync as existsSync2 } from "fs";
import { isAbsolute } from "path";

// src/utils/auth.ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
function getAuthFilePath() {
  const homeDir = os.homedir();
  return path.join(homeDir, ".codex", "auth.json");
}
function readAuthFile() {
  try {
    const authPath = getAuthFilePath();
    if (!fs.existsSync(authPath)) {
      return null;
    }
    return fs.readFileSync(authPath, "utf8");
  } catch {
    return null;
  }
}
function getApiKey() {
  const authFileKey = readAuthFile();
  if (authFileKey) {
    return { apiKey: authFileKey, source: "env" };
  }
  if (process.env.CODEX_API_KEY) {
    return { apiKey: process.env.CODEX_API_KEY, source: "CODEX_API_KEY" };
  }
  if (process.env.OPENAI_API_KEY) {
    return { apiKey: process.env.OPENAI_API_KEY, source: "OPENAI_API_KEY" };
  }
  return { apiKey: null, source: "none" };
}

// src/selftest.ts
async function isCodexInstalled() {
  return new Promise((resolve) => {
    const isWindows = process.platform === "win32";
    const codexCommand = process.env.CODEX_PATH_OVERRIDE || "codex";
    if (isAbsolute(codexCommand)) {
      if (existsSync2(codexCommand)) {
        const versionProc = spawn(codexCommand, ["--version"], { shell: isWindows });
        let version = "unknown";
        versionProc.stdout.on("data", (data) => {
          version = data.toString().trim();
        });
        versionProc.on("close", () => {
          resolve({ found: true, version });
        });
      } else {
        resolve({ found: false, version: "N/A" });
      }
      return;
    }
    const whichCommand = isWindows ? "where" : "which";
    const proc = spawn(whichCommand, [codexCommand], { shell: isWindows });
    let found = false;
    proc.on("close", (code) => {
      if (code === 0) {
        found = true;
      }
      if (found) {
        const versionProc = spawn(codexCommand, ["--version"], { shell: isWindows });
        let version = "unknown";
        versionProc.stdout.on("data", (data) => {
          version = data.toString().trim();
        });
        versionProc.on("close", () => {
          resolve({ found: true, version });
        });
      } else {
        resolve({ found: false, version: "N/A" });
      }
    });
  });
}
function checkApiKey() {
  const authConfig = getApiKey();
  if (authConfig.apiKey) {
    const sourceMessages = {
      env: "API key found in ~/.codex/auth.json",
      CODEX_API_KEY: "CODEX_API_KEY found in environment",
      OPENAI_API_KEY: "OPENAI_API_KEY found in environment",
      none: "No API key found"
    };
    return {
      passed: true,
      message: sourceMessages[authConfig.source] || "API key found"
    };
  } else {
    return {
      passed: false,
      message: "No API key found. Set CODEX_API_KEY or OPENAI_API_KEY environment variable, or create ~/.codex/auth.json with apiKey field."
    };
  }
}
async function runSelfTest() {
  const checks = [];
  const codexStatus = await isCodexInstalled();
  checks.push({
    name: "codex_cli_found",
    passed: codexStatus.found,
    message: codexStatus.found ? `Codex CLI found (version: ${codexStatus.version})` : "Codex CLI not found in PATH. Install from https://developers.openai.com/codex/"
  });
  const apiKeyStatus = checkApiKey();
  checks.push({
    name: "api_key",
    passed: apiKeyStatus.passed,
    message: apiKeyStatus.message
  });
  const nodeVersion = process.version;
  const majorVersion = parseInt(nodeVersion.slice(1).split(".")[0]);
  const nodeVersionOk = majorVersion >= 18;
  checks.push({
    name: "node_version",
    passed: nodeVersionOk,
    message: nodeVersionOk ? `Node.js version ${nodeVersion} is compatible` : `Node.js version ${nodeVersion} is too old. Requires Node.js 18+`
  });
  const allPassed = checks.every((c) => c.passed);
  return {
    shim: {
      name: "codex-shim",
      version: "1.0.0"
    },
    agent: {
      name: "Codex",
      version: codexStatus.version,
      found: codexStatus.found
    },
    checks,
    overall: {
      passed: allPassed,
      message: allPassed ? "All checks passed" : "Some checks failed"
    }
  };
}

// src/shim.ts
import * as fs4 from "fs";
import * as path4 from "path";

// ../../node_modules/.bun/@openai+codex-sdk@0.81.0/node_modules/@openai/codex-sdk/dist/index.js
import { promises as fs2 } from "fs";
import os2 from "os";
import path2 from "path";
import { spawn as spawn2 } from "child_process";
import path22 from "path";
import readline from "readline";
import { fileURLToPath } from "url";
async function createOutputSchemaFile(schema) {
  if (schema === void 0) {
    return { cleanup: async () => {
    } };
  }
  if (!isJsonObject(schema)) {
    throw new Error("outputSchema must be a plain JSON object");
  }
  const schemaDir = await fs2.mkdtemp(path2.join(os2.tmpdir(), "codex-output-schema-"));
  const schemaPath = path2.join(schemaDir, "schema.json");
  const cleanup = async () => {
    try {
      await fs2.rm(schemaDir, { recursive: true, force: true });
    } catch {
    }
  };
  try {
    await fs2.writeFile(schemaPath, JSON.stringify(schema), "utf8");
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
var CodexExec = class {
  executablePath;
  envOverride;
  constructor(executablePath = null, env) {
    this.executablePath = executablePath || findCodexPath();
    this.envOverride = env;
  }
  async *run(args) {
    const commandArgs = ["exec", "--experimental-json"];
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
    if (args.webSearchEnabled !== void 0) {
      commandArgs.push("--config", `features.web_search_request=${args.webSearchEnabled}`);
    }
    if (args.approvalPolicy) {
      commandArgs.push("--config", `approval_policy="${args.approvalPolicy}"`);
    }
    if (args.images?.length) {
      for (const image of args.images) {
        commandArgs.push("--image", image);
      }
    }
    if (args.threadId) {
      commandArgs.push("resume", args.threadId);
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
    const child = spawn2(this.executablePath, commandArgs, {
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
var scriptFileName = fileURLToPath(import.meta.url);
var scriptDirName = path22.dirname(scriptFileName);
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
  const vendorRoot = path22.join(scriptDirName, "..", "vendor");
  const archRoot = path22.join(vendorRoot, targetTriple);
  const codexBinaryName = process.platform === "win32" ? "codex.exe" : "codex";
  const binaryPath = path22.join(archRoot, "codex", codexBinaryName);
  return binaryPath;
}
var Codex = class {
  exec;
  options;
  constructor(options = {}) {
    this.exec = new CodexExec(options.codexPathOverride, options.env);
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

// ../common/src/sessions.ts
import { randomUUID } from "crypto";
import fs3 from "fs";
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
    fs3.mkdirSync(this.sessionsDir, { recursive: true });
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
    const sessionPath = path3.join(this.sessionsDir, `${data.sessionId}.json`);
    fs3.writeFileSync(sessionPath, JSON.stringify(data, null, 2), "utf8");
  }
  /**
   * Load session data by session ID
   * @throws Error if session not found
   */
  loadSession(sessionId) {
    const sessionPath = path3.join(this.sessionsDir, `${sessionId}.json`);
    try {
      const content = fs3.readFileSync(sessionPath, "utf8");
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
    return fs3.existsSync(sessionPath);
  }
  /**
   * Delete session data
   */
  deleteSession(sessionId) {
    const sessionPath = path3.join(this.sessionsDir, `${sessionId}.json`);
    try {
      fs3.unlinkSync(sessionPath);
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
      const files = fs3.readdirSync(this.sessionsDir);
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
};

// src/utils/ids.ts
function generateMessageId() {
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 10)}`;
}
function generateToolUseId() {
  return `toolu_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 12)}`;
}
var NIL_UUID = "00000000-0000-0000-0000-000000000000";

// src/utils/models.ts
var MODEL_SHORTNAMES = {
  codex: "openai/gpt-5.1-codex-max",
  "codex-max": "openai/gpt-5.1-codex-max",
  "o4-mini": "openai/o4-mini"
};
var VALID_REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
];
function isValidReasoningEffort(value) {
  return VALID_REASONING_EFFORTS.includes(value);
}
function resolveModel(input) {
  let modelInput = input;
  let reasoningEffort;
  const lastHyphenIndex = input.lastIndexOf("-");
  if (lastHyphenIndex !== -1) {
    const potentialEffort = input.substring(lastHyphenIndex + 1);
    const baseModel = input.substring(0, lastHyphenIndex);
    if (isValidReasoningEffort(potentialEffort)) {
      modelInput = baseModel;
      reasoningEffort = potentialEffort;
    }
  }
  const fullModel = MODEL_SHORTNAMES[modelInput.toLowerCase()] || modelInput;
  if (fullModel.includes("/")) {
    const [providerID, modelID] = fullModel.split("/", 2);
    return { providerID, modelID, reasoningEffort };
  }
  return {
    providerID: "openai",
    modelID: fullModel,
    reasoningEffort
  };
}
function formatModelOutput(spec) {
  return `${spec.providerID}/${spec.modelID}`;
}
function getCodexModelId(spec) {
  return spec.modelID;
}

// src/utils/output.ts
function emit(message) {
  console.log(JSON.stringify(message));
}
function verboseLog(verbose, ...args) {
  if (verbose) {
    console.error("[codex-shim]", ...args);
  }
}
async function flushStdout() {
  return new Promise((resolve) => {
    const written = process.stdout.write("");
    if (written) {
      resolve();
    } else {
      process.stdout.once("drain", resolve);
    }
  });
}

// src/utils/tools.ts
var STANDARD_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "LS"];
function normalizeToolName(name) {
  const lowerName = name.toLowerCase();
  const toolMap = {
    read: "Read",
    file_read: "Read",
    readfile: "Read",
    read_text_file: "Read",
    write: "Write",
    file_write: "Write",
    writefile: "Write",
    write_text_file: "Write",
    edit: "Edit",
    str_replace_editor: "Edit",
    edit_text_file: "Edit",
    bash: "Bash",
    shell: "Bash",
    execute_bash: "Bash",
    exec: "Bash",
    glob: "Glob",
    find_files: "Glob",
    grep: "Grep",
    search_files: "Grep",
    ls: "LS",
    list: "LS",
    list_directory: "LS"
  };
  return toolMap[lowerName] || name;
}
function camelToSnake(str) {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
function normalizeToolInput(input) {
  const normalized = {};
  for (const [key, value] of Object.entries(input)) {
    normalized[camelToSnake(key)] = value;
  }
  return normalized;
}

// src/shim.ts
var CodexShim = class {
  args;
  codex;
  cwd;
  startTime;
  apiStartTime;
  interrupted = false;
  sessionManager;
  authConfig;
  constructor(args) {
    this.args = args;
    this.cwd = process.cwd();
    this.startTime = Date.now();
    this.apiStartTime = 0;
    this.sessionManager = new SessionManager({ debugDir: args.debugDir });
    this.authConfig = getApiKey();
    this.codex = new Codex({
      apiKey: this.authConfig.source !== "env" && this.authConfig.apiKey ? this.authConfig.apiKey : void 0,
      env: process.env,
      // Use system-installed codex instead of vendored binary
      codexPathOverride: process.env.CODEX_PATH_OVERRIDE || "codex"
    });
    this.setupSignalHandlers();
  }
  setupSignalHandlers() {
    const handleSignal = () => {
      if (!this.interrupted) {
        this.interrupted = true;
        verboseLog(this.args.verbose, "Received interrupt signal, shutting down gracefully");
        process.exit(0);
      }
    };
    process.on("SIGINT", handleSignal);
    process.on("SIGTERM", handleSignal);
  }
  async run(prompt) {
    const modelSpec = resolveModel(this.args.model);
    const modelOutput = formatModelOutput(modelSpec);
    const codexModelId = getCodexModelId(modelSpec);
    verboseLog(this.args.verbose, `Resolved model: ${modelOutput}`);
    verboseLog(this.args.verbose, `Codex model ID: ${codexModelId}`);
    let thread;
    let sessionId = null;
    try {
      if (this.args.resume) {
        const resumeSessionId = this.args.resume;
        verboseLog(this.args.verbose, `Resuming session: ${resumeSessionId}`);
        const sessionData = this.sessionManager.loadSession(resumeSessionId);
        const threadId = sessionData.agentSessionId;
        verboseLog(
          this.args.verbose,
          `Found thread ID: ${threadId} for session: ${resumeSessionId}`
        );
        const home = process.env.HOME || process.env.USERPROFILE || "";
        const codexSessionDir = path4.join(home, ".codex", "sessions");
        let threadExists = false;
        try {
          const { spawnSync } = await import("child_process");
          const result = spawnSync("find", [codexSessionDir, "-name", `*${threadId}*`], {
            encoding: "utf8"
          });
          threadExists = result.stdout.trim().length > 0 && result.status === 0;
        } catch (error) {
          verboseLog(this.args.verbose, `Thread validation error: ${error}`);
        }
        if (!threadExists) {
          throw new Error(
            `Thread not found for session ${resumeSessionId}. Cannot resume non-existent conversation.`
          );
        }
        thread = this.codex.resumeThread(threadId, this.getThreadOptions());
        sessionId = resumeSessionId;
      } else {
        verboseLog(this.args.verbose, `Starting new session`);
        sessionId = this.sessionManager.generateSessionId();
        thread = this.codex.startThread(this.getThreadOptions());
      }
    } catch (error) {
      verboseLog(this.args.verbose, "Pre-init error:", error);
      if (this.args.debugDir) {
        this.savePreInitError(error);
      }
      throw error;
    }
    if (!sessionId) {
      throw new Error("Failed to determine session ID");
    }
    const state = {
      sessionId,
      thread,
      startTime: this.startTime,
      apiStartTime: 0,
      numTurns: 0,
      totalUsage: {
        input_tokens: 0,
        output_tokens: 0
      },
      workStarted: false,
      hasReceivedDeltas: false,
      emittedToolIds: /* @__PURE__ */ new Set(),
      toolIdMapping: /* @__PURE__ */ new Map()
    };
    try {
      await this.processPrompt(state, prompt, modelOutput);
      this.emitResult(state, false, "Completed successfully");
    } catch (error) {
      verboseLog(this.args.verbose, "Error during execution:", error);
      if (this.args.debugDir) {
        this.saveRuntimeError(state.sessionId, error);
      }
      this.emitSyntheticError(error, modelOutput);
      this.emitResult(state, true, error instanceof Error ? error.message : String(error));
      await flushStdout();
      process.exit(1);
    }
    await flushStdout();
    process.exit(0);
  }
  getThreadOptions() {
    const modelSpec = resolveModel(this.args.model);
    const options = {
      workingDirectory: this.cwd,
      skipGitRepoCheck: true,
      model: getCodexModelId(modelSpec),
      // Auto-approve all operations (no user present)
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      networkAccessEnabled: true,
      webSearchEnabled: true,
      ...modelSpec.reasoningEffort && { modelReasoningEffort: modelSpec.reasoningEffort }
    };
    return options;
  }
  emitSystemInit(sessionId, model) {
    let apiKeySource;
    switch (this.authConfig.source) {
      case "env":
      case "CODEX_API_KEY":
      case "OPENAI_API_KEY":
        apiKeySource = "env";
        break;
      default:
        apiKeySource = "none";
    }
    const message = {
      type: "system",
      subtype: "init",
      cwd: this.cwd,
      session_id: sessionId,
      tools: [...STANDARD_TOOLS],
      model,
      permissionMode: "bypassPermissions",
      apiKeySource,
      mcp_servers: []
    };
    emit(message);
    verboseLog(this.args.verbose, "Emitted system init");
  }
  async processPrompt(state, prompt, model) {
    let finalPrompt = prompt;
    if (this.args.appendSystemPrompt) {
      finalPrompt = `${prompt}

${this.args.appendSystemPrompt}`;
    }
    verboseLog(this.args.verbose, `Sending prompt: ${finalPrompt.substring(0, 100)}...`);
    state.apiStartTime = Date.now();
    this.apiStartTime = state.apiStartTime;
    const { events } = await state.thread.runStreamed(finalPrompt);
    const currentMessageContent = [];
    const currentMessageId = generateMessageId();
    const pendingToolResults = /* @__PURE__ */ new Map();
    let systemInitEmitted = false;
    for await (const event of events) {
      if (this.interrupted) {
        verboseLog(this.args.verbose, "Interrupted, stopping event processing");
        break;
      }
      verboseLog(this.args.verbose, `Event: ${event.type}`);
      if (this.args.debugDir && state.sessionId) {
        this.saveRawEvent(state.sessionId, event);
        if (event.type === "thread.started") {
          this.createRawLogFile(state.sessionId);
        }
      }
      if (!state.workStarted) {
        if (event.type === "item.started" || event.type === "item.updated" || event.type === "turn.started") {
          state.workStarted = true;
        }
      }
      switch (event.type) {
        case "thread.started":
          if (event.thread_id) {
            verboseLog(this.args.verbose, `Thread started with Codex ID: ${event.thread_id}`);
            verboseLog(this.args.verbose, `Using session ID: ${state.sessionId}`);
            if (!systemInitEmitted) {
              this.emitSystemInit(state.sessionId, model);
              systemInitEmitted = true;
            }
          }
          break;
        case "turn.started":
          state.numTurns++;
          verboseLog(this.args.verbose, `Turn ${state.numTurns} started`);
          break;
        case "item.started":
        case "item.updated":
        case "item.completed":
          this.handleItemEvent(
            event.item,
            state,
            currentMessageContent,
            pendingToolResults,
            model,
            event.type === "item.completed"
          );
          break;
        case "turn.completed":
          if (event.usage) {
            state.totalUsage.input_tokens += event.usage.input_tokens;
            state.totalUsage.output_tokens += event.usage.output_tokens;
            if (event.usage.cached_input_tokens) {
              state.totalUsage.cache_read_input_tokens = (state.totalUsage.cache_read_input_tokens || 0) + event.usage.cached_input_tokens;
            }
          }
          verboseLog(this.args.verbose, "Turn completed", event.usage);
          if (currentMessageContent.length > 0) {
            this.emitAssistantMessage(
              currentMessageId,
              model,
              currentMessageContent,
              event.usage,
              "end_turn"
            );
          }
          for (const result of pendingToolResults.values()) {
            this.emitToolResult(result);
          }
          pendingToolResults.clear();
          break;
        case "turn.failed":
          verboseLog(this.args.verbose, "Turn failed:", event.error);
          if (this.args.debugDir) {
            this.saveRuntimeError(
              state.sessionId,
              new Error(`Turn failed: ${event.error.message}`)
            );
          }
          throw new Error(`Turn failed: ${event.error.message}`);
        case "error":
          verboseLog(this.args.verbose, `Thread error: ${event.message}`);
          if (this.args.debugDir) {
            this.saveRuntimeError(state.sessionId, new Error(`Thread error: ${event.message}`));
          }
          break;
      }
    }
    if (state.thread.id) {
      this.saveSession(state.thread.id, state);
    }
    if (this.args.debugDir) {
      this.createRawLogFile(state.sessionId);
    }
  }
  handleItemEvent(item, state, currentMessageContent, pendingToolResults, _model, _isCompleted = false) {
    switch (item.type) {
      case "agent_message":
        if (item.text && !state.hasReceivedDeltas) {
          const existing = currentMessageContent.find((c) => c.type === "text");
          if (existing && existing.type === "text") {
            existing.text = item.text;
          } else {
            currentMessageContent.push({ type: "text", text: item.text });
          }
        }
        break;
      case "reasoning":
        if (item.text) {
          currentMessageContent.push({ type: "thinking", thinking: item.text });
        }
        break;
      case "command_execution":
        this.handleCommandExecution(item, state, currentMessageContent, pendingToolResults);
        break;
      case "mcp_tool_call":
        this.handleMcpToolCall(item, state, currentMessageContent, pendingToolResults);
        break;
      case "file_change":
        this.handleFileChange(item, state, currentMessageContent, pendingToolResults);
        break;
    }
  }
  handleCommandExecution(item, state, currentMessageContent, pendingToolResults) {
    if (!state.emittedToolIds.has(item.id)) {
      const toolUseId2 = generateToolUseId();
      state.emittedToolIds.add(item.id);
      state.toolIdMapping.set(item.id, toolUseId2);
      currentMessageContent.push({
        type: "tool_use",
        id: toolUseId2,
        name: "Bash",
        input: { command: item.command }
      });
    }
    const toolUseId = state.toolIdMapping.get(item.id);
    if (!toolUseId) return;
    let content = item.aggregated_output || "";
    if (!content && item.status === "completed" && item.exit_code === 0) {
      content = `Command executed successfully (exit code: 0)`;
    } else if (!content && item.status === "failed") {
      content = `Command failed (exit code: ${item.exit_code || "unknown"})`;
    }
    pendingToolResults.set(item.id, {
      type: "tool_result",
      tool_use_id: toolUseId,
      content: item.status === "failed" ? { is_error: true, error: content } : content
    });
  }
  handleMcpToolCall(item, state, currentMessageContent, pendingToolResults) {
    if (!state.emittedToolIds.has(item.id)) {
      const toolUseId2 = generateToolUseId();
      state.emittedToolIds.add(item.id);
      state.toolIdMapping.set(item.id, toolUseId2);
      const toolName = normalizeToolName(item.tool);
      currentMessageContent.push({
        type: "tool_use",
        id: toolUseId2,
        name: toolName,
        input: normalizeToolInput(item.arguments || {})
      });
    }
    const toolUseId = state.toolIdMapping.get(item.id);
    if (!toolUseId) return;
    let content = "";
    if (item.result?.content) {
      content = item.result.content.map((block) => {
        if (block.type === "text") return block.text;
        return JSON.stringify(block);
      }).join("\n");
    }
    pendingToolResults.set(item.id, {
      type: "tool_result",
      tool_use_id: toolUseId,
      content: item.status === "failed" ? { is_error: true, error: item.error?.message || "Failed" } : content
    });
  }
  handleFileChange(item, state, currentMessageContent, pendingToolResults) {
    if (!state.emittedToolIds.has(item.id)) {
      const toolUseId2 = generateToolUseId();
      state.emittedToolIds.add(item.id);
      state.toolIdMapping.set(item.id, toolUseId2);
      const change2 = item.changes[0];
      const toolName = change2.kind === "add" ? "Write" : "Edit";
      currentMessageContent.push({
        type: "tool_use",
        id: toolUseId2,
        name: toolName,
        input: { file_path: change2.path }
      });
    }
    const toolUseId = state.toolIdMapping.get(item.id);
    if (!toolUseId) return;
    const change = item.changes[0];
    const content = `${change.kind}: ${change.path}`;
    pendingToolResults.set(item.id, {
      type: "tool_result",
      tool_use_id: toolUseId,
      content: item.status === "failed" ? { is_error: true, error: "File change failed" } : content
    });
  }
  emitAssistantMessage(messageId, model, content, usage, stopReason) {
    const message = {
      type: "assistant",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model,
        content,
        usage: usage ? {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cache_read_input_tokens: usage.cached_input_tokens
        } : void 0,
        stop_reason: stopReason || null
      }
    };
    emit(message);
    verboseLog(this.args.verbose, "Emitted assistant message");
  }
  emitToolResult(result) {
    const message = {
      type: "user",
      message: {
        role: "user",
        content: [result]
      }
    };
    emit(message);
    verboseLog(this.args.verbose, "Emitted tool result");
  }
  emitSyntheticError(error, _model) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const message = {
      type: "assistant",
      message: {
        id: NIL_UUID,
        type: "message",
        role: "assistant",
        model: "<synthetic>",
        content: [
          {
            type: "text",
            text: `API Error: ${errorMessage}`
          }
        ],
        stop_reason: null
      }
    };
    emit(message);
    verboseLog(this.args.verbose, "Emitted synthetic error");
  }
  emitResult(state, isError, result) {
    const duration = Date.now() - state.startTime;
    const apiDuration = state.apiStartTime > 0 ? Date.now() - state.apiStartTime : 0;
    const message = {
      type: "result",
      subtype: isError ? "error" : "success",
      is_error: isError,
      duration_ms: duration,
      duration_api_ms: apiDuration,
      num_turns: state.numTurns,
      result,
      session_id: state.sessionId,
      usage: state.totalUsage
    };
    emit(message);
    verboseLog(this.args.verbose, "Emitted result");
  }
  saveSession(threadId, state) {
    try {
      const sessionData = {
        sessionId: state.sessionId,
        agentSessionId: threadId,
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        metadata: {
          totalUsage: state.totalUsage,
          numTurns: state.numTurns
        }
      };
      this.sessionManager.saveSession(sessionData);
      verboseLog(this.args.verbose, `Saved session to ${this.sessionManager.getSessionsDir()}`);
    } catch (error) {
      verboseLog(this.args.verbose, `Failed to save session: ${error}`);
    }
  }
  saveRawEvent(sessionId, event) {
    try {
      if (!this.args.debugDir) return;
      fs4.mkdirSync(this.args.debugDir, { recursive: true });
      const rawLogPath = path4.join(this.args.debugDir, `session-${sessionId}.raw.jsonl`);
      fs4.appendFileSync(rawLogPath, `${JSON.stringify(event)}
`);
      this.createRawLogFile(sessionId);
    } catch (error) {
      verboseLog(this.args.verbose, `Failed to save raw event: ${error}`);
    }
  }
  savePreInitError(error) {
    try {
      if (!this.args.debugDir) return;
      fs4.mkdirSync(this.args.debugDir, { recursive: true });
      const errorLogPath = path4.join(this.args.debugDir, "session-unknown.raw.log");
      const errorMessage = error instanceof Error ? error.message : String(error);
      const timestamp = (/* @__PURE__ */ new Date()).toISOString();
      fs4.appendFileSync(errorLogPath, `[${timestamp}] ${errorMessage}
`);
    } catch (err) {
      verboseLog(this.args.verbose, `Failed to save pre-init error: ${err}`);
    }
  }
  saveRuntimeError(sessionId, error) {
    try {
      if (!this.args.debugDir) return;
      fs4.mkdirSync(this.args.debugDir, { recursive: true });
      const errorLogPath = path4.join(this.args.debugDir, `session-${sessionId}.raw.log`);
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : void 0;
      const timestamp = (/* @__PURE__ */ new Date()).toISOString();
      let logEntry = `[${timestamp}] RUNTIME ERROR: ${errorMessage}
`;
      if (errorStack) {
        logEntry += `Stack trace:
${errorStack}
`;
      }
      fs4.appendFileSync(errorLogPath, logEntry);
    } catch (err) {
      verboseLog(this.args.verbose, `Failed to save runtime error: ${err}`);
    }
  }
  createRawLogFile(sessionId) {
    try {
      if (!this.args.debugDir) return;
      const rawLogPath = path4.join(this.args.debugDir, `session-${sessionId}.raw.log`);
      if (!fs4.existsSync(rawLogPath)) {
        fs4.writeFileSync(
          rawLogPath,
          `# Codex SDK raw log (session ${sessionId})
# Note: SDK doesn't expose agent stderr
`
        );
      }
    } catch (error) {
      verboseLog(this.args.verbose, `Failed to create raw log file: ${error}`);
    }
  }
};

// src/utils/args.ts
function parseArgs(argv) {
  const args = {
    model: "",
    verbose: false,
    selfTest: false,
    version: false,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.includes("=")) {
      const [key, value] = arg.split("=", 2);
      argv.splice(i, 1, key, value);
    }
    switch (arg) {
      case "--model":
        args.model = argv[++i];
        break;
      case "-p":
        args.prompt = "";
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
  if (!args.model && !args.selfTest && !args.version && !args.help) {
    args.model = process.env.MODEL || "codex";
  }
  return args;
}
async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      resolve(data.trim());
    });
    process.stdin.on("error", (err) => {
      reject(err);
    });
  });
}
function printVersion() {
  console.log("codex-shim 1.0.0");
}
function printHelp() {
  console.log(`
codex-shim - OpenAI Codex shim for standardized agent interface

USAGE:
  echo "prompt" | codex-shim --model <model>[-<reasoning>] [options]

REQUIRED:
  --model <model>           OpenAI model identifier (shortname, openai/model, or full ID)
                            Optionally append reasoning effort:
                            -minimal, -low, -medium, -high, or -xhigh

OPTIONS:
  -p                        Indicates prompt via stdin (optional, stdin always read)
  --resume <session_id>     Continue existing session
  --verbose                 Enable verbose logging to stderr
  --append-system-prompt    Additional system prompt to append
  --debug-dir <path>        Directory for debug logs and session data
  --self-test               Run environment verification
  --version                 Print version and exit
  --help                    Print this help and exit

ENVIRONMENT:
  MODEL                     Default model if --model not provided
  OPENAI_API_KEY            OpenAI API key for authentication
  CODEX_API_KEY             Codex-specific API key (alternative)

EXAMPLES:
  echo "Hello" | codex-shim --model codex
  echo "Complex task" | codex-shim --model codex-high --verbose
  echo "Fix bug" | codex-shim --model gpt-5.2-xhigh
  echo "Continue" | codex-shim --model codex --resume <session-id>
`);
}

// src/index.ts
async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.version) {
      printVersion();
      process.exit(0);
    }
    if (args.help) {
      printHelp();
      process.exit(0);
    }
    if (args.selfTest) {
      const result = await runSelfTest();
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.overall.passed ? 0 : 1);
    }
    if (!args.model) {
      console.error("Error: --model argument is required");
      process.exit(1);
    }
    const prompt = await readStdin();
    if (!prompt) {
      verboseLog(args.verbose, "Empty prompt, exiting silently");
      process.exit(0);
    }
    verboseLog(args.verbose, "Starting Codex shim");
    verboseLog(args.verbose, `Model: ${args.model}`);
    verboseLog(args.verbose, `Prompt length: ${prompt.length} characters`);
    if (args.resume) {
      verboseLog(args.verbose, `Resuming session: ${args.resume}`);
    }
    const shim = new CodexShim(args);
    await shim.run(prompt);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${errorMessage}`);
    process.exit(1);
  }
}
main();
