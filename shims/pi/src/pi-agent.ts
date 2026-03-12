import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentSession,
  type AgentSessionEvent,
  type SessionInfo,
  VERSION as PI_VERSION,
  createAgentSession,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { type ShimArguments, withAdaptiveTimeout } from "@shims/common";
import { DebugRecorder } from "./debug-recorder.js";
import {
  configureAuthStorage,
  formatMissingApiKeyMessage,
  getKnownApiKeyStatus,
  getProviderCredentialStatus,
  shouldEnforceProviderCredential,
} from "./provider-auth.js";
import {
  emitMessage,
  ensurePublicToolId,
  fallbackToolResultContent,
  makeAssistantMessage,
  makeUserMessageWithToolResults,
  normalizeToolInput,
  serializeToolResultContent,
  type PiAssistantMessage,
  type PiContentBlock,
  type PiToolResultMessage,
  type PiUsage,
} from "./translator.js";
import {
  applyPiWatchdogEvent,
  isPiWatchdogActivityEvent,
  SessionEventQueue,
} from "./watchdog.js";

export { applyPiWatchdogEvent, isPiWatchdogActivityEvent } from "./watchdog.js";

export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartupError";
  }
}

export interface PreparedPiSession {
  session: AgentSession;
  sessionId: string;
  model: string;
  apiKeySource: string;
  debugRecorder: DebugRecorder;
  dispose(): void;
}

export interface SessionRunResult {
  totalCostUsd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  numTurns: number;
  durationApiMs: number;
}

interface ToolCallMeta {
  publicId: string;
  input: Record<string, unknown>;
}

interface ResolvedModelIdentifier {
  resolved: string;
  provider: string;
  modelId: string;
}

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MODEL_SHORTNAMES: Record<string, string> = {
  sonnet: "anthropic/claude-sonnet-4-5",
  haiku: "anthropic/claude-haiku-4-5",
  opus: "anthropic/claude-opus-4-5",
  "gemini-2.5-flash": "google/gemini-2.5-flash",
  "gpt-4o": "openai/gpt-4o",
};

function detectBundledPiVersion(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(currentDir, "VERSION"), path.join(currentDir, "..", "VERSION")];

  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, "utf8").trim();
      const match = raw.match(/@mariozechner\/pi-coding-agent@(.*)$/);
      return (match?.[1] ?? raw).trim();
    } catch {
      // Try the next candidate.
    }
  }

  return PI_VERSION;
}

