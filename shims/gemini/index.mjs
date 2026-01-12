#!/usr/bin/env node

// src/index.ts
import { readFileSync as readFileSync2 } from "fs";

// src/utils/args.ts
function parseArguments(argv) {
  const args = {
    model: "",
    verbose: false,
    selfTest: false,
    version: false,
    help: false
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.includes("=")) {
      const [key, value] = arg.split("=", 2);
      switch (key) {
        case "--model":
          args.model = value;
          break;
        case "--resume":
          args.resume = value;
          break;
        case "--append-system-prompt":
          args.appendSystemPrompt = value;
          break;
        case "--debug-dir":
          args.debugDir = value;
          break;
      }
      continue;
    }
    switch (arg) {
      case "--model":
      case "-m":
        if (i + 1 < argv.length) {
          args.model = argv[++i];
        }
        break;
      case "--resume":
      case "-r":
        if (i + 1 < argv.length) {
          args.resume = argv[++i];
        }
        break;
      case "--append-system-prompt":
        if (i + 1 < argv.length) {
          args.appendSystemPrompt = argv[++i];
        }
        break;
      case "--debug-dir":
        if (i + 1 < argv.length) {
          args.debugDir = argv[++i];
        }
        break;
      case "--verbose":
      case "-v":
        args.verbose = true;
        break;
      case "--self-test":
        args.selfTest = true;
        break;
      case "--version":
        args.version = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "-p":
        break;
      default:
        break;
    }
  }
  return args;
}
var MODEL_SHORTNAMES = {
  "sonnet": "anthropic/claude-sonnet-4-20250514",
  "haiku": "anthropic/claude-3-haiku",
  "opus": "anthropic/claude-opus-4-5-20251101",
  "flash": "google/gemini-2.0-flash",
  "pro": "google/gemini-2.0-pro"
};
function resolveModel(model) {
  if (!model) {
    const envModel = process.env.MODEL;
    if (envModel) {
      model = envModel;
    } else {
      model = "flash";
    }
  }
  if (MODEL_SHORTNAMES[model]) {
    const resolved = MODEL_SHORTNAMES[model];
    if (resolved.startsWith("google/")) {
      return resolved.replace("google/", "");
    }
    return resolved;
  }
  if (model.includes("/")) {
    const [provider, modelId] = model.split("/", 2);
    if (provider === "google") {
      return modelId;
    }
    return model;
  }
  return model;
}
function formatModelForOutput(model) {
  if (model.startsWith("anthropic/")) {
    return model.replace("anthropic/", "");
  }
  if (!model.includes("/") && (model.startsWith("gemini-") || model === "flash" || model === "pro")) {
    return `google/${model}`;
  }
  return model;
}

