import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { ShimArgs } from "./args.js";
import { KNOWN_TOOLS, SHIM_NAME, SHIM_VERSION } from "./constants.js";
import {
  assistantText,
  findToolPayload,
  messageId,
  publicToolId,
  shimToolName,
  toolInput,
  toolResultText,
  usageFromCursor,
} from "./translate.js";

interface OpenTool {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export async function runSelfTest(): Promise<number> {
  const agentPath = process.env.CURSOR_AGENT_BIN || "agent";
  const version = await agentVersion(agentPath);
  const found = version !== null;
  const authed = Boolean(process.env.CURSOR_API_KEY) || found;
  const checks = [
    {
      name: "agent_found",
      passed: found,
      message: found ? `Found Cursor agent (${version})` : `Cursor agent binary not runnable (${agentPath})`,
    },
    {
      name: "auth_configured",
      passed: authed,
      message: process.env.CURSOR_API_KEY
        ? "Authentication configured via CURSOR_API_KEY"
        : found
          ? "agent binary responded; login or CURSOR_API_KEY is used at runtime"
          : "No Cursor auth check possible because the binary was not found",
    },
  ];
  const passed = checks.every((check) => check.passed);
  process.stdout.write(
    `${JSON.stringify(
      {
        shim: { name: SHIM_NAME, version: SHIM_VERSION },
        agent: { name: "cursor-agent", version: version ?? "unknown", found },
        checks,
        overall: { passed, message: passed ? "All checks passed" : "One or more checks failed" },
      },
      null,
      2,
    )}\n`,
  );
  return passed ? 0 : 1;
}

export async function runShim(args: ShimArgs, prompt: string): Promise<number> {
  if (args.resume && !sessionRecordExists(args.resume, args.debugDir)) {
    process.stderr.write(`session not found: ${args.resume}\n`);
    return 1;
  }

  const started = Date.now();
  const cwd = process.cwd();
  const promptText = args.appendSystemPrompt
    ? `${args.appendSystemPrompt}\n\n${prompt}`
    : prompt;

  let sessionId = args.resume ?? randomUUID();
  let initEmitted = false;
  let resultEmitted = false;
  let assistantTurns = 0;
  let exitCode = 0;
  const openTools = new Map<string, OpenTool>();

  const emit = (value: unknown): void => {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  };

  const emitInit = (): void => {
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
      apiKeySource: process.env.CURSOR_API_KEY ? "env" : "login",
    });
  };

  const child = spawnAgent(args, cwd);
  child.stdin?.write(promptText);
  child.stdin?.end();

  const debugLines: string[] = [];
  let buffer = "";

  const finish = (code: number): void => {
    emitInit();
    if (!resultEmitted) {
      emit({
        type: "result",
        subtype: code === 0 ? "success" : "error",
        is_error: code !== 0,
        duration_ms: Date.now() - started,
        num_turns: assistantTurns,
        result: code === 0 ? "" : "agent exited before a result event",
        session_id: sessionId,
      });
      resultEmitted = true;
    }
    persistSession(sessionId, args.debugDir);
    if (args.debugDir && debugLines.length > 0) {
      mkdirSync(args.debugDir, { recursive: true });
      writeFileSync(path.join(args.debugDir, `${sessionId}.jsonl`), `${debugLines.join("\n")}\n`);
    }
    exitCode = code;
  };

  let idleTimer: NodeJS.Timeout | undefined;
  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      process.stderr.write(`idle timeout after ${args.idleTimeout}s\n`);
      child.kill("SIGTERM");
      finish(1);
    }, args.idleTimeout * 1000);
  };
  armIdle();

  const onSignal = (signal: NodeJS.Signals): void => {
    child.kill(signal);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const handleLine = (line: string): void => {
    debugLines.push(line);
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      if (args.verbose) process.stderr.write(`ignored non-json line\n`);
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
          content: [{ type: "text", text }],
        },
      });
      return;
    }

    if (type === "tool_call" && event.tool_call && typeof event.tool_call === "object") {
      emitInit();
      const toolCall = event.tool_call as Record<string, unknown>;
      const found = findToolPayload(toolCall);
      if (!found) return;
      const nativeId = typeof event.call_id === "string" ? event.call_id : messageId();
      const argsRecord = isRecord(found.payload.args) ? found.payload.args : {};
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
            content: [{ type: "tool_use", id, name, input: toolInput(name, argsRecord) }],
          },
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
              content: [{ type: "tool_use", id: open.id, name, input: toolInput(name, argsRecord) }],
            },
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
                content: rendered.isError ? { is_error: true, error: rendered.text } : rendered.text,
              },
            ],
          },
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
        duration_api_ms: typeof event.duration_api_ms === "number" ? event.duration_api_ms : undefined,
        num_turns: assistantTurns,
        result: typeof event.result === "string" ? event.result : "",
        session_id: sessionId,
        usage,
      });
      resultEmitted = true;
      if (isError) exitCode = 1;
    }
  };

  await new Promise<void>((resolve) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) handleLine(line);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    child.on("error", (error) => {
      process.stderr.write(`${error.message}\n`);
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

function spawnAgent(args: ShimArgs, cwd: string): ChildProcess {
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
    args.model,
  ];
  if (args.resume) agentArgs.push("--resume", args.resume);
  return spawn(bin, agentArgs, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
}

function sessionRecordExists(id: string, debugDir: string | undefined): boolean {
  const candidates = [
    path.join(process.cwd(), ".cursor-agent-shim", "sessions", `${id}.json`),
    debugDir ? path.join(debugDir, "sessions", `${id}.json`) : undefined,
  ];
  return candidates.some((candidate) => candidate && existsSync(candidate));
}

function persistSession(id: string, debugDir: string | undefined): void {
  const dirs = [path.join(process.cwd(), ".cursor-agent-shim", "sessions")];
  if (debugDir) dirs.push(path.join(debugDir, "sessions"));
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify({ session_id: id })}\n`);
  }
}

function agentVersion(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      resolve(code === 0 ? out.trim() || "unknown" : null);
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