function getSessionStorageDir(debugDir: string | undefined): string | undefined {
  if (!debugDir) {
    return undefined;
  }

  const sessionDir = path.join(debugDir, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}

function resolveModelIdentifier(inputModel: string): ResolvedModelIdentifier {
  const trimmed = inputModel.trim();
  const mapped = MODEL_SHORTNAMES[trimmed.toLowerCase()] ?? trimmed;

  if (mapped.includes("/")) {
    const [provider, ...rest] = mapped.split("/");
    return {
      resolved: mapped,
      provider,
      modelId: rest.join("/"),
    };
  }

  if (mapped.startsWith("claude-")) {
    return {
      resolved: `anthropic/${mapped}`,
      provider: "anthropic",
      modelId: mapped,
    };
  }

  if (mapped.startsWith("gemini-")) {
    return {
      resolved: `google/${mapped}`,
      provider: "google",
      modelId: mapped,
    };
  }

  if (mapped.startsWith("gpt-") || mapped.startsWith("o1") || mapped.startsWith("o3")) {
    return {
      resolved: `openai/${mapped}`,
      provider: "openai",
      modelId: mapped,
    };
  }

  return {
    resolved: `anthropic/${mapped}`,
    provider: "anthropic",
    modelId: mapped,
  };
}

async function findSessionInfo(
  cwd: string,
  sessionId: string,
  sessionDir: string | undefined,
): Promise<SessionInfo | undefined> {
  const sessions = await SessionManager.list(cwd, sessionDir);
  return sessions.find((session) => session.id === sessionId);
}

function getApiKeySourceForProvider(provider: string): string {
  return getProviderCredentialStatus(provider).apiKeySource;
}

function createSessionManager(
  cwd: string,
  resumeSessionId: string | undefined,
  sessionDir: string | undefined,
): Promise<SessionManager> {
  if (!resumeSessionId) {
    return Promise.resolve(SessionManager.create(cwd, sessionDir));
  }

  return findSessionInfo(cwd, resumeSessionId, sessionDir).then((info) => {
    if (!info) {
      throw new StartupError(`Session not found: ${resumeSessionId}`);
    }
    return SessionManager.open(info.path, sessionDir);
  });
}

function rememberToolCall(
  nativeToolCallId: string,
  input: Record<string, unknown> | undefined,
  toolIdMap: Map<string, string>,
  toolMetaByNativeId: Map<string, ToolCallMeta>,
): ToolCallMeta {
  const existing = toolMetaByNativeId.get(nativeToolCallId);
  if (existing) {
    return existing;
  }

  const meta: ToolCallMeta = {
    publicId: ensurePublicToolId(nativeToolCallId, toolIdMap),
    input: normalizeToolInput(input),
  };
  toolMetaByNativeId.set(nativeToolCallId, meta);
  return meta;
}

export async function preparePiSession(options: {
  cwd: string;
  model: string;
  args: ShimArguments;
  verbose: boolean;
}): Promise<PreparedPiSession> {
  const { cwd, args, verbose } = options;
  const sessionDir = getSessionStorageDir(args.debugDir);
  const authStorage = configureAuthStorage();
  const modelRegistry = new ModelRegistry(authStorage);
  const { resolved, provider, modelId } = resolveModelIdentifier(options.model);

  if (shouldEnforceProviderCredential(provider) && !getProviderCredentialStatus(provider).available) {
    throw new StartupError(formatMissingApiKeyMessage(provider));
  }

  const resolvedModel = modelRegistry.find(provider, modelId);
  if (!resolvedModel) {
    throw new StartupError(
      `Model not found: ${options.model}. Try a provider/model identifier such as anthropic/claude-haiku-4-5.`,
    );
  }

  const sessionManager = await createSessionManager(cwd, args.resume, sessionDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    ...(args.appendSystemPrompt ? { appendSystemPrompt: args.appendSystemPrompt } : {}),
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    model: resolvedModel,
    tools: [
      createReadTool(cwd),
      createBashTool(cwd),
      createEditTool(cwd),
      createWriteTool(cwd),
      createGrepTool(cwd),
      createFindTool(cwd),
      createLsTool(cwd),
    ],
    sessionManager,
    authStorage,
    modelRegistry,
    resourceLoader,
  });

  const sessionId = args.resume ?? session.sessionId;
  if (!UUID_V4_REGEX.test(sessionId)) {
    throw new StartupError(`Pi returned a non-UUID session id: ${sessionId}`);
  }

  const debugRecorder = new DebugRecorder({
    debugDir: args.debugDir,
    sessionId,
    verbose,
  });

  debugRecorder.event({
    type: "init",
    session_id: sessionId,
    model: resolved,
    cwd,
    resumed: !!args.resume,
    sandbox: args.sandbox,
    timestamp: new Date().toISOString(),
  });
  debugRecorder.log(`Prepared session ${sessionId}`, {
    model: resolved,
    cwd,
    resumed: !!args.resume,
  });

  if (args.sandbox !== "none") {
    debugRecorder.log(
      `Sandbox level '${args.sandbox}' requested, but the embedded Pi SDK does not expose sandbox controls; continuing without additional sandboxing.`,
    );
  }

  return {
    session,
    sessionId,
    model: resolved,
    apiKeySource: getApiKeySourceForProvider(provider),
    debugRecorder,
    dispose() {
      session.dispose();
    },
  };
}

