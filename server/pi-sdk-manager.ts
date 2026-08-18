import fs from "node:fs";
import path from "node:path";
import { setBedrockProviderModule } from "@earendil-works/pi-ai/api/bedrock-converse-stream.lazy";
import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { findEnvKeys } from "@earendil-works/pi-ai/compat";
import {
  type AgentSession,
  type BashSpawnContext,
  createAgentSession,
  createBashToolDefinition,
  DEFAULT_COMPACTION_SETTINGS,
  DefaultResourceLoader,
  ModelRuntime,
  VERSION as PI_VERSION,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { BaseProcessManager } from "./base-process-manager.js";
import type { ClaudeLogParser } from "./claude-log-parser.js";
import {
  ensurePublicToolId,
  makeAssistantMessage,
  makeCompactBoundary,
  makeResult,
  makeSystemInit,
  makeUserMessageWithToolResults,
  normalizeToolName,
  type PiAssistantMessage,
  type PiToolResultMessage,
  serializeToolResultContent,
} from "./pi-translation.js";
import { PromptBuilder } from "./prompt-builder.js";
import { AMAZON_BEDROCK_PROVIDER_ID, toPiTarget } from "./provider-ids.js";
import type { Codon, ShimSelfTestResult } from "./types/types.js";
import { IdleTimeoutError, type Logger, toError } from "./utils.js";

// Register pi's OAuth flows statically. pi-ai's lazyOAuth loaders import each
// flow module through a VARIABLE dynamic-import specifier — deliberately
// opaque to bundlers — so inside the compiled single-file binary
// (`bun build --compile`) the specifier resolves next to the bundle, the flow
// module doesn't exist, and every OAuth-authenticated provider request (e.g.
// openai-codex on a ChatGPT subscription) dies with "OAuth auth derivation
// failed". Static registration embeds the flows in every build shape; with
// node_modules present it is a no-op difference (same modules, loaded eagerly).
registerBunOAuthFlows();

// Same trap, Bedrock edition: pi-ai loads its amazon-bedrock implementation
// through the identical variable-specifier lazy import (to keep the Node-only
// AWS SDK out of browser bundles), so in the compiled binary every
// amazon-bedrock/* request would fail to load its provider while source runs
// work. pi-ai ships the "./bedrock-provider" subpath exactly for this —
// register the statically imported module; with node_modules present the
// override is the same module the lazy path would load.
setBedrockProviderModule(bedrockProviderModule);

/** Pi tools the in-process session is allowed to use. */
const PI_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/**
 * Default idle timeout for Pi sessions, in seconds.
 *
 * The removed pi shim binary applied its own internal 120s default (and the
 * config schema documents 120s for non-Anthropic providers). The in-process
 * manager must supply that fallback itself, or an unset shimIdleTimeout
 * disables the watchdog entirely and a silent provider or hung tool blocks
 * the workflow indefinitely. Mirrors DEFAULT_SDK_IDLE_TIMEOUT_SECONDS in
 * ClaudeAgentSDKManager (180s there — SDK events are coarser-grained).
 */
export const DEFAULT_PI_IDLE_TIMEOUT_SECONDS = 120;

/**
 * Minimum silence allowed while pi reports a busy step (turn or tool call in
 * flight) before the watchdog fires: max(idleTimeout, this). The removed pi
 * shim's withAdaptiveTimeout used the same 300s floor — a legitimate build or
 * test command can produce no events for far longer than the 120s idle
 * default, and aborting it mid-run corrupts the codon for no reason.
 */
export const PI_BUSY_TIMEOUT_MS = 300_000;

interface ProviderCredentialConfig {
  envVars: readonly string[];
  apiKeySource: string;
  runtimeProvider: string;
}

/**
 * Env vars that supply per-provider credentials to the embedded Pi SDK.
 * Mirrors the pi runtime's provider catalog; providers not listed here (e.g.
 * ones the user configured directly in pi's own credential store) are let
 * through without enforcement.
 */
const PROVIDER_CREDENTIALS: Record<string, ProviderCredentialConfig> = {
  anthropic: {
    envVars: ["ANTHROPIC_API_KEY"],
    apiKeySource: "ANTHROPIC_API_KEY",
    runtimeProvider: "anthropic",
  },
  google: {
    envVars: ["GEMINI_API_KEY"],
    apiKeySource: "env",
    runtimeProvider: "google",
  },
  openai: {
    envVars: ["OPENAI_API_KEY"],
    apiKeySource: "env",
    runtimeProvider: "openai",
  },
  openrouter: {
    envVars: ["OPENROUTER_API_KEY"],
    apiKeySource: "env",
    runtimeProvider: "openrouter",
  },
  zai: {
    envVars: ["ZAI_API_KEY"],
    apiKeySource: "env",
    runtimeProvider: "zai",
  },
};

function getConfiguredEnvValue(
  envVars: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const envVar of envVars) {
    const value = env[envVar]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * Resolve the API key hankweave would hand the embedded pi runtime for a
 * provider. Single source of truth for the accepted env-var spellings —
 * google uses GEMINI_API_KEY (pi's native variable for its google provider;
 * the legacy GOOGLE_API_KEY alias was removed). The welcome wizard uses this
 * same resolution so key detection, credit validation, and the pi session all
 * see one key value.
 */
export function resolveProviderApiKey(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const config = PROVIDER_CREDENTIALS[provider.toLowerCase()];
  if (!config) return undefined;
  return getConfiguredEnvValue(config.envVars, env);
}

/** Env delta applied wherever the in-process pi session reads an environment. */
export interface EnvOverlay {
  set: Record<string, string>;
  unset: string[];
}

/**
 * Compute the env delta the removed pi shim's child process used to inherit:
 * HANKWEAVE_-prefixed server vars pass through with the prefix stripped
 * (HANKWEAVE_RUNTIME_* server config and HANKWEAVE_SENTINEL_* secrets are
 * excluded; the literal value "unset" deletes the target var), then codon.env
 * overlays on top. The pi session runs in-process, so there is no child env to
 * build — the overlay is applied at the points the session reads an
 * environment: provider credential resolution and the bash tool's spawn env.
 */
export function buildEnvOverlay(codonEnv?: Record<string, string>): EnvOverlay {
  const set: Record<string, string> = {};
  const unset: string[] = [];
  for (const key in process.env) {
    if (
      key.startsWith("HANKWEAVE_") &&
      !key.startsWith("HANKWEAVE_RUNTIME_") &&
      !key.startsWith("HANKWEAVE_SENTINEL_")
    ) {
      const newKey = key.substring("HANKWEAVE_".length);
      const value = process.env[key];
      if (value === "unset") {
        unset.push(newKey);
      } else if (value !== undefined) {
        set[newKey] = value;
      }
    }
  }
  if (codonEnv) Object.assign(set, codonEnv);
  return { set, unset };
}

/** Apply an overlay to a base env without mutating it. codon.env wins over "unset". */
export function applyEnvOverlay(base: NodeJS.ProcessEnv, overlay: EnvOverlay): NodeJS.ProcessEnv {
  const env = { ...base, ...overlay.set };
  for (const key of overlay.unset) {
    if (!(key in overlay.set)) delete env[key];
  }
  return env;
}

/**
 * pi ≥0.80.8 replaced the synchronous AuthStorage/ModelRegistry pair with the
 * async ModelRuntime facade. Runtime API keys are an in-memory overlay on top
 * of the runtime's credential store, so env-provided keys take precedence over
 * anything on disk while still letting pi's dynamic provider catalogs refresh.
 * `runtime` is a test seam: production callers let it default to a fresh
 * ModelRuntime.create().
 */
export async function configureModelRuntime(
  env: NodeJS.ProcessEnv = process.env,
  runtime?: ModelRuntime,
): Promise<ModelRuntime> {
  const modelRuntime = runtime ?? (await ModelRuntime.create());
  const enforcedProviders = new Set<string>();
  for (const config of Object.values(PROVIDER_CREDENTIALS)) {
    enforcedProviders.add(config.runtimeProvider);
    const value = getConfiguredEnvValue(config.envVars, env);
    if (value) {
      await modelRuntime.setRuntimeApiKey(config.runtimeProvider, value);
    }
  }
  // Pi resolves every OTHER provider's key itself (deepseek, groq, xai, …) —
  // but from the real process.env. A key that exists only in the effective
  // codon env (codon.env / HANKWEAVE_-prefixed pass-through) must be injected
  // as a runtime key or the in-process session never sees it; the removed
  // shim's child process inherited these naturally. getProviders() is the full
  // composed catalog (built-ins + models.json config + extension-registered);
  // getRegisteredProviderIds() covers only extension registrations, which is
  // empty here (noExtensions) and would skip every built-in. Injection is
  // limited to values that differ from process.env so pi's own precedence
  // between env keys and its on-disk credential store is otherwise untouched.
  // findEnvKeys reports only real API-key vars (never OAuth tokens or ambient
  // AWS/ADC credentials), so the injected value is always a genuine API key.
  for (const { id: providerId } of modelRuntime.getProviders()) {
    if (enforcedProviders.has(providerId)) continue;
    const envVar = findEnvKeys(providerId, env as Record<string, string>)?.[0];
    if (!envVar) continue;
    const value = env[envVar]?.trim();
    if (!value || process.env[envVar]?.trim() === value) continue;
    await modelRuntime.setRuntimeApiKey(providerId, value);
  }
  return modelRuntime;
}

const MODEL_SHORTNAMES: Record<string, string> = {
  sonnet: "anthropic/claude-sonnet-4-6",
  haiku: "anthropic/claude-haiku-4-5",
  opus: "anthropic/claude-opus-4-7",
};

export function resolveModelIdentifier(input: string): {
  provider: string;
  modelId: string;
  resolved: string;
} {
  const trimmed = input.trim();
  const mapped = MODEL_SHORTNAMES[trimmed.toLowerCase()] ?? trimmed;

  if (mapped.includes("/")) {
    const [provider, ...rest] = mapped.split("/");
    return { provider, modelId: rest.join("/"), resolved: mapped };
  }
  if (mapped.startsWith("gemini-")) {
    return { provider: "google", modelId: mapped, resolved: `google/${mapped}` };
  }
  if (mapped.startsWith("gpt-") || mapped.startsWith("o1") || mapped.startsWith("o3")) {
    return { provider: "openai", modelId: mapped, resolved: `openai/${mapped}` };
  }
  // Bare claude-* etc. default to anthropic.
  return { provider: "anthropic", modelId: mapped, resolved: `anthropic/${mapped}` };
}

/**
 * The exact catalog gate spawn applies to a pi route: direct lookup, then the
 * reasoning-effort fallback. "<id>-high"/"-xhigh" are registry constructs, not
 * catalog ids — resolve the base model and carry the effort as pi's
 * thinkingLevel (the removed codex shim did the same via
 * model_reasoning_effort). Unsuffixed OpenAI models default to high reasoning:
 * pi's default is medium, and migrated hanks expect the shim's high.
 *
 * Shared by spawn and the self-test's model_catalog check so the two can never
 * disagree: pi's catalog is a static vendored snapshot plus
 * ~/.pi/agent/models.json, so a miss at self-test time is deterministically a
 * miss at launch.
 */
export function lookupPiModel(
  runtime: ModelRuntime,
  provider: string,
  modelId: string,
): { model: ReturnType<ModelRuntime["getModel"]>; thinkingLevel?: "high" | "xhigh" } {
  let model = runtime.getModel(provider, modelId);
  let thinkingLevel: "high" | "xhigh" | undefined;
  if (!model) {
    const effortMatch = /^(.*)-(xhigh|high)$/.exec(modelId);
    if (effortMatch) {
      const base = runtime.getModel(provider, effortMatch[1]);
      if (base) {
        model = base;
        thinkingLevel = effortMatch[2] as "high" | "xhigh";
      }
    }
  }
  if (!thinkingLevel && provider === "openai") thinkingLevel = "high";
  return { model, thinkingLevel };
}

/** Cap a catalog id list for an error message: sorted, first 12, "+N more". */
function formatCatalogSample(ids: readonly string[]): string {
  const sorted = [...ids].sort();
  const shown = sorted.slice(0, 12);
  const rest = sorted.length - shown.length;
  return shown.join(", ") + (rest > 0 ? ` (+${rest} more)` : "");
}

/**
 * In-process Pi coding-agent manager. The Pi SDK is a Bun-compatible JS module,
 * so we run it inside the hankweave process — exactly like ClaudeAgentSDKManager
 * runs the Claude SDK — instead of spawning a shim child and talking JSONL over
 * pipes. Pi session events are translated to claude-session-schema JSONL
 * (pi-translation.ts) so the runtime's ClaudeLogParser consumes them unchanged.
 */
export class PiSdkManager extends BaseProcessManager {
  private session: AgentSession | undefined;
  private logStream: fs.WriteStream | undefined;
  private killed = false;
  private disposed = false;
  private sessionId: string | undefined;
  private syntheticPid: number | undefined;
  private runPromise: Promise<void> | undefined;
  private promptBuilder: PromptBuilder;

  /** native pi tool-call id → schema-valid public id (shared across translation). */
  private toolIdMap = new Map<string, string>();
  private startedAt = 0;
  private usageTotalCostUsd = 0;
  /**
   * Aggregate token usage across the pi turn, summed per assistant message
   * like usageTotalCostUsd. Emitted on the terminal result because
   * CostTracker.handleResultUsage() discards a usage-less result — including
   * its total_cost_usd, which for passthrough models absent from the pricing
   * registry is the only authoritative cost.
   */
  private usageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  private numTurns = 0;
  private lastActivity = 0;
  /**
   * Whether pi last reported a busy step (turn/tool in flight) or a settled
   * state. Drives the adaptive watchdog limit in runPrompt — mirrors the
   * removed shim's applyPiWatchdogEvent busy/idle tracking.
   */
  private activityState: "idle" | "busy" = "idle";
  /**
   * Final outcome of the pi turn. Pi surfaces LLM failures in-band: when its
   * internal retries exhaust (or the session is aborted), session.prompt()
   * RESOLVES and the failure only shows up as the last assistant message's
   * stopReason/errorMessage. Tracked here so runPrompt can emit an error
   * result instead of reporting success.
   */
  private lastStopReason: string | undefined;
  private lastErrorMessage: string | undefined;

  constructor(
    private executionPath: string,
    private agentRootPath: string,
    logger: Logger,
    logParser: ClaudeLogParser,
    private globalSystemPrompt?: string | null,
    private defaultShimIdleTimeout?: number,
  ) {
    super(logger, logParser);
    this.promptBuilder = new PromptBuilder(agentRootPath, logger, globalSystemPrompt);
  }

  get promptFrontmatter(): import("./prompt-frontmatter.js").PromptFrontmatter | undefined {
    return this.promptBuilder.getLastFrontmatter();
  }

  async spawn(
    codon: Codon,
    sessionToResume: string | null,
    options?: { logPath?: string; exhaustionPrompt?: string },
  ): Promise<string> {
    if (this.session) {
      throw new Error("Pi session already running");
    }
    const { logPath, exhaustionPrompt } = options ?? {};
    const isExhaustionMode = !!exhaustionPrompt;

    const actualLogPath =
      logPath || path.join(this.executionPath, `.hankweave/logs/log-${codon.id}-pi.jsonl`);
    fs.mkdirSync(path.dirname(actualLogPath), { recursive: true });
    this.logStream = fs.createWriteStream(
      actualLogPath,
      isExhaustionMode ? { flags: "a" } : undefined,
    );

    this.killed = false;
    this.disposed = false;
    this.lastStopReason = undefined;
    this.lastErrorMessage = undefined;
    this.activityState = "idle";
    // usageTotalCostUsd/usageTotals/numTurns are deliberately NOT reset:
    // exhaustion extensions respawn on the same instance, and the terminal
    // result's cost/usage must be cumulative because CodonFinalCostSet
    // OVERWRITES the codon's currentCost with the result's absolute value.
    this.startedAt = Date.now();
    this.syntheticPid = 900000 + Math.floor(Math.random() * 99999);

    const promptContent = this.promptBuilder.buildPromptForExecution(codon, exhaustionPrompt);
    const resumeId = isExhaustionMode ? sessionToResume : this.resumeIdFor(codon, sessionToResume);

    // Effective environment for this codon: HANKWEAVE_ pass-through + codon.env,
    // matching what the removed shim child process inherited.
    const envOverlay = buildEnvOverlay(codon.env);
    const effectiveEnv = applyEnvOverlay(process.env, envOverlay);

    // The resume-session lookup stays a hard throw (unlike the setup failures
    // below): a missing continuation session must fail the codon outright —
    // see makeSessionManager.
    const sessionDir = path.join(this.executionPath, ".hankweave/logs/pi-sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionManager = await this.makeSessionManager(this.agentRootPath, resumeId, sessionDir);

    // Resolve model + credentials for the embedded SDK. Failures from here
    // through session construction are routed through scheduleSetupFailure —
    // the error-result/exit(1) path — instead of thrown, so the codon's
    // onFailure policy applies (a throw from spawn() escalates as a runner
    // initialization exception that bypasses resolveFailurePolicy).
    // The pi routing string ("<provider>/<model>", aliases + OpenRouter
    // re-routing applied) is derived HERE from the model's real identity —
    // late-bound, never persisted — so routing-rule changes apply to resumed
    // plans too.
    const { provider, modelId, resolved } = resolveModelIdentifier(
      toPiTarget(codon.model.providerId, codon.model.modelId),
    );
    const credentialConfig = PROVIDER_CREDENTIALS[provider.toLowerCase()];
    let session: AgentSession;
    try {
      if (credentialConfig && !getConfiguredEnvValue(credentialConfig.envVars, effectiveEnv)) {
        throw new Error(
          `Missing API key for provider '${provider}'. Set ${credentialConfig.envVars.join(" or ")}.`,
        );
      }
      const modelRuntime = await configureModelRuntime(effectiveEnv);
      const { model: resolvedModel, thinkingLevel } = lookupPiModel(
        modelRuntime,
        provider,
        modelId,
      );
      if (!resolvedModel) {
        throw new Error(
          `Pi model not found: ${codon.model.modelId} (provider=${provider}, model=${modelId})`,
        );
      }

      // Pi's resource loader needs an agent dir for agent-level config. We disable
      // all filesystem-discovered resources (extensions/skills/prompts/themes), so
      // this just needs to be a valid, isolated directory.
      const agentDir = path.join(this.executionPath, ".hankweave/logs/pi-agent");
      fs.mkdirSync(agentDir, { recursive: true });

      const systemPrompt = this.promptBuilder.buildSystemPrompt(codon);
      const resourceLoader = new DefaultResourceLoader({
        cwd: this.agentRootPath,
        agentDir,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        ...(systemPrompt ? { appendSystemPrompt: [systemPrompt] } : {}),
      });
      await resourceLoader.reload();

      // Custom tools registered via customTools replace same-named built-ins in
      // pi's tool registry, so this bash tool (with the codon's effective env
      // overlaid onto pi's shell env — preserving pi's PATH additions) supplants
      // the built-in one. Without it, agent commands run with the server's
      // unmodified process env and never see codon.env / HANKWEAVE_ pass-through.
      // The schema-typed definition doesn't assign to the untyped ToolDefinition
      // customTools expects (render-callback contravariance); the registry only
      // consumes it through the untyped interface.
      const bashTool = createBashToolDefinition(this.agentRootPath, {
        spawnHook: (context: BashSpawnContext) => ({
          ...context,
          env: applyEnvOverlay(context.env, envOverlay),
        }),
      }) as unknown as ToolDefinition;

      // Hermetic per-session settings: pi must NOT read the developer's
      // ~/.pi/agent/settings.json (compaction, retry, steering...) — two
      // machines running the same hank would otherwise behave differently.
      // SettingsManager.inMemory never touches disk. Compaction is gated by
      // the codon's autoCompact field and is OFF by default: the provider's
      // context-overflow error must surface (isContextExceeded Pattern 2)
      // instead of pi silently rewriting the session mid-run. NEVER use
      // session.setAutoCompactionEnabled() — it persists to the settings
      // file of the pi config dir (the user's real one in production).
      const settingsManager = SettingsManager.inMemory({
        compaction: { ...DEFAULT_COMPACTION_SETTINGS, enabled: codon.autoCompact === true },
      });

      ({ session } = await createAgentSession({
        cwd: this.agentRootPath,
        model: resolvedModel,
        tools: PI_TOOLS,
        customTools: [bashTool],
        sessionManager,
        settingsManager,
        modelRuntime,
        resourceLoader,
        ...(thinkingLevel ? { thinkingLevel } : {}),
      }));
    } catch (error) {
      this.scheduleSetupFailure(toError(error), resolved);
      return actualLogPath;
    }
    this.session = session;
    this.sessionId = session.sessionId;

    this.logger.log(`Starting in-process Pi session for codon ${codon.id} (model: ${resolved})`);
    this.logger.log(`Working directory: ${this.agentRootPath}`);
    this.logger.log(`Session id: ${this.sessionId} (resume: ${resumeId ?? "none"})`);

    // Emit the system init message first (parser learns session id / tools / model).
    this.emitMessage(
      makeSystemInit({
        sessionId: this.sessionId ?? "unknown",
        cwd: this.agentRootPath,
        model: resolved,
        tools: PI_TOOLS.map(normalizeToolName),
        apiKeySource: credentialConfig
          ? getConfiguredEnvValue(credentialConfig.envVars, effectiveEnv)
            ? credentialConfig.apiKeySource
            : "none"
          : "none",
      }),
      false,
    );

    this.subscribe(session, resolved);

    const idleTimeout =
      codon.shimIdleTimeout ?? this.defaultShimIdleTimeout ?? DEFAULT_PI_IDLE_TIMEOUT_SECONDS;
    this.runPromise = this.runPrompt(session, promptContent, resolved, idleTimeout);
    this.runPromise.catch((error) => {
      this.logger.log(`Pi session error: ${toError(error).message}`, "error");
      this.cleanup();
      this.emit("error", toError(error));
    });

    return actualLogPath;
  }

  /**
   * Route a spawn-time setup failure (missing credential, unresolvable model,
   * session construction error) through the same error-result + exit(1) path
   * as in-band pi failures. Throwing out of spawn() instead would surface as a
   * CodonRunner initialization exception, which the runtime records as
   * non-retriable and rethrows without consulting resolveFailurePolicy — so a
   * configured onFailure: "ignore"/"retry" would never apply. Deferred to a
   * macrotask so CodonRunner.run() and the runtime's post-spawn transitions
   * finish before the exit fires (matching how runPrompt failures arrive).
   * The error text feeds classifyApiErrorText via the result message, so e.g.
   * a missing API key still classifies as a permanent auth failure.
   */
  private scheduleSetupFailure(error: Error, model: string): void {
    this.logger.log(`Pi session setup failed: ${error.message}`, "error");
    this.runPromise = new Promise<void>((resolve) => {
      setImmediate(() => {
        void (async () => {
          await this.emitResult(true, model, error.message);
          this.cleanup();
          this.emitExit(1);
          resolve();
        })();
      });
    });
  }

  /**
   * Busy/idle tracking for the adaptive watchdog — mirrors the removed shim's
   * applyPiWatchdogEvent: any step/tool/retry/compaction progress marks busy,
   * turn/agent end settles back to idle.
   */
  private applyActivityState(eventType: string): void {
    switch (eventType) {
      case "turn_start":
      case "message_start":
      case "message_update":
      case "message_end":
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
      case "auto_retry_start":
      case "auto_retry_end":
      case "compaction_start":
      case "compaction_end":
        this.activityState = "busy";
        break;
      case "turn_end":
      case "agent_end":
        this.activityState = "idle";
        break;
    }
  }

  /** Subscribe to pi session events and translate them to claude-schema JSONL. */
  private subscribe(session: AgentSession, model: string): void {
    // biome-ignore lint/suspicious/noExplicitAny: event shape is internal to the pi SDK
    session.subscribe((event: any) => {
      this.lastActivity = Date.now();
      this.applyActivityState(String(event.type));
      try {
        if (event.type === "message_end") {
          const message = event.message as { role?: string } | undefined;
          if (message?.role !== "assistant") return;
          const piMessage = message as unknown as PiAssistantMessage;
          this.lastStopReason = piMessage.stopReason;
          this.lastErrorMessage = piMessage.errorMessage;
          const usage = piMessage.usage;
          if (usage?.cost?.total) this.usageTotalCostUsd += usage.cost.total;
          if (usage) {
            this.usageTotals.input += usage.input ?? 0;
            this.usageTotals.output += usage.output ?? 0;
            this.usageTotals.cacheRead += usage.cacheRead ?? 0;
            this.usageTotals.cacheWrite += usage.cacheWrite ?? 0;
          }
          this.emitMessage(makeAssistantMessage(piMessage, model, this.toolIdMap), true);
        } else if (event.type === "turn_end") {
          this.numTurns += 1;
          const toolResults = (event.toolResults ?? []) as PiToolResultMessage[];
          if (toolResults.length === 0) return;
          const translated = toolResults.map((r) => {
            const publicId = ensurePublicToolId(r.toolCallId, this.toolIdMap);
            const text = serializeToolResultContent(r.content);
            return {
              toolUseId: publicId,
              content: text.length > 0 ? text : `(${r.toolName} ${r.isError ? "failed" : "ok"})`,
              isError: r.isError,
            };
          });
          this.emitMessage(makeUserMessageWithToolResults(translated), false);
        } else if (event.type === "compaction_end") {
          // Pi compacted the session: its context window filled. Emit the
          // Claude-schema compact_boundary marker so isContextExceeded
          // (Pattern 3) fires for pi exactly like for the Claude SDK — this is
          // the signal `terminateOn: {type: "contextExceeded"}` waits for.
          // Token counts live on the event's CompactionResult (pi's
          // compaction_end carries no top-level token fields); the marker is
          // valid without them.
          this.emitMessage(
            makeCompactBoundary({
              sessionId: this.sessionId ?? "unknown",
              trigger: event.reason === "manual" ? "manual" : "auto",
              preTokens:
                typeof event.result?.tokensBefore === "number"
                  ? event.result.tokensBefore
                  : undefined,
              postTokens:
                typeof event.result?.estimatedTokensAfter === "number"
                  ? event.result.estimatedTokensAfter
                  : undefined,
            }),
            true,
          );
        }
      } catch (error) {
        this.logger.log(`Pi event translation failed: ${toError(error).message}`, "error");
      }
    });
  }

  /** Drive the prompt to completion with an idle-timeout watchdog. */
  private async runPrompt(
    session: AgentSession,
    prompt: string,
    model: string,
    idleTimeoutSec?: number,
  ): Promise<void> {
    this.lastActivity = Date.now();
    let watchdog: ReturnType<typeof setInterval> | undefined;
    let timedOut = false;

    const idlePromise = new Promise<never>((_resolve, reject) => {
      if (!idleTimeoutSec) return;
      watchdog = setInterval(() => {
        // While pi reports a busy step (turn/tool in flight), allow
        // max(idleTimeout, 300s) of silence — a legitimate build/test command
        // emits no events for minutes. Idle gets the plain idle limit.
        const limitMs =
          this.activityState === "busy"
            ? Math.max(idleTimeoutSec * 1000, PI_BUSY_TIMEOUT_MS)
            : idleTimeoutSec * 1000;
        if (Date.now() - this.lastActivity > limitMs) {
          timedOut = true;
          reject(new IdleTimeoutError(limitMs));
        }
      }, 1000);
      // Deliberately not unref'd: an unref'd interval is the only timer alive
      // during pure silence, and Bun's Windows event loop never wakes to fire
      // it (hanging the wait forever). The finally block always clears it, so
      // it cannot hold the process open.
    });

    try {
      await Promise.race([session.prompt(prompt), idlePromise]);
      // prompt() resolves even when the turn failed: retry exhaustion and
      // aborts surface as the final assistant message's stopReason. An abort
      // during kill() is intentional teardown, not a failure (matches the
      // Claude SDK manager's killed → exit 0 path).
      const failed =
        this.lastStopReason === "error" || (this.lastStopReason === "aborted" && !this.killed);
      if (failed) {
        const errorText =
          this.lastErrorMessage || `Pi session ended with stopReason '${this.lastStopReason}'`;
        this.logger.log(`[PI-runPrompt] Pi turn failed in-band: ${errorText}`, "error");
        await this.emitResult(true, model, errorText);
        this.cleanup();
        this.emitExit(1);
        return;
      }
      await this.emitResult(false, model);
      this.cleanup();
      this.emitExit(0);
    } catch (error) {
      if (timedOut || error instanceof IdleTimeoutError) {
        const timeoutError =
          error instanceof IdleTimeoutError
            ? error
            : new IdleTimeoutError((idleTimeoutSec ?? 0) * 1000);
        this.logger.log(`[PI-runPrompt] ${timeoutError.message}`, "error");
        this.abortSession();
        // Carry the timeout text into the result so CodonRunner classifies a
        // "timeout" failure (type + duration) instead of a generic API error.
        await this.emitResult(true, model, timeoutError.message);
        this.cleanup();
        this.emitExit(1);
        return;
      }
      this.logger.log(`[PI-runPrompt] CAUGHT ERROR: ${toError(error).message}`, "error");
      this.cleanup();
      throw error;
    } finally {
      if (watchdog) clearInterval(watchdog);
    }
  }

  /**
   * Write the terminal result message and wait for it to flush. The flush
   * matters — emitExit() synchronously re-parses the log file, so a buffered
   * result would be invisible to it: resultMessageReceived would stay false
   * (blocking extension) and an error result's text would never classify a
   * failureReason. Mirrors ClaudeAgentSDKManager.writeSyntheticErrorResult.
   */
  private emitResult(isError: boolean, _model: string, errorText?: string): Promise<void> {
    // The error text feeds classifyApiErrorText in CodonRunner — pass the real
    // upstream message so retriability (429 vs auth/billing) classifies right.
    return this.writeLogLine(
      makeResult({
        isError,
        sessionId: this.sessionId ?? "unknown",
        numTurns: this.numTurns,
        durationMs: Date.now() - this.startedAt,
        durationApiMs: Date.now() - this.startedAt,
        totalCostUsd: this.usageTotalCostUsd,
        result: isError ? errorText || "Pi session ended with error" : "",
        usage: this.usageTotals,
      }),
    );
  }

  /** Write a claude-schema line to the log; resolves once flushed to the file. */
  private writeLogLine(message: Record<string, unknown>): Promise<void> {
    if (!this.logStream || this.logStream.destroyed) return Promise.resolve();
    const line = `${JSON.stringify({ ...message, timestamp: new Date().toISOString() })}\n`;
    return new Promise((resolve) => {
      this.logStream?.write(line, () => resolve());
    });
  }

  /** Write a claude-schema message to the log; optionally surface on "stdout". */
  private emitMessage(message: Record<string, unknown>, toStdout: boolean): void {
    void this.writeLogLine(message);
    if (toStdout) this.emit("stdout", JSON.stringify(message));
  }

  private resumeIdFor(codon: Codon, sessionToResume: string | null): string | null {
    return codon.continuationMode === "continue-previous" ? sessionToResume : null;
  }

  /**
   * A requested resume session MUST be found — a continuation or exhaustion
   * prompt without its history would silently "succeed" with a blank
   * conversation. The removed pi shim hard-failed here (StartupError:
   * "Session not found"); a throw from spawn() restores that, failing the
   * codon instead. Sessions written by the pre-reorg shim live under
   * .hankweave/logs/shim-debug/sessions, so that directory is searched as a
   * fallback (the shim ran with cwd=agentRootPath, so pi's cwd filter still
   * matches); a legacy match is opened against the current sessionDir.
   */
  private async makeSessionManager(
    cwd: string,
    resumeId: string | null,
    sessionDir: string,
  ): Promise<SessionManager> {
    if (!resumeId) return SessionManager.create(cwd, sessionDir);
    const legacySessionDir = path.join(this.executionPath, ".hankweave/logs/shim-debug/sessions");
    for (const dir of [sessionDir, legacySessionDir]) {
      const sessions = await SessionManager.list(cwd, dir);
      const info = sessions.find((s) => s.id === resumeId);
      if (info) {
        if (dir === legacySessionDir) {
          this.logger.log(`Resuming pre-reorg pi shim session from ${info.path}`);
        }
        return SessionManager.open(info.path, sessionDir);
      }
    }
    throw new Error(
      `Pi session not found: ${resumeId} (searched ${sessionDir} and ${legacySessionDir}). ` +
        `Refusing to start a fresh session for a continuation.`,
    );
  }

  private abortSession(): void {
    try {
      this.session?.abort?.();
    } catch {
      // best-effort
    }
  }

  async kill(_signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (!this.session || this.killed) return;
    this.killed = true;
    this.logParser.parseNow();
    this.abortSession();
    if (this.runPromise) {
      await Promise.race([
        this.runPromise.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
    this.cleanup();
  }

  async forceKill(): Promise<void> {
    this.killed = true;
    this.abortSession();
    this.cleanup();
  }

  private cleanup(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.session?.dispose?.();
    } catch {
      // best-effort
    }
    this.session = undefined;
    if (this.logStream && !this.logStream.destroyed) {
      this.logStream.end();
      this.logStream = undefined;
    }
    this.runPromise = undefined;
    this.syntheticPid = undefined;
  }

  isRunning(): boolean {
    return this.session !== undefined && !this.killed;
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  /**
   * Whether a pi session was created (session id captured from
   * createAgentSession). Mirrors ClaudeAgentSDKManager.getSessionEstablished:
   * a synchronous, race-free establishment signal that survives cleanup().
   * CodonRunner uses it to gate crash retriability — pi writes its init
   * message asynchronously and the log parser starts delayed, so the
   * parser-fed flag can lag a genuine establishment when session.prompt()
   * rejects immediately.
   */
  getSessionEstablished(): boolean {
    return this.sessionId !== undefined;
  }

  getPid(): number | undefined {
    return this.syntheticPid;
  }

  async closeLogStream(): Promise<void> {
    if (this.logStream && !this.logStream.destroyed) {
      this.logStream.end();
      this.logStream = undefined;
    }
  }

  /**
   * Verify the embedded Pi SDK environment: SDK importable and, when a model id
   * is given, credentials configured for its provider. Mirrors
   * ClaudeAgentSDKManager.runSelfTest.
   */
  async runSelfTest(modelId?: string): Promise<ShimSelfTestResult> {
    this.logger.log("Running Pi SDK self-test", "info");
    const checks: ShimSelfTestResult["checks"] = [];
    // Self-test has no codon, but the HANKWEAVE_ pass-through still applies —
    // a key supplied only as HANKWEAVE_OPENAI_API_KEY must not fail the check.
    const effectiveEnv = applyEnvOverlay(process.env, buildEnvOverlay());

    // Check 1: the SDK is importable (statically imported — reaching here proves it).
    checks.push({
      name: "sdk_installed",
      passed: true,
      message: `Pi coding-agent SDK found (version ${PI_VERSION})`,
    });

    // Check 2: model runtime can be constructed (provider catalogs load).
    let runtime: ModelRuntime | undefined;
    try {
      runtime = await configureModelRuntime(effectiveEnv);
      checks.push({
        name: "model_runtime",
        passed: true,
        message: "Pi ModelRuntime initialized",
      });
    } catch (error) {
      checks.push({
        name: "model_runtime",
        passed: false,
        message: `Pi ModelRuntime failed to initialize: ${toError(error).message}`,
      });
    }

    // Check 3: credentials for the target provider (when known).
    if (modelId) {
      const { provider, modelId: targetModelId } = resolveModelIdentifier(modelId);
      const credentialConfig = PROVIDER_CREDENTIALS[provider.toLowerCase()];
      if (credentialConfig) {
        const available = !!getConfiguredEnvValue(credentialConfig.envVars, effectiveEnv);
        checks.push({
          name: "authentication",
          passed: available,
          message: available
            ? `Credentials configured for provider '${provider}'`
            : `Missing API key for provider '${provider}'. Set ${credentialConfig.envVars.join(" or ")}.`,
        });
      } else if (provider.toLowerCase() === AMAZON_BEDROCK_PROVIDER_ID && runtime) {
        // pi refuses Bedrock requests outright when its auth resolution finds
        // nothing ("Provider is not configured: amazon-bedrock"), so run that
        // same resolution now instead of passing preflight and failing at
        // first invoke. checkAuth covers pi's credential store plus its
        // ambient env markers — NOT on-disk config files or IMDS, which pi's
        // bedrock provider does not consult.
        const auth = await runtime.checkAuth(AMAZON_BEDROCK_PROVIDER_ID).catch(() => undefined);
        checks.push({
          name: "authentication",
          passed: auth !== undefined,
          message: auth
            ? `Bedrock: AWS credentials via ${auth.source ?? "pi credential store"}`
            : "No AWS credentials visible to pi for Bedrock. Quickest: set " +
              "AWS_BEARER_TOKEN_BEDROCK (AWS Console → Bedrock → API keys → long-term key). " +
              "Enterprise: set AWS_PROFILE after `aws sso login`, or AWS_ACCESS_KEY_ID + " +
              "AWS_SECRET_ACCESS_KEY. Also set AWS_REGION. An on-disk default profile or " +
              "instance role alone is not detected on this route.",
        });
      } else {
        checks.push({
          name: "authentication",
          passed: true,
          message: `Provider '${provider}' not credential-enforced; pi resolves credentials itself`,
        });
      }

      // Check 4: the target model exists in pi's catalog — the same gate spawn
      // applies (lookupPiModel), run at startup so a catalog miss surfaces at
      // config load instead of after earlier codons have already run and spent
      // money. Stage 1 of validation is the registry (identity/capabilities in
      // validateModel); this is stage 2, against the catalog that actually
      // decides pi runnability.
      if (runtime) {
        const { model } = lookupPiModel(runtime, provider, targetModelId);
        let message: string;
        if (model) {
          message = `Model '${provider}/${targetModelId}' found in pi's catalog`;
        } else {
          const available = runtime.getModels(provider).map((m) => m.id);
          message =
            available.length > 0
              ? `Pi model not found: ${provider}/${targetModelId}. ` +
                `Available '${provider}' models: ${formatCatalogSample(available)}`
              : `Unknown pi provider '${provider}'. ` +
                `Known providers: ${formatCatalogSample(runtime.getProviders().map((p) => p.id))}`;
        }
        checks.push({ name: "model_catalog", passed: model !== undefined, message });
      }
    }

    const allPassed = checks.every((check) => check.passed);
    const result: ShimSelfTestResult = {
      shim: { name: "pi-sdk-manager", version: PI_VERSION },
      agent: { name: "pi-coding-agent", version: PI_VERSION, found: true },
      checks,
      overall: {
        passed: allPassed,
        message: allPassed ? "All checks passed" : "Some checks failed",
      },
    };

    this.logger.log(
      `Self-test completed: ${result.overall.passed ? "PASSED" : "FAILED"}`,
      result.overall.passed ? "info" : "error",
    );
    return result;
  }
}
