import {
  BusyStepTimeoutError,
  IdleTimeoutError,
  SessionManager,
  STANDARD_TOOLS,
  type AssistantMessage,
  type ResultMessage,
  type ShimArguments,
  type SystemMessage,
  type TokenUsage,
  type UserMessage,
} from "@shims/common";
import fs from "node:fs";
import path from "node:path";
import {
  deleteSessionById,
  ensureOpencodeAvailable,
  filterDiagnosticStderr,
  findSessionIdByTitle,
  spawnOpencodeRun,
} from "./agent/opencode.js";
import type { OpencodeEvent, RunSummary, StepAccumulator } from "./types.js";
import { NIL_UUID, generateMessageId, generateSessionId, generateToolUseId, isUuidLike, normalizeMessageId } from "./utils/ids.js";
import { detectApiKeySource, resolveModel, supportsGeminiEmptyRetry } from "./utils/models.js";
import { emit, errorMessage, flushStdout, verboseLog } from "./utils/output.js";
import { extractToolResultContent, normalizeToolInput, normalizeToolName } from "./utils/tools.js";

const MAX_EMPTY_RETRIES = 5;

interface RunShimOptions {
  prompt: string;
  args: ShimArguments;
}

interface AttemptOutcome {
  summary: RunSummary;
  messages: Array<AssistantMessage | UserMessage>;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  suspiciousWorkspacePath?: string;
}

function emptyUsage(): TokenUsage {
  return {};
}

function debugJsonlPath(debugDir: string | undefined, sessionId: string): string | undefined {
  return debugDir ? path.join(debugDir, `session-${sessionId}.raw.jsonl`) : undefined;
}

function debugLogPath(debugDir: string | undefined, sessionId: string): string | undefined {
  return debugDir ? path.join(debugDir, `session-${sessionId}.raw.log`) : undefined;
}

function appendDebugJson(debugDir: string | undefined, sessionId: string, payload: unknown): void {
  const filePath = debugJsonlPath(debugDir, sessionId);
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
}

function appendDebugLog(debugDir: string | undefined, sessionId: string, text: string): void {
  const filePath = debugLogPath(debugDir, sessionId);
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, text.endsWith("\n") ? text : `${text}\n`, "utf8");
}

function touchDebugLog(debugDir: string | undefined, sessionId: string): void {
  const filePath = debugLogPath(debugDir, sessionId);
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "", "utf8");
  }
}

function addUsage(target: TokenUsage, incoming: TokenUsage | undefined): void {
  if (!incoming) return;

  for (const key of [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ] as const) {
    const value = incoming[key];
    if (typeof value === "number") {
      target[key] = (target[key] ?? 0) + value;
    }
  }
}

function usageFromStepTokens(tokens: Record<string, unknown> | undefined): TokenUsage | undefined {
  if (!tokens) return undefined;
  const cache = typeof tokens.cache === "object" && tokens.cache !== null ? (tokens.cache as Record<string, unknown>) : undefined;
  return {
    input_tokens: typeof tokens.input === "number" ? tokens.input : undefined,
    output_tokens: typeof tokens.output === "number" ? tokens.output : undefined,
    cache_creation_input_tokens: typeof cache?.write === "number" ? cache.write : undefined,
    cache_read_input_tokens: typeof cache?.read === "number" ? cache.read : undefined,
  };
}