export async function runPiPrompt(
  prepared: PreparedPiSession,
  prompt: string,
  args: ShimArguments,
): Promise<SessionRunResult> {
  const promptStart = Date.now();
  const rawQueue = new SessionEventQueue<AgentSessionEvent>();
  const activityQueue = new SessionEventQueue<AgentSessionEvent>();
  const toolIdMap = new Map<string, string>();
  const toolMetaByNativeId = new Map<string, ToolCallMeta>();
  const initialStats = prepared.session.getSessionStats();

  prepared.debugRecorder.log(`Prompt started for session ${prepared.sessionId}`);

  let numTurns = 0;
  let watchdogError: Error | undefined;
  let streamedUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    total_cost_usd: 0,
  };

  const unsubscribe = prepared.session.subscribe((event: AgentSessionEvent) => {
    prepared.debugRecorder.event(event);
    rawQueue.push(event);

    if (isPiWatchdogActivityEvent(event)) {
      activityQueue.push(event);
    }

    if (event.type === "agent_end") {
      rawQueue.close();
      activityQueue.close();
    }
  });

  const promptPromise = prepared.session.prompt(prompt).then(
    () => {
      rawQueue.close();
      activityQueue.close();
    },
    (error) => {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      rawQueue.fail(normalizedError);
      activityQueue.fail(normalizedError);
      throw normalizedError;
    },
  );

  const watchdogPromise = (async () => {
    try {
      for await (const _event of withAdaptiveTimeout(activityQueue, {
        idleTimeoutMs: args.idleTimeout * 1000,
        busyTimeoutMs: Math.max(args.idleTimeout * 1000, 300_000),
        onEvent(event, controller) {
          applyPiWatchdogEvent(event, controller);
        },
      })) {
        // The watchdog exists only for timeout side effects.
      }
    } catch (error) {
      watchdogError = error instanceof Error ? error : new Error(String(error));
      rawQueue.fail(watchdogError);
      activityQueue.fail(watchdogError);
      await prepared.session.abort().catch(() => {});
    }
  })();

  try {
    for await (const event of rawQueue) {
      switch (event.type) {
        case "message_end": {
          const message = (event as { message: { role?: string } }).message;
          if (message.role !== "assistant") {
            break;
          }

          const assistantMessage = message as unknown as PiAssistantMessage;
          const content = Array.isArray(assistantMessage.content) ? assistantMessage.content : [];

          for (const block of content as PiContentBlock[]) {
            if (block.type === "toolCall" && block.id) {
              rememberToolCall(
                block.id,
                block.arguments,
                toolIdMap,
                toolMetaByNativeId,
              );
            }
          }

          const usage = assistantMessage.usage as PiUsage | undefined;
          if (usage) {
            streamedUsage = {
              input_tokens: streamedUsage.input_tokens + (usage.input ?? 0),
              output_tokens: streamedUsage.output_tokens + (usage.output ?? 0),
              cache_read_input_tokens:
                streamedUsage.cache_read_input_tokens + (usage.cacheRead ?? 0),
              cache_creation_input_tokens:
                streamedUsage.cache_creation_input_tokens + (usage.cacheWrite ?? 0),
              total_cost_usd: streamedUsage.total_cost_usd + (usage.cost?.total ?? 0),
            };
          }

          emitMessage(makeAssistantMessage(assistantMessage, prepared.model, toolIdMap));
          break;
        }

        case "tool_execution_start": {
          const toolEvent = event as {
            toolCallId: string;
            args: Record<string, unknown>;
          };
          rememberToolCall(toolEvent.toolCallId, toolEvent.args, toolIdMap, toolMetaByNativeId);
          break;
        }

        case "turn_end": {
          numTurns += 1;
          const toolResults = (event as { toolResults?: PiToolResultMessage[] }).toolResults ?? [];
          if (toolResults.length === 0) {
            break;
          }

          const translatedResults = toolResults.map((toolResult) => {
            const meta = rememberToolCall(
              toolResult.toolCallId,
              undefined,
              toolIdMap,
              toolMetaByNativeId,
            );
            const text = serializeToolResultContent(toolResult.content);
            const content = text.trim().length > 0
              ? text
              : fallbackToolResultContent(toolResult.toolName, meta.input, toolResult.isError);

            return {
              toolUseId: meta.publicId,
              content,
              isError: toolResult.isError,
            };
          });

          emitMessage(makeUserMessageWithToolResults(translatedResults));
          break;
        }
      }
    }

    await promptPromise.catch(() => {});
    await watchdogPromise;
    if (watchdogError) {
      throw watchdogError;
    }
  } catch (error) {
    await promptPromise.catch(() => {});
    await watchdogPromise;
    if (watchdogError) {
      prepared.debugRecorder.log(watchdogError.message);
      throw watchdogError;
    }
    throw error;
  } finally {
    unsubscribe();
  }

  const finalStats = prepared.session.getSessionStats();
  const usage = {
    input_tokens: Math.max(0, finalStats.tokens.input - initialStats.tokens.input),
    output_tokens: Math.max(0, finalStats.tokens.output - initialStats.tokens.output),
    cache_read_input_tokens: Math.max(0, finalStats.tokens.cacheRead - initialStats.tokens.cacheRead),
    cache_creation_input_tokens: Math.max(
      0,
      finalStats.tokens.cacheWrite - initialStats.tokens.cacheWrite,
    ),
  };

  const totalCostUsd = Math.max(0, finalStats.cost - initialStats.cost) || streamedUsage.total_cost_usd;
  const finalUsage = {
    input_tokens: usage.input_tokens || streamedUsage.input_tokens,
    output_tokens: usage.output_tokens || streamedUsage.output_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens || streamedUsage.cache_read_input_tokens,
    cache_creation_input_tokens:
      usage.cache_creation_input_tokens || streamedUsage.cache_creation_input_tokens,
  };

  prepared.debugRecorder.event({
    type: "result",
    status: "success",
    duration_api_ms: Date.now() - promptStart,
    num_turns: numTurns,
    total_cost_usd: totalCostUsd,
    usage: finalUsage,
    timestamp: new Date().toISOString(),
  });
  prepared.debugRecorder.log(`Prompt completed for session ${prepared.sessionId}`);

  return {
    totalCostUsd,
    usage: finalUsage,
    numTurns,
    durationApiMs: Date.now() - promptStart,
  };
}

export function validateResumeSessionId(sessionId: string): void {
  if (!UUID_V4_REGEX.test(sessionId)) {
    throw new StartupError(`Invalid session ID format: ${sessionId}. Expected UUID v4.`);
  }
}

export async function checkPiAvailability(): Promise<{
  available: boolean;
  version: string;
  apiKeyStatus: Record<string, boolean>;
  availableModels: string[];
}> {
  try {
    const authStorage = configureAuthStorage();
    const modelRegistry = new ModelRegistry(authStorage);
    const availableModels = modelRegistry
      .getAvailable()
      .slice(0, 10)
      .map((model) => `${model.provider}/${model.id}`);

    return {
      available: true,
      version: detectBundledPiVersion(),
      apiKeyStatus: getKnownApiKeyStatus(),
      availableModels,
    };
  } catch {
    return {
      available: false,
      version: "unknown",
      apiKeyStatus: getKnownApiKeyStatus(),
      availableModels: [],
    };
  }
}
