import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  Codex,
  type Thread,
  type ThreadEvent,
  type ThreadItem,
  type Usage,
} from "@openai/codex-sdk";
import { parseArgs, type ShimArguments } from "@shims/common/args";
import type {
  AssistantMessage,
  ResultMessage,
  ShimMessage,
  SystemMessage,
  TokenUsage,
  UserMessage,
} from "@shims/common/messages";
import { SessionManager } from "@shims/common/sessions";
import {
  BusyStepTimeoutError,
  IdleTimeoutError,
  withAdaptiveTimeout,
} from "@shims/common/timeout";
import { DebugRecorder } from "./debug.js";
import { updateCodexTimeoutState } from "./timeout-state.js";
import {
  normalizeToolResult,
  normalizeToolUse,
  shouldTreatAsToolItem,
} from "./tools.js";
import {
  NIL_UUID,
  detectApiKeySource,
  flushStdout,
  generateMessageId,
  generateSessionId,
  generateToolUseId,
  getCodexPathOverride,
  hasAnyAuthConfigured,
  isValidSessionId,
  makeAbsoluteCwd,
  mapSandbox,
  resolveModel,
  toErrorMessage,
} from "./utils.js";
import shimPackageJson from "../package.json";

const DEFAULT_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "LS", "WebSearch"];
const HELP_TEXT = `codex-shim

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

interface RuntimeState {
  lastUsage?: TokenUsage;
  numTurns: number;
  finalText: string;
}

function emit(message: ShimMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function usageToTokenUsage(usage: Usage | undefined): TokenUsage | undefined {
  if (!usage) {
    return undefined;
  }

  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_input_tokens: usage.cached_input_tokens,
  };
}

function createSystemMessage(cwd: string, sessionId: string, model: string): SystemMessage {
  return {
    type: "system",
    subtype: "init",
    cwd,
    session_id: sessionId,
    tools: DEFAULT_TOOLS,
    model,
    permissionMode: "bypassPermissions",
    apiKeySource: detectApiKeySource(),
    mcp_servers: [],
  };
}

function createAssistantMessage(
  model: string,
  content: AssistantMessage["message"]["content"],
  stopReason: AssistantMessage["message"]["stop_reason"] = null,
  usage?: TokenUsage,
  id: string = generateMessageId(),
): AssistantMessage {
  return {
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content,
      stop_reason: stopReason,
      ...(usage ? { usage } : {}),
    },
  };
}

function createToolResultMessage(
  toolUseId: string,
  content: UserMessage["message"]["content"][number]["content"],
): UserMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content,
        },
      ],
    },
  };
}

function createResultMessage(
  ok: boolean,
  durationMs: number,
  durationApiMs: number,
  numTurns: number,
  summary: string,
  sessionId: string,
  usage?: TokenUsage,
): ResultMessage {
  return {
    type: "result",
    subtype: ok ? "success" : "error",
    is_error: !ok,
    duration_ms: durationMs,
    duration_api_ms: durationApiMs,
    num_turns: numTurns,
    result: summary,
    session_id: sessionId,
    ...(usage ? { usage } : {}),
  };
}

function composePrompt(prompt: string, appendSystemPrompt?: string): string {
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
    "</USER_REQUEST>",
  ].join("\n");
}

function classifyRuntimeError(error: unknown): string {
  if (error instanceof IdleTimeoutError || error instanceof BusyStepTimeoutError) {
    return `Agent Error: ${error.message}`;
  }

  const message = toErrorMessage(error);
  if (
    /rate limit|authentication|not supported|invalid model|insufficient|quota|api|unsupported/i.test(
      message,
    )
  ) {
    return `API Error: ${message}`;
  }

  return `Agent Error: ${message}`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

function writeStartupError(message: string, debugDir?: string): never {
  DebugRecorder.logStartupError(debugDir, message);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/**
 * On Windows, find the vendored codex.exe inside the npm global install.
 * The SDK's own findCodexPath() uses createRequire(import.meta.url) which
 * resolves from the shim's bundle location, not the global npm prefix.
 *
 * The platform package may be hoisted or nested:
 *   <prefix>/node_modules/@openai/codex-win32-x64/vendor/...
 *   <prefix>/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/...
 */
function findVendoredCodexExe(npmPrefix: string): string | null {
  const arch = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const pkgName = process.arch === "arm64" ? "@openai/codex-win32-arm64" : "@openai/codex-win32-x64";
  const tail = path.join(...pkgName.split("/"), "vendor", arch, "codex", "codex.exe");

  // Try hoisted location first, then nested inside @openai/codex
  const candidates = [
    path.join(npmPrefix, "node_modules", tail),
    path.join(npmPrefix, "node_modules", "@openai", "codex", "node_modules", tail),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function resolveCodexPath(command: string): Promise<string | null> {
  const isWindows = process.platform === "win32";

  // If already an absolute/relative path, check it exists
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    if (fs.existsSync(command)) return command;
    if (isWindows) {
      for (const ext of [".cmd", ".exe"]) {
        if (fs.existsSync(command + ext)) return command + ext;
      }
    }
    return null;
  }

  // Resolve via where/which
  const whichCommand = isWindows ? "where" : "which";
  const resolved = await new Promise<string | null>((resolve) => {
    const proc = spawn(whichCommand, [command], {
      shell: isWindows,
      stdio: ["ignore", "pipe", "ignore"],
      env: process.env,
    });
    let stdout = "";
    proc.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.on("error", () => resolve(null));
    proc.on("close", (code) => {
      if (code === 0 && stdout.trim()) {
        // `where` on Windows may return multiple lines; take the first
        resolve(stdout.trim().split(/\r?\n/)[0]);
      } else {
        resolve(null);
      }
    });
  });

  if (!resolved) return null;

  // On Windows, npm global install creates shell scripts and .cmd wrappers that
  // Node's spawn() can't execute without shell: true (the Codex SDK doesn't use
  // shell: true). Instead, find the vendored codex.exe in the npm prefix directory.
  if (isWindows) {
    // The resolved path (e.g. C:\npm\prefix\codex) is in the npm prefix bin dir.
    // The node_modules are in the same directory.
    const npmPrefix = path.dirname(resolved);
    const vendored = findVendoredCodexExe(npmPrefix);
    if (vendored) return vendored;
  }

  return resolved;
}

async function resolveAgentVersion(codexPath: string): Promise<string> {
  const isWindows = process.platform === "win32";

  return await new Promise<string>((resolve) => {
    const proc = spawn(codexPath, ["--version"], {
      shell: isWindows,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
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
        resolve(stdout.trim() || stderr.trim() || shimPackageJson.dependencies["@openai/codex-sdk"] || "unknown");
      } else {
        resolve("unknown");
      }
    });
  });
}

async function runSelfTest(): Promise<number> {
  const apiKeySource = detectApiKeySource();
  const override = getCodexPathOverride() || "codex";
  const resolvedPath = await resolveCodexPath(override);
  const agentFound = resolvedPath !== null;

  const agentVersion = resolvedPath ? await resolveAgentVersion(resolvedPath) : "unknown";
  const checks = [
    {
      name: "agent_found",
      passed: agentFound,
      message: agentFound ? `Found codex at ${resolvedPath}` : `Could not find codex via ${override}`,
    },
    {
      name: "api_key",
      passed: apiKeySource !== "none",
      message:
        apiKeySource !== "none"
          ? `Authentication source available: ${apiKeySource}`
          : "No OPENAI_API_KEY, CODEX_API_KEY, or ~/.codex/auth.json found",
    },
  ];

  const overallPassed = checks.every((check) => check.passed);
  process.stdout.write(
    `${JSON.stringify(
      {
        shim: { name: "codex-shim", version: shimPackageJson.version },
        agent: { name: "codex", version: agentVersion, found: agentFound },
        checks,
        overall: {
          passed: overallPassed,
          message: overallPassed ? "All checks passed" : "One or more checks failed",
        },
      },
      null,
      2,
    )}\n`,
  );

  return overallPassed ? 0 : 1;
}

class CodexShim {
  private readonly args: ShimArguments;
  private readonly prompt: string;
  private readonly cwd: string;
  private readonly debug: DebugRecorder;
  private readonly model: ReturnType<typeof resolveModel>;
  private readonly sessionManager: SessionManager;
  private readonly runtime: RuntimeState = {
    numTurns: 0,
    finalText: "",
  };
  private readonly toolIdMap = new Map<string, string>();
  private codex!: Codex;
  private sessionId: string;
  private interrupted = false;
  private currentAbortController?: AbortController;

  constructor(args: ShimArguments, prompt: string) {
    this.args = args;
    this.prompt = prompt;
    this.cwd = makeAbsoluteCwd(process.cwd());
    this.debug = new DebugRecorder(args.debugDir);
    this.model = resolveModel(this.args.model);
    this.sessionManager = new SessionManager({ debugDir: args.debugDir });
    this.sessionId = args.resume || generateSessionId();
  }

  async run(): Promise<number> {
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
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
    });

    let thread: Thread;
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
        this.runtime.lastUsage,
      );
      emit(resultMessage);
      this.debug.logResult("success", {
        session_id: this.sessionId,
        usage: this.runtime.lastUsage,
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
          undefined,
          NIL_UUID,
        ),
      );
      const resultMessage = createResultMessage(
        false,
        durationMs,
        durationApiMs,
        Math.max(this.runtime.numTurns, 1),
        summary,
        this.sessionId,
        this.runtime.lastUsage,
      );
      emit(resultMessage);
      this.debug.logLine(summary);
      this.debug.logResult("error", {
        session_id: this.sessionId,
        error: summary,
      });
      await flushStdout();
      return 1;
    }
  }

  private getThreadOptions() {
    return {
      model: this.model.sdkModel,
      modelReasoningEffort: this.model.reasoningEffort,
      sandboxMode: mapSandbox(this.args.sandbox),
      workingDirectory: this.cwd,
      skipGitRepoCheck: true,
      approvalPolicy: "never" as const,
    };
  }

  private async consumeEvents(events: AsyncGenerator<ThreadEvent>): Promise<void> {
    const idleTimeoutMs = this.args.idleTimeout * 1000;

    const timedEvents = withAdaptiveTimeout(events, {
      idleTimeoutMs,
      busyTimeoutMs: Math.max(idleTimeoutMs, 300_000),
      onEvent: (event, controller) => {
        updateCodexTimeoutState(event, controller, idleTimeoutMs);
      },
    });

    for await (const event of timedEvents) {
      this.debug.logSdkEvent(event);
      this.logVerbose(`SDK event: ${event.type}`);
      await this.handleEvent(event);
    }
  }

  private async handleEvent(event: ThreadEvent): Promise<void> {
    switch (event.type) {
      case "thread.started": {
        this.sessionManager.saveSession({
          sessionId: this.sessionId,
          agentSessionId: event.thread_id,
          timestamp: new Date().toISOString(),
          metadata: {
            model: this.model.publicModel,
            cwd: this.cwd,
          },
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

  private async handleCompletedItem(item: ThreadItem): Promise<void> {
    if (item.type === "reasoning") {
      emit(
        createAssistantMessage(this.model.publicModel, [
          {
            type: "thinking",
            thinking: item.text,
          },
        ]),
      );
      return;
    }

    if (item.type === "agent_message") {
      this.runtime.finalText = item.text;
      emit(
        createAssistantMessage(this.model.publicModel, [
          {
            type: "text",
            text: item.text,
          },
        ], "end_turn"),
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

  private async emitToolUseIfNeeded(item: ThreadItem): Promise<string | undefined> {
    if (!shouldTreatAsToolItem(item)) {
      return undefined;
    }

    const existing = this.toolIdMap.get(item.id);
    if (existing) {
      return existing;
    }

    const normalizedTool = normalizeToolUse(item, this.cwd);
    if (!normalizedTool) {
      return undefined;
    }

    const publicId = generateToolUseId();
    this.toolIdMap.set(item.id, publicId);
    emit(
      createAssistantMessage(this.model.publicModel, [
        {
          type: "tool_use",
          id: publicId,
          name: normalizedTool.name,
          ...(normalizedTool.input ? { input: normalizedTool.input } : {}),
        },
      ], "tool_use"),
    );
    return publicId;
  }

  private getAbortController(): AbortController {
    if (!this.currentAbortController) {
      this.currentAbortController = new AbortController();
    }
    return this.currentAbortController;
  }

  private installSignalHandlers(): void {
    const handle = (signal: NodeJS.Signals) => {
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

  private logVerbose(message: string): void {
    if (!this.args.verbose) {
      return;
    }

    process.stderr.write(`${message}\n`);
    this.debug.logLine(message);
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv, { "-h": "--help" });

  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  if (args.version) {
    process.stdout.write(`${shimPackageJson.version}\n`);
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

export async function runCli(): Promise<void> {
  try {
    const exitCode = await main();
    await flushStdout();
    process.exit(exitCode);
  } catch (error) {
    const message = toErrorMessage(error);
    process.stderr.write(`${message}\n`);
    await flushStdout();
    process.exit(1);
  }
}