// src/agent/gemini.ts
import { spawn } from "child_process";
import { createInterface } from "readline";
var GeminiCLI = class {
  constructor(options) {
    this.options = options;
    this.verbose = options.verbose;
  }
  process = null;
  verbose;
  /**
   * Check if gemini CLI is installed
   */
  static async isInstalled() {
    return new Promise((resolve2) => {
      const proc = spawn("which", ["gemini"]);
      let path = "";
      proc.stdout?.on("data", (data) => {
        path += data.toString();
      });
      proc.on("close", (code) => {
        if (code === 0 && path.trim()) {
          const versionProc = spawn("gemini", ["--version"]);
          let version = "";
          versionProc.stdout?.on("data", (data) => {
            version += data.toString();
          });
          versionProc.on("close", () => {
            resolve2({
              found: true,
              path: path.trim(),
              version: version.trim()
            });
          });
        } else {
          resolve2({ found: false });
        }
      });
    });
  }
  /**
   * Spawn Gemini CLI process
   */
  async spawn(prompt) {
    const args = [
      "--model",
      this.options.model,
      "--output-format",
      "stream-json",
      "--yolo"
      // Auto-approve all tools (bypass permissions)
    ];
    if (this.options.resume) {
      args.push("--resume", this.options.resume);
    }
    if (this.verbose) {
      console.error("[gemini-cli-shim] Spawning gemini:", args.join(" "));
    }
    this.process = spawn("gemini", args, {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env
      }
    });
    const fullPrompt = this.options.appendSystemPrompt ? `${prompt}

Additional instructions: ${this.options.appendSystemPrompt}` : prompt;
    this.process.stdin?.write(fullPrompt);
    this.process.stdin?.end();
    return this.createEventStream();
  }
  /**
   * Create async iterable from Gemini CLI stdout
   */
  async *createEventStream() {
    if (!this.process || !this.process.stdout || !this.process.stderr) {
      throw new Error("Process not spawned");
    }
    let stderrData = "";
    let hasSessionError = false;
    let sessionErrorDetected = false;
    this.process.stderr.on("data", (data) => {
      const text = data.toString();
      stderrData += text;
      if (!sessionErrorDetected && (text.includes("Error resuming session:") || text.includes("Invalid session identifier"))) {
        hasSessionError = true;
        sessionErrorDetected = true;
        if (this.verbose) {
          console.error("[gemini-cli-shim] Session error detected, killing process");
        }
        if (this.process) {
          this.process.kill("SIGKILL");
        }
      }
      if (this.verbose) {
        console.error("[gemini stderr]", text);
      }
    });
    const rl = createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity
    });
    if (hasSessionError) {
      throw new Error("Invalid session ID");
    }
    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (hasSessionError) {
          throw new Error("Invalid session ID");
        }
        if (!trimmed) {
          continue;
        }
        try {
          const event = JSON.parse(trimmed);
          if (this.verbose) {
            console.error("[gemini event]", JSON.stringify(event));
          }
          yield event;
        } catch (err) {
          if (this.verbose) {
            console.error("[gemini-cli-shim] Failed to parse line:", trimmed);
            console.error("[gemini-cli-shim] Error:", err);
          }
        }
      }
    } catch (err) {
      if (hasSessionError) {
        throw new Error("Invalid session ID");
      }
      throw err;
    }
    if (hasSessionError) {
      throw new Error("Invalid session ID");
    }
    await new Promise((resolve2, reject) => {
      if (!this.process) {
        if (hasSessionError) {
          reject(new Error("Invalid session ID"));
        } else {
          resolve2();
        }
        return;
      }
      const exitTimeout = setTimeout(() => {
        if (this.verbose) {
          console.error("[gemini-cli-shim] Process exit timeout, forcing kill");
        }
        this.kill();
        if (hasSessionError) {
          reject(new Error("Invalid session ID"));
        } else {
          reject(new Error("Process did not exit within timeout"));
        }
      }, 2e3);
      this.process.on("close", (code) => {
        clearTimeout(exitTimeout);
        if (hasSessionError) {
          reject(new Error("Invalid session ID"));
        } else if (code === 0 || code === null) {
          resolve2();
        } else {
          reject(new Error(`Gemini CLI exited with code ${code}`));
        }
      });
      this.process.on("error", (err) => {
        clearTimeout(exitTimeout);
        if (hasSessionError) {
          reject(new Error("Invalid session ID"));
        } else {
          reject(err);
        }
      });
    });
  }
  /**
   * Kill the process
   */
  kill() {
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
    }
  }
};

// src/utils/ids.ts
import { randomBytes } from "crypto";
function generateMessageId() {
  const timestamp = Date.now().toString(36);
  const random = randomBytes(5).toString("hex");
  return `msg_${timestamp}${random}`;
}
function generateToolUseId() {
  const timestamp = Date.now().toString(36);
  const random = randomBytes(6).toString("hex");
  return `toolu_${timestamp}${random}`;
}
var NIL_UUID = "00000000-0000-0000-0000-000000000000";

// src/utils/tools.ts
var TOOL_NAME_MAP = {
  // File operations
  "read_file": "Read",
  "readFile": "Read",
  "file_read": "Read",
  "write_file": "Write",
  "writeFile": "Write",
  "file_write": "Write",
  "edit_file": "Edit",
  "editFile": "Edit",
  "str_replace_editor": "Edit",
  // Shell operations
  "run_shell_command": "Bash",
  "bash": "Bash",
  "shell": "Bash",
  "execute_bash": "Bash",
  // Directory operations
  "list_directory": "LS",
  "ls": "LS",
  "list": "LS",
  "list_dir": "LS",
  // Search operations
  "glob": "Glob",
  "find_files": "Glob",
  "grep": "Grep",
  "search_files": "Grep",
  "search": "Grep"
};
function normalizeToolName(toolName) {
  return TOOL_NAME_MAP[toolName] || toolName;
}
function camelToSnake(str) {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
function transformToolInput(input) {
  if (!input) return input;
  const transformed = {};
  for (const [key, value] of Object.entries(input)) {
    transformed[camelToSnake(key)] = value;
  }
  return transformed;
}
function getStandardTools() {
  return ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "LS"];
}