function summarizeAssistantText(step: StepAccumulator): string {
  return step.contentBlocks
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function summarizeLastToolResult(step: StepAccumulator): string {
  const last = step.toolResults.at(-1);
  if (!last) return "";
  return typeof last.content === "string" ? last.content : last.content.error;
}

function humanizeToolSummary(summary: string): string {
  const contentMatch = summary.match(/<content>([\s\S]*?)<\/content>/i);
  const body = (contentMatch?.[1] ?? summary).trim();
  return body || summary;
}

function createStepAccumulator(messageId: unknown): StepAccumulator {
  return {
    messageId: normalizeMessageId(messageId),
    contentBlocks: [],
    toolResults: [],
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function extractEventError(event: OpencodeEvent): string {
  const err = asRecord(event.error);
  const data = asRecord(err?.data);
  return (
    (typeof data?.message === "string" && data.message) ||
    (typeof err?.message === "string" && err.message) ||
    "Unknown OpenCode error"
  );
}

function isRetryableEmptyGeminiResponse(summary: RunSummary): boolean {
  return (
    !summary.sawAnyContent &&
    summary.numTurns > 0 &&
    (summary.totalUsage.output_tokens ?? 0) === 0 &&
    summary.totalCostUsd > 0
  );
}

function classifyRuntimeError(message: string): string {
  if (/timeout|rate limit|auth|unauthorized|forbidden|model not found|api/i.test(message)) {
    return `API Error: ${message}`;
  }
  return `Agent Error: ${message}`;
}

function detectSuspiciousWorkspacePath(
  toolName: string,
  input: Record<string, unknown> | undefined,
  cwd: string,
): string | undefined {
  if (!input) return undefined;
  if (!["Write", "Read", "Edit", "Glob", "Grep", "LS"].includes(toolName)) {
    return undefined;
  }

  const candidates = [input.file_path, input.path];
  for (const value of candidates) {
    if (typeof value !== "string") continue;
    if (!path.isAbsolute(value)) continue;
    const relative = path.relative(cwd, value);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return value;
    }
  }

  return undefined;
}

function syntheticErrorAssistant(message: string): AssistantMessage {
  return {
    type: "assistant",
    message: {
      id: NIL_UUID,
      type: "message",
      role: "assistant",
      model: "<synthetic>",
      content: [{ type: "text", text: message }],
      stop_reason: "end_turn",
    },
  };
}

function resultMessage(params: {
  isError: boolean;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  result: string;
  sessionId: string;
  usage: TokenUsage;
  totalCostUsd?: number;
}): ResultMessage {
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
    usage: params.usage,
  };
}

async function processAttempt(params: {
  prompt: string;
  args: ShimArguments;
  model: string;
  cwd: string;
  shimSessionId: string;
  nativeSessionId?: string;
  interruptedRef: { value: boolean };
  onHandle?: (kill: () => void) => void;
}): Promise<AttemptOutcome> {
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
    idleTimeoutMs: params.args.idleTimeout * 1000,
  });
  params.onHandle?.(() => handle.kill("SIGTERM"));

  let currentStep: StepAccumulator | undefined;
  const toolIdMap = new Map<string, string>();
  const bufferedMessages: Array<AssistantMessage | UserMessage> = [];
  let suspiciousWorkspacePath: string | undefined;
  const summary: RunSummary = {
    sawAnyContent: false,
    sawTerminalStop: false,
    totalCostUsd: 0,
    totalUsage: emptyUsage(),
    numTurns: 0,
    finalResultText: "",
    lastToolSummary: "",
  };

  const ensureCurrentStep = (part?: Record<string, unknown>) => {
    if (!currentStep) {
      currentStep = createStepAccumulator(part?.messageID);
    }
    return currentStep;
  };

  const flushStep = (reason: string | undefined, usage: TokenUsage | undefined) => {
    if (!currentStep) return;

    const hasAssistantContent = currentStep.contentBlocks.length > 0;
    if (hasAssistantContent) {
      const assistantMsg: AssistantMessage = {
        type: "assistant",
        message: {
          id: currentStep.messageId || generateMessageId(),
          type: "message",
          role: "assistant",
          model: params.model,
          content: currentStep.contentBlocks,
          usage,
          stop_reason: reason === "tool-calls" ? "tool_use" : "end_turn",
        },
      };
      // Emit immediately for incremental progress visibility, and buffer for retry logic
      emit(assistantMsg);
      bufferedMessages.push(assistantMsg);
    }

    if (currentStep.toolResults.length > 0) {
      const userMessage: UserMessage = {
        type: "user",
        message: {
          role: "user",
          content: currentStep.toolResults,
        },
      };
      // Emit immediately for incremental progress visibility, and buffer for retry logic
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
          const thinking =
            typeof part?.text === "string"
              ? part.text
              : typeof part?.reasoning === "string"
                ? part.reasoning
                : undefined;
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
            input: normalizedInput,
          });
          step.toolResults.push({
            type: "tool_result",
            tool_use_id: publicToolId,
            content: extractToolResultContent(toolName, state),
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
          // Unknown events still reset timeout upstream; preserve silence here.
          break;
        }
      }
    }
  } catch (error) {
    handle.kill("SIGTERM");
    try {
      await handle.waitForExit();
    } catch {
      // ignore secondary shutdown errors
    }
    throw error;
  }

  const exitStatus = await handle.waitForExit();
  return {
    summary,
    messages: bufferedMessages,
    exitCode: exitStatus.code,
    signal: exitStatus.signal,
    stderr: filterDiagnosticStderr(handle.getStderr()),
    suspiciousWorkspacePath,
  };
}

