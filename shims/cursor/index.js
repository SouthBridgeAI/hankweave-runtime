#!/usr/bin/env node

// src/index.ts
import process2 from "node:process";

// src/args.ts
function parseArgs(argv) {
  const args = {
    model: process.env.MODEL || "composer-2.5-fast",
    verbose: false,
    idleTimeout: 120,
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
        const [, nextIndex] = takeValue(i, raw);
        i = nextIndex;
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
  process.stdout.write(`Cursor Agent shim

Usage:
  cursor-agent-shim --model <model> [options]

Options:
  -p                              Prompt via stdin (accepted, optional)
  --model <model>                 Cursor model id (passed through)
  --resume <session_id>           Resume a Cursor chat UUID
  --verbose                       Verbose stderr logging
  --append-system-prompt <text>   Prefixed onto the stdin prompt
  --idle-timeout <seconds>        Kill the agent after this much silence (default: 120)
  --debug-dir <path>              Write raw stream logs and session records
  --sandbox <level>               Accepted and ignored; the agent is spawned with --sandbox disabled
  --self-test                     Verify the agent binary and print JSON
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

// src/constants.ts
var SHIM_NAME = "cursor-agent-shim";
var SHIM_VERSION = "0.1.0";
var KNOWN_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "LS"];

// src/run.ts
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

// src/translate.ts
import { randomBytes } from "node:crypto";
var TOOL_KEY_NAMES = {
  shellToolCall: "Bash",
  readToolCall: "Read",
  grepToolCall: "Grep",
  searchToolCall: "Grep",
  globToolCall: "Glob",
  lsToolCall: "LS",
  listToolCall: "LS",
  writeToolCall: "Write"
};
function messageId() {
  return `msg_${randomBytes(12).toString("hex")}`;
}
function publicToolId(nativeId) {
  const hex = nativeId.replace(/[^a-fA-F0-9]/g, "");
  if (hex.length >= 8) return `toolu_${hex.slice(0, 32)}`;
  return `toolu_${randomBytes(12).toString("hex")}`;
}
function findToolPayload(toolCall) {
  for (const [key, value] of Object.entries(toolCall)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const payload = value;
    if ("args" in payload || "result" in payload) {
      return { key, payload };
    }
  }
  return void 0;
}
function shimToolName(key, args, result) {
  if (key === "editToolCall") {
    const success = isRecord(result) && isRecord(result.success) ? result.success : void 0;
    const diff = typeof success?.diffString === "string" ? success.diffString : "";
    if (diff.includes("/dev/null")) return "Write";
    if (!success && typeof args.streamContent === "string" && args.old_string === void 0 && args.oldString === void 0) {
      return "Write";
    }
    return "Edit";
  }
  return TOOL_KEY_NAMES[key] ?? key.replace(/ToolCall$/, "");
}
function toolInput(name, args) {
  switch (name) {
    case "Bash":
      return {
        command: typeof args.command === "string" ? args.command : "",
        description: typeof args.description === "string" ? args.description : void 0
      };
    case "Read":
      return { file_path: typeof args.path === "string" ? args.path : "" };
    case "Write":
      return {
        file_path: typeof args.path === "string" ? args.path : "",
        content: typeof args.streamContent === "string" ? args.streamContent : args.content
      };
    case "Edit":
      return {
        file_path: typeof args.path === "string" ? args.path : "",
        content: typeof args.streamContent === "string" ? args.streamContent : void 0
      };
    case "Grep":
      return {
        pattern: args.pattern ?? args.query ?? "",
        path: args.path
      };
    case "Glob":
      return { pattern: args.glob_pattern ?? args.pattern ?? args.glob ?? "" };
    case "LS":
      return { path: args.path ?? args.target_directory ?? "" };
    default:
      return args;
  }
}
function toolResultText(name, result) {
  if (!isRecord(result)) {
    return { text: result === void 0 ? "" : stringify(result), isError: false };
  }
  if (isRecord(result.success)) {
    return { text: successText(name, result.success), isError: false };
  }
  const failure = result.error ?? result.failure ?? result;
  return { text: stringify(failure), isError: true };
}
function successText(name, success) {
  switch (name) {
    case "Bash":
      return joinParts([success.stdout, success.stderr]);
    case "Read":
      return typeof success.content === "string" ? success.content : stringify(success);
    case "Write":
    case "Edit":
      if (typeof success.message === "string") return success.message;
      if (typeof success.diffString === "string") return success.diffString;
      return stringify(success);
    default:
      return stringify(success);
  }
}
function joinParts(parts) {
  return parts.filter((part) => typeof part === "string" && part.length > 0).join("\n");
}
function stringify(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function assistantText(event) {
  const message = event.message;
  if (!isRecord(message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return "";
    return block.text;
  }).join("");
}
function usageFromCursor(usage) {
  if (!isRecord(usage)) return void 0;
  return {
    input_tokens: numberField(usage.inputTokens),
    output_tokens: numberField(usage.outputTokens),
    cache_read_input_tokens: numberField(usage.cacheReadTokens),
    cache_creation_input_tokens: numberField(usage.cacheWriteTokens)
  };
}
function numberField(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// src/run.ts
async function runSelfTest() {
  const agentPath = process.env.CURSOR_AGENT_BIN || "agent";
  const version = await agentVersion(agentPath);
  const found = version !== null;
  const authed = Boolean(process.env.CURSOR_API_KEY) || found;
  const checks = [
    {
      name: "agent_found",
      passed: found,
      message: found ? `Found Cursor agent (${version})` : `Cursor agent binary not runnable (${agentPath})`
    },
    {
      name: "auth_configured",
      passed: authed,
      message: process.env.CURSOR_API_KEY ? "Authentication configured via CURSOR_API_KEY" : found ? "agent binary responded; login or CURSOR_API_KEY is used at runtime" : "No Cursor auth check possible because the binary was not found"
    }
  ];
  const passed = checks.every((check) => check.passed);
  process.stdout.write(
    `${JSON.stringify(
      {
        shim: { name: SHIM_NAME, version: SHIM_VERSION },
        agent: { name: "cursor-agent", version: version ?? "unknown", found },
        checks,
        overall: { passed, message: passed ? "All checks passed" : "One or more checks failed" }
      },
      null,
      2
    )}
`
  );
  return passed ? 0 : 1;
}
async function runShim(args, prompt) {
  if (args.resume && !sessionRecordExists(args.resume, args.debugDir)) {
    process.stderr.write(`session not found: ${args.resume}
`);
    return 1;
  }
  const started = Date.now();
  const cwd = process.cwd();
  const promptText = args.appendSystemPrompt ? `${args.appendSystemPrompt}

${prompt}` : prompt;
  let sessionId = args.resume ?? randomUUID();
  let initEmitted = false;
  let resultEmitted = false;
  let assistantTurns = 0;
  let exitCode = 0;
  const openTools = /* @__PURE__ */ new Map();
  const emit = (value) => {
    process.stdout.write(`${JSON.stringify(value)}
`);
  };
  const emitInit = () => {
    if (initEmitted) return;
    initEmitted = true;
    emit({
      type: "system",
      subtype: "init",
      session_id: sessionId,
      cwd,
      tools: [...KNOWN_TOOLS],
      model: args.model,
      permissionMode: "bypassPermissions",
      apiKeySource: process.env.CURSOR_API_KEY ? "env" : "login"
    });
  };
  const child = spawnAgent(args, cwd);
  child.stdin?.write(promptText);
  child.stdin?.end();
  const debugLines = [];
  let buffer = "";
  const finish = (code) => {
    emitInit();
    if (!resultEmitted) {
      emit({
        type: "result",
        subtype: code === 0 ? "success" : "error",
        is_error: code !== 0,
        duration_ms: Date.now() - started,
        num_turns: assistantTurns,
        result: code === 0 ? "" : "agent exited before a result event",
        session_id: sessionId
      });
      resultEmitted = true;
    }
    persistSession(sessionId, args.debugDir);
    if (args.debugDir && debugLines.length > 0) {
      mkdirSync(args.debugDir, { recursive: true });
      writeFileSync(path.join(args.debugDir, `${sessionId}.jsonl`), `${debugLines.join("\n")}
`);
    }
    exitCode = code;
  };
  let idleTimer;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      process.stderr.write(`idle timeout after ${args.idleTimeout}s
`);
      child.kill("SIGTERM");
      finish(1);
    }, args.idleTimeout * 1e3);
  };
  armIdle();
  const onSignal = (signal) => {
    child.kill(signal);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const handleLine = (line) => {
    debugLines.push(line);
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      if (args.verbose) process.stderr.write(`ignored non-json line
`);
      return;
    }
    armIdle();
    const type = event.type;
    const subtype = event.subtype;
    if (type === "system" && subtype === "init" && typeof event.session_id === "string") {
      if (!args.resume) sessionId = event.session_id;
      emitInit();
      return;
    }
    if (type === "user" || type === "thinking") return;
    if (type === "assistant") {
      emitInit();
      const text = assistantText(event);
      if (!text) return;
      assistantTurns += 1;
      emit({
        type: "assistant",
        message: {
          id: messageId(),
          type: "message",
          role: "assistant",
          model: args.model,
          content: [{ type: "text", text }]
        }
      });
      return;
    }
    if (type === "tool_call" && event.tool_call && typeof event.tool_call === "object") {
      emitInit();
      const toolCall = event.tool_call;
      const found = findToolPayload(toolCall);
      if (!found) return;
      const nativeId = typeof event.call_id === "string" ? event.call_id : messageId();
      const argsRecord = isRecord2(found.payload.args) ? found.payload.args : {};
      if (subtype === "started") {
        const name = shimToolName(found.key, argsRecord, found.payload.result);
        const id = publicToolId(nativeId);
        openTools.set(nativeId, { id, name, args: argsRecord });
        assistantTurns += 1;
        emit({
          type: "assistant",
          message: {
            id: messageId(),
            type: "message",
            role: "assistant",
            model: args.model,
            content: [{ type: "tool_use", id, name, input: toolInput(name, argsRecord) }]
          }
        });
        return;
      }
      if (subtype === "completed") {
        let open = openTools.get(nativeId);
        if (!open) {
          const name = shimToolName(found.key, argsRecord, found.payload.result);
          open = { id: publicToolId(nativeId), name, args: argsRecord };
          assistantTurns += 1;
          emit({
            type: "assistant",
            message: {
              id: messageId(),
              type: "message",
              role: "assistant",
              model: args.model,
              content: [{ type: "tool_use", id: open.id, name, input: toolInput(name, argsRecord) }]
            }
          });
        }
        const rendered = toolResultText(open.name, found.payload.result);
        emit({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: open.id,
                content: rendered.isError ? { is_error: true, error: rendered.text } : rendered.text
              }
            ]
          }
        });
        openTools.delete(nativeId);
      }
      return;
    }
    if (type === "result") {
      emitInit();
      const isError = event.is_error === true || subtype === "error";
      const usage = usageFromCursor(event.usage);
      emit({
        type: "result",
        subtype: isError ? "error" : "success",
        is_error: isError,
        duration_ms: typeof event.duration_ms === "number" ? event.duration_ms : Date.now() - started,
        duration_api_ms: typeof event.duration_api_ms === "number" ? event.duration_api_ms : void 0,
        num_turns: assistantTurns,
        result: typeof event.result === "string" ? event.result : "",
        session_id: sessionId,
        usage
      });
      resultEmitted = true;
      if (isError) exitCode = 1;
    }
  };
  await new Promise((resolve) => {
    child.stdout?.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) handleLine(line);
      }
    });
    child.stderr?.on("data", (chunk) => {
      process.stderr.write(chunk);
    });
    child.on("error", (error) => {
      process.stderr.write(`${error.message}
`);
      finish(1);
      resolve();
    });
    child.on("close", (code) => {
      if (buffer.trim()) handleLine(buffer);
      if (idleTimer) clearTimeout(idleTimer);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      if (!resultEmitted) finish(code === 0 ? 0 : 1);
      else persistSession(sessionId, args.debugDir);
      if (code !== 0 && code !== null) exitCode = 1;
      resolve();
    });
  });
  return exitCode;
}
function spawnAgent(args, cwd) {
  const bin = process.env.CURSOR_AGENT_BIN || "agent";
  const agentArgs = [
    "-p",
    "--trust",
    "--force",
    "--sandbox",
    "disabled",
    "--output-format",
    "stream-json",
    "--workspace",
    cwd,
    "--model",
    args.model
  ];
  if (args.resume) agentArgs.push("--resume", args.resume);
  return spawn(bin, agentArgs, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env
  });
}
function sessionRecordExists(id, debugDir) {
  const candidates = [
    path.join(process.cwd(), ".cursor-agent-shim", "sessions", `${id}.json`),
    debugDir ? path.join(debugDir, "sessions", `${id}.json`) : void 0
  ];
  return candidates.some((candidate) => candidate && existsSync(candidate));
}
function persistSession(id, debugDir) {
  const dirs = [path.join(process.cwd(), ".cursor-agent-shim", "sessions")];
  if (debugDir) dirs.push(path.join(debugDir, "sessions"));
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify({ session_id: id })}
`);
  }
}
function agentVersion(bin) {
  return new Promise((resolve) => {
    const child = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout?.on("data", (chunk) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      resolve(code === 0 ? out.trim() || "unknown" : null);
    });
  });
}
function isRecord2(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// src/index.ts
async function main() {
  try {
    const args = parseArgs(process2.argv.slice(2));
    if (args.help) {
      printHelp();
      return 0;
    }
    if (args.version) {
      process2.stdout.write(`${SHIM_VERSION}
`);
      return 0;
    }
    if (args.selfTest) {
      return await runSelfTest();
    }
    const prompt = await readStdinTrimmed();
    if (!prompt) return 0;
    return await runShim(args, prompt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process2.stderr.write(`${message}
`);
    return 1;
  }
}
main().then((code) => {
  process2.exit(code);
}).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process2.stderr.write(`${message}
`);
  process2.exit(1);
});