// src/shim.ts
import { readFileSync } from "fs";
import { resolve } from "path";
function emit(message) {
  console.log(JSON.stringify(message));
}
function getApiKeySource() {
  if (process.env.GOOGLE_API_KEY) return "GOOGLE_API_KEY";
  if (process.env.GEMINI_API_KEY) return "GEMINI_API_KEY";
  return "none";
}
async function runShim(prompt, options) {
  const startTime = Date.now();
  let apiStartTime = 0;
  let apiEndTime = 0;
  let sessionId = "";
  let numTurns = 0;
  let totalUsage = {
    input_tokens: 0,
    output_tokens: 0
  };
  let isError = false;
  let resultText = "";
  let systemInitEmitted = false;
  const defaultSystemPrompt = "Always repeat the results of your tool calls (like file contents or command output) in your text response. This is critical for verification.";
  const combinedSystemPrompt = options.appendSystemPrompt ? `${defaultSystemPrompt}
${options.appendSystemPrompt}` : defaultSystemPrompt;
  const geminiOptions = {
    ...options,
    appendSystemPrompt: combinedSystemPrompt
  };
  const emittedToolIds = /* @__PURE__ */ new Set();
  const toolIdMap = /* @__PURE__ */ new Map();
  const toolInfoMap = /* @__PURE__ */ new Map();
  let currentAssistantContent = [];
  let currentMessageId = generateMessageId();
  let hasReceivedDeltas = false;
  let turnProcessedText = "";
  try {
    const gemini = new GeminiCLI(geminiOptions);
    const events = await gemini.spawn(prompt);
    for await (const event of events) {
      switch (event.type) {
        case "init": {
          sessionId = event.session_id;
          systemInitEmitted = true;
          const systemMsg = {
            type: "system",
            subtype: "init",
            cwd: options.cwd,
            session_id: sessionId,
            tools: getStandardTools(),
            model: formatModelForOutput(options.model),
            permissionMode: "bypassPermissions",
            apiKeySource: getApiKeySource(),
            mcp_servers: []
          };
          emit(systemMsg);
          apiStartTime = Date.now();
          break;
        }
        case "message": {
          if (event.role === "assistant") {
            if (event.delta) {
              hasReceivedDeltas = true;
              turnProcessedText += event.content;
              currentAssistantContent.push({
                type: "text",
                text: event.content
              });
            } else if (!hasReceivedDeltas) {
              currentAssistantContent.push({
                type: "text",
                text: event.content
              });
              turnProcessedText = event.content;
            } else {
              if (event.content.length > turnProcessedText.length && event.content.startsWith(turnProcessedText)) {
                const extra = event.content.slice(turnProcessedText.length);
                if (extra.trim()) {
                  currentAssistantContent.push({
                    type: "text",
                    text: extra
                  });
                  turnProcessedText = event.content;
                }
              }
            }
          }
          break;
        }
        case "tool_use": {
          if (!emittedToolIds.has(event.tool_id)) {
            emittedToolIds.add(event.tool_id);
            const shimToolId = generateToolUseId();
            toolIdMap.set(event.tool_id, shimToolId);
            const normalizedName = normalizeToolName(event.tool_name);
            const transformedInput = transformToolInput(event.parameters);
            toolInfoMap.set(event.tool_id, { name: normalizedName, params: event.parameters });
            currentAssistantContent.push({
              type: "tool_use",
              id: shimToolId,
              name: normalizedName,
              input: transformedInput
            });
            const assistantMsg = {
              type: "assistant",
              message: {
                id: currentMessageId,
                type: "message",
                role: "assistant",
                model: formatModelForOutput(options.model),
                content: currentAssistantContent,
                stop_reason: "tool_use"
              }
            };
            emit(assistantMsg);
            currentAssistantContent = [];
            currentMessageId = generateMessageId();
            hasReceivedDeltas = false;
            turnProcessedText = "";
            numTurns++;
          }
          break;
        }
        case "tool_result": {
          const toolUseId = toolIdMap.get(event.tool_id) || generateToolUseId();
          const info = toolInfoMap.get(event.tool_id);
          let content = "";
          if (event.status === "error") {
            content = { is_error: true, error: event.error || "Unknown error" };
          } else {
            content = event.output !== void 0 ? event.output : event.result || event.content || "";
            if (info?.name === "Read" && content === "") {
              const filePath = info.params?.file_path || info.params?.filePath || info.params?.path;
              if (filePath) {
                try {
                  const absolutePath = resolve(options.cwd, filePath);
                  content = readFileSync(absolutePath, "utf-8");
                } catch (e) {
                }
              }
            }
          }
          const userMsg = {
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
          emit(userMsg);
          hasReceivedDeltas = false;
          turnProcessedText = "";
          break;
        }
        case "result": {
          apiEndTime = Date.now();
          if (currentAssistantContent.length > 0) {
            const assistantMsg = {
              type: "assistant",
              message: {
                id: currentMessageId,
                type: "message",
                role: "assistant",
                model: formatModelForOutput(options.model),
                content: currentAssistantContent,
                stop_reason: "end_turn"
              }
            };
            emit(assistantMsg);
            numTurns++;
          }
          totalUsage.input_tokens += event.stats.input_tokens || 0;
          totalUsage.output_tokens += event.stats.output_tokens || 0;
          isError = event.status === "error";
          resultText = isError ? "Error completing request" : "Request completed successfully";
          break;
        }
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorMsg.includes("Invalid session ID")) {
      throw err;
    }
    isError = true;
    resultText = `Agent Error: ${errorMsg}`;
    if (!systemInitEmitted) {
      const systemMsg = {
        type: "system",
        subtype: "init",
        cwd: options.cwd,
        session_id: sessionId || NIL_UUID,
        tools: getStandardTools(),
        model: formatModelForOutput(options.model),
        permissionMode: "bypassPermissions",
        apiKeySource: getApiKeySource(),
        mcp_servers: []
      };
      emit(systemMsg);
      systemInitEmitted = true;
    }
    const syntheticMsg = {
      type: "assistant",
      message: {
        id: NIL_UUID,
        type: "message",
        role: "assistant",
        model: "<synthetic>",
        content: [
          {
            type: "text",
            text: resultText
          }
        ]
      }
    };
    emit(syntheticMsg);
  }
  const endTime = Date.now();
  const resultMsg = {
    type: "result",
    subtype: isError ? "error" : "success",
    is_error: isError,
    duration_ms: endTime - startTime,
    duration_api_ms: apiEndTime > 0 ? apiEndTime - apiStartTime : 0,
    num_turns: numTurns,
    result: resultText,
    session_id: sessionId,
    usage: totalUsage
  };
  emit(resultMsg);
  await new Promise((resolve2) => {
    process.stdout.write("", () => resolve2());
  });
  return {
    exitCode: isError ? 1 : 0,
    sessionId
  };
}
async function emitError(errorMsg, sessionId) {
  const systemMsg = {
    type: "system",
    subtype: "init",
    cwd: process.cwd(),
    session_id: sessionId || NIL_UUID,
    tools: getStandardTools(),
    model: "<unknown>",
    permissionMode: "bypassPermissions",
    apiKeySource: getApiKeySource(),
    mcp_servers: []
  };
  emit(systemMsg);
  const syntheticMsg = {
    type: "assistant",
    message: {
      id: NIL_UUID,
      type: "message",
      role: "assistant",
      model: "<synthetic>",
      content: [
        {
          type: "text",
          text: `API Error: ${errorMsg}`
        }
      ]
    }
  };
  emit(syntheticMsg);
  const resultMsg = {
    type: "result",
    subtype: "error",
    is_error: true,
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 0,
    result: errorMsg,
    session_id: sessionId
  };
  emit(resultMsg);
  await new Promise((resolve2) => {
    process.stdout.write("", () => resolve2());
  });
}

// src/index.ts
import { fileURLToPath } from "url";
import { dirname, join } from "path";
var __filename2 = fileURLToPath(import.meta.url);
var __dirname2 = dirname(__filename2);
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}
function printHelp() {
  console.error(`
Gemini CLI Shim - Translate Gemini CLI to standardized JSONL output

Usage: gemini-cli-shim [options]

Required Arguments:
  --model <model>              Model identifier (shortname, provider/model, or full ID)

Optional Arguments:
  -p                           Indicates prompt via stdin (optional, stdin always read)
  --resume <session_id>        Session ID to continue
  --verbose                    Enable verbose logging to stderr
  --append-system-prompt <txt> Additional system prompt to append
  --self-test                  Run environment verification
  --version                    Print version and exit
  --help                       Print this help and exit

Examples:
  echo "Hello" | gemini-cli-shim --model flash
  echo "Continue" | gemini-cli-shim --model pro --resume <session_id>
  gemini-cli-shim --self-test
`);
}
function printVersion() {
  try {
    const pkgPath = join(__dirname2, "..", "package.json");
    const pkg = JSON.parse(readFileSync2(pkgPath, "utf-8"));
    console.error(`gemini-cli-shim v${pkg.version}`);
  } catch {
    console.error("gemini-cli-shim (version unknown)");
  }
}
async function selfTest() {
  const checks = [];
  const geminiInfo = await GeminiCLI.isInstalled();
  checks.push({
    name: "gemini_cli_found",
    passed: geminiInfo.found,
    message: geminiInfo.found ? `Gemini CLI found at ${geminiInfo.path} (${geminiInfo.version})` : "Gemini CLI not found in PATH"
  });
  const hasApiKey = !!(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY);
  checks.push({
    name: "api_key",
    passed: hasApiKey,
    message: hasApiKey ? "API key found in environment" : "No GOOGLE_API_KEY or GEMINI_API_KEY found"
  });
  const allPassed = checks.every((c) => c.passed);
  const result = {
    shim: {
      name: "gemini-cli-shim",
      version: "1.0.0"
    },
    agent: {
      name: "gemini-cli",
      version: geminiInfo.version || "unknown",
      found: geminiInfo.found
    },
    checks,
    overall: {
      passed: allPassed,
      message: allPassed ? "All checks passed" : "Some checks failed"
    }
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(allPassed ? 0 : 1);
}
async function main() {
  const args = parseArguments(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (args.version) {
    printVersion();
    process.exit(0);
  }
  if (args.selfTest) {
    await selfTest();
    return;
  }
  if (!args.model) {
    console.error("Error: --model is required");
    printHelp();
    process.exit(1);
  }
  const prompt = await readStdin();
  if (!prompt) {
    process.exit(0);
  }
  const resolvedModel = resolveModel(args.model);
  const geminiInfo = await GeminiCLI.isInstalled();
  if (!geminiInfo.found) {
    console.error("Error: Gemini CLI not found in PATH");
    console.error("Please install Gemini CLI: https://geminicli.com/docs/");
    process.exit(1);
  }
  if (!process.env.GOOGLE_API_KEY && !process.env.GEMINI_API_KEY) {
    console.error("Error: No API key found");
    console.error("Set GOOGLE_API_KEY or GEMINI_API_KEY environment variable");
    process.exit(1);
  }
  let interrupted = false;
  const handleSignal = () => {
    if (!interrupted) {
      interrupted = true;
      if (args.verbose) {
        console.error("[gemini-cli-shim] Received interrupt signal, exiting gracefully");
      }
      process.exit(0);
    }
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
  try {
    const result = await runShim(prompt, {
      model: resolvedModel,
      resume: args.resume,
      verbose: args.verbose,
      cwd: process.cwd()
    });
    process.exit(result.exitCode);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorMsg.includes("Invalid session ID")) {
      console.error(`Error: Session not found: ${args.resume}`);
      console.error("Use a valid session ID to resume");
      process.exit(1);
    }
    await emitError(errorMsg);
    process.exit(1);
  }
}
main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