function buildPrompt(prompt: string, retryNote?: string): string {
  const normalized = prompt.endsWith("\n") ? prompt : `${prompt}\n`;
  if (!retryNote) {
    return normalized;
  }

  return `${normalized}\n[Internal retry note: ${retryNote}. Do not mention or repeat this note.]\n`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runShim({ prompt, args }: RunShimOptions): Promise<number> {
  const cwd = process.cwd();
  const model = resolveModel(args.model || process.env.MODEL || "sonnet");
  const sessionManager = args.debugDir ? new SessionManager({ debugDir: args.debugDir }) : undefined;
  await ensureOpencodeAvailable();

  let shimSessionId = args.resume ? args.resume : generateSessionId();
  let nativeSessionId: string | undefined;

  if (args.resume) {
    if (!isUuidLike(args.resume)) {
      const message = `Invalid session ID: ${args.resume}`;
      appendDebugLog(args.debugDir, "unknown", message);
      process.stderr.write(`${message}\n`);
      return 1;
    }

    try {
      if (sessionManager) {
        try {
          const saved = sessionManager.loadSession(args.resume);
          nativeSessionId = saved.agentSessionId;
          shimSessionId = saved.sessionId;
        } catch {
          nativeSessionId = await findSessionIdByTitle(args.resume);
          if (!nativeSessionId) {
            throw new Error(`Session not found: ${args.resume}`);
          }
        }
      } else {
        nativeSessionId = await findSessionIdByTitle(args.resume);
        if (!nativeSessionId) {
          throw new Error(`Session not found: ${args.resume}`);
        }
      }
    } catch (error) {
      const message = errorMessage(error);
      appendDebugLog(args.debugDir, "unknown", message);
      process.stderr.write(`${message}\n`);
      return 1;
    }
  }

  const system: SystemMessage = {
    type: "system",
    subtype: "init",
    cwd: path.resolve(cwd),
    session_id: shimSessionId,
    tools: [...STANDARD_TOOLS],
    model,
    permissionMode: "bypassPermissions",
    apiKeySource: detectApiKeySource(model),
    mcp_servers: [],
  };

  touchDebugLog(args.debugDir, shimSessionId);
  appendDebugJson(args.debugDir, shimSessionId, {
    type: "init",
    session_id: shimSessionId,
    cwd: system.cwd,
    model,
  });
  emit(system);

  const startTime = Date.now();
  const interruptedRef = { value: false };
  let activeKill: (() => void) | undefined;

  const onSignal = () => {
    if (interruptedRef.value) return;
    interruptedRef.value = true;
    activeKill?.();
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const grandUsage = emptyUsage();
  let grandCostUsd = 0;
  let finalSummary: RunSummary | undefined;
  let finalStderr = "";
  let retryNote: string | undefined;

  try {
    for (let attempt = 0; attempt <= MAX_EMPTY_RETRIES; attempt++) {
      verboseLog(args.verbose, "Starting attempt", { attempt: attempt + 1, model, resumed: Boolean(args.resume) });
      if (args.verbose) {
        appendDebugLog(
          args.debugDir,
          shimSessionId,
          `[opencode-shim] Starting attempt ${attempt + 1} model=${model} resumed=${Boolean(args.resume)}`,
        );
      }

      const attemptPromise = processAttempt({
        prompt: buildPrompt(prompt, retryNote),
        args,
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
        },
      });

      const outcome = await attemptPromise;
      activeKill = undefined;
      finalStderr = outcome.stderr;
      addUsage(grandUsage, outcome.summary.totalUsage);
      grandCostUsd += outcome.summary.totalCostUsd;

      if (outcome.summary.opencodeSessionId) {
        nativeSessionId = outcome.summary.opencodeSessionId;
      }

      const retryableEmpty =
        !args.resume &&
        !interruptedRef.value &&
        supportsGeminiEmptyRetry(model) &&
        isRetryableEmptyGeminiResponse(outcome.summary);
      const retryableStaleWorkspace =
        !args.resume &&
        !interruptedRef.value &&
        supportsGeminiEmptyRetry(model) &&
        Boolean(outcome.suspiciousWorkspacePath);

      if (retryableEmpty || retryableStaleWorkspace) {
        retryNote = retryableEmpty
          ? `Retry token ${Date.now()}-${attempt}. A previous hidden attempt returned an empty response with zero output tokens. Produce a fresh non-empty answer and do not reuse any cached empty response`
          : `Retry token ${Date.now()}-${attempt}. A previous hidden attempt referenced the stale path ${outcome.suspiciousWorkspacePath}. The current working directory is ${cwd}. Redo the task from scratch and only use files inside ${cwd}`;
      }

      if ((retryableEmpty || retryableStaleWorkspace) && attempt < MAX_EMPTY_RETRIES) {
        const backoffMs = Math.min(1000 * 2 ** attempt, 8000);
        verboseLog(args.verbose, retryableEmpty ? "Retrying empty Gemini response" : "Retrying suspicious workspace response", {
          attempt: attempt + 1,
          backoffMs,
          suspiciousWorkspacePath: outcome.suspiciousWorkspacePath,
        });
        if (args.verbose) {
          appendDebugLog(
            args.debugDir,
            shimSessionId,
            `[opencode-shim] retry reason=${retryableEmpty ? "empty-response" : "suspicious-workspace"} attempt=${attempt + 1} backoff_ms=${backoffMs}`,
          );
        }
        if (outcome.summary.opencodeSessionId) {
          try {
            await deleteSessionById(outcome.summary.opencodeSessionId);
          } catch (cleanupError) {
            verboseLog(args.verbose, "Failed to delete discarded OpenCode retry session", {
              sessionId: outcome.summary.opencodeSessionId,
              error: errorMessage(cleanupError),
            });
          }
        }
        nativeSessionId = undefined;
        await sleep(backoffMs);
        continue;
      }

      if (retryableEmpty || retryableStaleWorkspace) {
        throw new Error(
          retryableEmpty
            ? "Provider returned repeated empty responses after retries"
            : `Provider returned stale workspace tool paths after retries: ${outcome.suspiciousWorkspacePath}`,
        );
      }

      finalSummary = outcome.summary;
      // Messages were already emitted incrementally in flushStep().
      // No need to emit again here — the buffer is kept for retry/discard logic only.

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
        metadata: { cwd, model },
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
          stop_reason: "end_turn",
        },
      });
    }

    const resultText = interruptedRef.value
      ? finalSummary.finalResultText || humanizeToolSummary(finalSummary.lastToolSummary) || "Interrupted"
      : finalSummary.finalResultText || humanizeToolSummary(finalSummary.lastToolSummary) || "Completed successfully.";

    const finalResultMessage = resultMessage({
      isError: false,
      durationMs,
      durationApiMs,
      numTurns: finalSummary.numTurns,
      result: resultText,
      sessionId: shimSessionId,
      usage: grandUsage,
      totalCostUsd: grandCostUsd,
    });
    emit(finalResultMessage);
    appendDebugJson(args.debugDir, shimSessionId, {
      type: "result",
      status: "success",
      exit_code: 0,
      duration_ms: durationMs,
    });
    await flushStdout();
    return 0;
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const durationApiMs = durationMs;

    const rawMessage =
      error instanceof IdleTimeoutError || error instanceof BusyStepTimeoutError
        ? error.message
        : errorMessage(error) || finalStderr || "Unknown runtime failure";
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
      totalCostUsd: grandCostUsd,
    });
    emit(finalResultMessage);
    appendDebugJson(args.debugDir, shimSessionId, {
      type: "result",
      status: "error",
      exit_code: 1,
      duration_ms: durationMs,
      error: classified,
    });
    appendDebugLog(args.debugDir, shimSessionId, classified);
    await flushStdout();
    return 1;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
