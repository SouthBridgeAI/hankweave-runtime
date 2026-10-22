import fs from "node:fs";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
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
  type ModelRuntime,
  VERSION as PI_VERSION,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { BaseProcessManager } from "./base-process-manager.js";
import type { ClaudeLogParser } from "./claude-log-parser.js";
import { ExecutionLayout } from "./execution-layout.js";
import { HANKWEAVE_ENV_UNSET, hankweaveEnvEntries } from "./hankweave-env.js";
import { readUserModelsJson } from "./harness/pi/routing.js";
import { effortBase, type HarnessCheckResult, type HarnessCheckStep } from "./llm/index.js";
import { isModelCatalogOffline } from "./model-catalog-settings.js";
import {
  createPiModelRuntime,
  freezePiModelsStore,
  injectPiModel,
  refreshPiProvider,
} from "./pi-model-catalog.js";
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
import { AMAZON_BEDROCK_PROVIDER_ID, pricingProviderId, toPiTarget } from "./provider-ids.js";
import { RuntimeLock } from "./runtime-lock.js";
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

export { PI_VERSION };

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
 * Env vars whose keys hankweave hands the embedded Pi SDK as runtime keys
 * (they then take precedence over pi's on-disk credential store). Not a
 * credential gate: whether a provider has credentials is pi's own answer
 * (ModelRuntime.checkAuth), for every provider — see checkPiModel.
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
  for (const { name, value } of hankweaveEnvEntries()) {
    if (value === HANKWEAVE_ENV_UNSET) {
      unset.push(name);
    } else {
      set[name] = value;
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
 * A trimmed key value present in the effective env but not, with the same
 * value, in the real process.env — i.e. one only the codon env supplies.
 */
function codonOnlyEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  if (!value || process.env[name]?.trim() === value) return undefined;
  return value;
}

/** Hand hankweave's own credential env vars to the runtime; returns their provider ids. */
async function setHankweaveProviderKeys(
  modelRuntime: ModelRuntime,
  env: NodeJS.ProcessEnv,
): Promise<Set<string>> {
  const enforcedProviders = new Set<string>();
  for (const config of Object.values(PROVIDER_CREDENTIALS)) {
    enforcedProviders.add(config.runtimeProvider);
    const value = getConfiguredEnvValue(config.envVars, env);
    if (value) {
      await modelRuntime.setRuntimeApiKey(config.runtimeProvider, value);
    }
  }
  return enforcedProviders;
}

/**
 * Pi resolves every OTHER provider's key itself (deepseek, groq, xai, …) —
 * but from the real process.env. A key that exists only in the effective
 * codon env (codon.env / HANKWEAVE_-prefixed pass-through) must be injected
 * as a runtime key or the in-process session never sees it; the removed
 * shim's child process inherited these naturally. getProviders() is the full
 * composed catalog (built-ins + models.json config + extension-registered);
 * getRegisteredProviderIds() covers only extension registrations, which is
 * empty here (noExtensions) and would skip every built-in. Injection is
 * limited to values that differ from process.env so pi's own precedence
 * between env keys and its on-disk credential store is otherwise untouched.
 * findEnvKeys reports only real API-key vars (never OAuth tokens or ambient
 * AWS/ADC credentials), so the injected value is always a genuine API key.
 */
async function setCodonEnvProviderKeys(
  modelRuntime: ModelRuntime,
  env: NodeJS.ProcessEnv,
  enforcedProviders: ReadonlySet<string>,
): Promise<void> {
  for (const { id: providerId } of modelRuntime.getProviders()) {
    if (enforcedProviders.has(providerId)) continue;
    const envVar = findEnvKeys(providerId, env as Record<string, string>)?.[0];
    const value = envVar ? codonOnlyEnvValue(env, envVar) : undefined;
    if (!value) continue;
    await modelRuntime.setRuntimeApiKey(providerId, value);
  }
}

/** The user's models.json provider blocks; none when it is missing or invalid. */
function userModelsProviders(): Record<string, unknown> {
  const user = readUserModelsJson();
  return user && user !== "invalid" ? (user.providers ?? {}) : {};
}

/** The env var a models.json apiKey of the form "$NAME" or "${NAME}" names. */
function apiKeyTemplateVar(apiKey: unknown): string | undefined {
  if (typeof apiKey !== "string") return undefined;
  const template = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(apiKey);
  return template?.[1] ?? template?.[2];
}

/**
 * Providers the user's models.json defines name their key as "$NAME" or
 * "${NAME}", which pi interpolates from process.env only; a key the codon
 * supplies in its env block is handed over the same way as above.
 */
async function setUserModelsProviderKeys(
  modelRuntime: ModelRuntime,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  for (const [providerId, config] of Object.entries(userModelsProviders())) {
    const name = apiKeyTemplateVar((config as { apiKey?: unknown }).apiKey);
    const value = name ? codonOnlyEnvValue(env, name) : undefined;
    if (!value) continue;
    await modelRuntime.setRuntimeApiKey(providerId, value);
  }
}

/**
 * pi ≥0.80.8 replaced the synchronous AuthStorage/ModelRegistry pair with the
 * async ModelRuntime facade. Runtime API keys are an in-memory overlay on top
 * of the runtime's credential store, so env-provided keys take precedence over
 * anything on disk. The runtime reads hankweave-owned catalog inputs (see
 * pi-model-catalog.ts) and never touches the network itself. `runtime` is a
 * test seam: production callers let it default to createPiModelRuntime().
 */
export async function configureModelRuntime(
  env: NodeJS.ProcessEnv = process.env,
  runtime?: ModelRuntime,
): Promise<ModelRuntime> {
  const modelRuntime = runtime ?? (await createPiModelRuntime());
  const enforcedProviders = await setHankweaveProviderKeys(modelRuntime, env);
  await setCodonEnvProviderKeys(modelRuntime, env, enforcedProviders);
  await setUserModelsProviderKeys(modelRuntime, env);
  return modelRuntime;
}

/**
 * Split a pi routing string ("<provider>/<model>", from toPiTarget) into its
 * parts. A string without a provider has an empty one: nothing is inferred.
 */
export function resolveModelIdentifier(input: string): {
  provider: string;
  modelId: string;
  resolved: string;
} {
  const mapped = input.trim();
  const slash = mapped.indexOf("/");
  if (slash < 0) return { provider: "", modelId: mapped, resolved: mapped };
  return {
    provider: mapped.substring(0, slash),
    modelId: mapped.substring(slash + 1),
    resolved: mapped,
  };
}

/**
 * The exact catalog gate spawn applies to a pi route: direct lookup, then the
 * reasoning-effort fallback. "<id>-high"/"-xhigh" are registry constructs, not
 * catalog ids — resolve the base model and carry the effort as pi's
 * thinkingLevel (the removed codex shim did the same via
 * model_reasoning_effort). Unsuffixed OpenAI models default to high reasoning:
 * pi's default is medium, and migrated hanks expect the shim's high.
 */
export function lookupPiModel(
  runtime: ModelRuntime,
  provider: string,
  modelId: string,
): { model: Model<Api> | undefined; thinkingLevel?: "high" | "xhigh" } {
  let model = runtime.getModel(provider, modelId);
  let thinkingLevel: "high" | "xhigh" | undefined;
  if (!model) {
    const effortMatch = /^(.*)-(xhigh|high)$/.exec(modelId);
    if (effortMatch) {
      const base = runtime.getModel(provider, effortMatch[1]);
      // Only a reasoning model has effort levels: "gpt-4o-xhigh" is not gpt-4o.
      if (base?.reasoning) {
        model = base;
        thinkingLevel = effortMatch[2] as "high" | "xhigh";
      }
    }
  }
  if (!thinkingLevel && provider === "openai") thinkingLevel = "high";
  return { model, thinkingLevel };
}

interface PiModelResolution {
  runtime: ModelRuntime;
  model: Model<Api> | undefined;
  thinkingLevel?: "high" | "xhigh";
  /** Found only after refreshing the provider from pi.dev. */
  refreshed: boolean;
  /** Why pi.dev could not be asked, when the refresh failed. */
  refreshError?: string;
}

/**
 * Configure a runtime and find the route's model: direct lookup, then a
 * bounded pi.dev refresh of the provider on a miss (when online model checks
 * are on). Shared by spawn and checkPiModel so the two can never disagree. A
 * model pi lacks but hankweave's catalog knows was added to this process's
 * pi catalog when it was checked at startup (Models adoption → injectPiModel).
 */
async function resolvePiRuntimeModel(
  env: NodeJS.ProcessEnv,
  provider: string,
  modelId: string,
  options: { network: boolean; timeoutMs?: number; logger?: Logger; requireAuth?: boolean },
): Promise<PiModelResolution> {
  const runtime = await configureModelRuntime(env);
  // Credentials first, as checkPiModel asks them: a provider with none must
  // not wait on a pi.dev refresh before failing.
  if (options.requireAuth && !(await runtime.checkAuth(provider).catch(() => undefined))) {
    throw new Error(piNoCredentialsMessage(provider));
  }
  const found = lookupPiModel(runtime, provider, modelId);
  if (found.model) return { runtime, ...found, refreshed: false };
  let refreshError: string | undefined;
  await refreshPiProvider(runtime, provider, modelId, {
    ...options,
    onError: (error) => {
      refreshError = toError(error).message;
    },
  });
  const after = lookupPiModel(runtime, provider, modelId);
  return { runtime, ...after, refreshed: after.model !== undefined, refreshError };
}

/** Cap a catalog id list for an error message: sorted, first 12, "+N more". */
function formatCatalogSample(ids: readonly string[]): string {
  const sorted = [...ids].sort();
  const shown = sorted.slice(0, 12);
  const rest = sorted.length - shown.length;
  return shown.join(", ") + (rest > 0 ? ` (+${rest} more)` : "");
}

/** Every env var pi reads an API key for this provider from, API-key names first. */
function piKeyEnvVars(provider: string): string[] {
  const everySet = new Proxy({}, { get: () => "set" }) as Record<string, string>;
  const names = findEnvKeys(provider, everySet) ?? [];
  return [...names].sort((a, b) => Number(b.endsWith("_API_KEY")) - Number(a.endsWith("_API_KEY")));
}

const BEDROCK_CREDENTIALS_HELP =
  "No AWS credentials visible to pi for Bedrock. Quickest: set " +
  "AWS_BEARER_TOKEN_BEDROCK (AWS Console → Bedrock → API keys → long-term key). " +
  "Enterprise: set AWS_PROFILE after `aws sso login`, or AWS_ACCESS_KEY_ID + " +
  "AWS_SECRET_ACCESS_KEY. Also set AWS_REGION. An on-disk default profile or " +
  "instance role alone is not detected on this route.";

/** Class E for the Pi route: what is missing and where Pi looked. */
function piNoCredentialsMessage(provider: string): string {
  if (provider === AMAZON_BEDROCK_PROVIDER_ID) return BEDROCK_CREDENTIALS_HELP;
  const vars = piKeyEnvVars(provider);
  const where = "checked the environment, this codon's env block and Pi's auth store";
  return vars.length > 0
    ? `No credentials for provider '${provider}' (${where}). Set ${vars.join(" or ")}, or add the key in Pi's auth store.`
    : `No credentials for provider '${provider}' (${where}). Configure credentials for '${provider}' in Pi's auth store (pi login).`;
}

/** Pi's catalog row as harness evidence for pricing and limits. */
function piRow(model: Model<Api>): NonNullable<Extract<HarnessCheckResult, { ok: true }>["row"]> {
  return {
    id: model.id,
    name: model.name,
    cost: {
      input: model.cost.input,
      output: model.cost.output,
      cache_read: model.cost.cacheRead,
      cache_write: model.cost.cacheWrite,
    },
    limit: { context: model.contextWindow, output: model.maxTokens },
    reasoning: model.reasoning,
    input: [...model.input],
  };
}

/**
 * Can Pi run provider/model here, with this environment (spec 72, stage 2)?
 * In order: Pi's runtime starts (class G otherwise); pi has credentials for
 * the provider — env, codon env, or its own auth store (class E); pi's
 * catalog lists the model, after a bounded pi.dev refresh of the provider
 * when online (class C). Used by PiModelCheck at startup and by
 * PiSdkManager.runSelfTest.
 */
export async function checkPiModel(
  provider: string,
  modelId: string,
  env: NodeJS.ProcessEnv,
  options: { network: boolean; timeoutMs?: number; logger?: Logger },
): Promise<HarnessCheckResult> {
  const steps: HarnessCheckStep[] = [
    {
      name: "sdk_installed",
      passed: true,
      message: `Pi coding-agent SDK found (version ${PI_VERSION})`,
    },
  ];
  // This run reads its own copy of pi's hosted catalog from here on.
  freezePiModelsStore(options.logger);
  let runtime: ModelRuntime;
  try {
    runtime = await configureModelRuntime(env);
  } catch (error) {
    const message = `Pi's runtime failed to initialize: ${toError(error).message}`;
    steps.push({ name: "model_runtime", passed: false, message });
    return { ok: false, kind: "harness-unavailable", message, candidates: [], steps };
  }
  steps.push({ name: "model_runtime", passed: true, message: "Pi ModelRuntime initialized" });

  if (!runtime.getProvider(provider)) {
    const known = runtime.getProviders().map((p) => p.id);
    const message = `Pi has no provider '${provider}'. Pi's providers: ${formatCatalogSample(known)}.`;
    steps.push({ name: "authentication", passed: false, message });
    return { ok: false, kind: "unknown-model", message, candidates: [], steps };
  }
  const auth = await runtime.checkAuth(provider).catch(() => undefined);
  if (!auth) {
    const message = piNoCredentialsMessage(provider);
    steps.push({ name: "authentication", passed: false, message });
    return { ok: false, kind: "no-credentials", message, candidates: [], steps };
  }
  steps.push({
    name: "authentication",
    passed: true,
    message: `Credentials for provider '${provider}' via ${auth.source ?? "pi's auth store"}`,
  });

  const target = `${provider}/${modelId}`;
  const resolution = await resolvePiRuntimeModel(env, provider, modelId, options);
  if (!resolution.model && resolution.refreshError) {
    // Class F: Pi's own catalog lacks it and pi.dev could not be asked.
    const message =
      `Could not check '${target}' with Pi: pi.dev did not answer (${resolution.refreshError}). ` +
      "Fix the network, or run with noOnlineModelChecks to validate from cached catalogs only.";
    steps.push({ name: "model_catalog", passed: false, message });
    return { ok: false, kind: "unreachable", message, candidates: [], steps };
  }
  if (!resolution.model) {
    const known = resolution.runtime.getModels(provider).map((m) => m.id);
    const checked =
      options.network && !isModelCatalogOffline()
        ? "its catalog and pi.dev"
        : "its catalog; online model checks are off";
    // Pi's ids go out as candidates; Models ranks the closest into the message.
    const message =
      `Pi has no model '${target}' (checked ${checked}).` +
      " A model newer than Pi's catalog that hankweave's catalog lists (models.dev, or a 'models' block entry for a provider the catalog has) is added to Pi's catalog from its newest sibling.";
    steps.push({ name: "model_catalog", passed: false, message });
    return {
      ok: false,
      kind: "unknown-model",
      message,
      candidates: known.map((id) => `${provider}/${id}`),
      steps,
    };
  }
  const evidence = resolution.refreshed ? "pi.dev" : "pi catalog";
  steps.push({
    name: "model_catalog",
    passed: true,
    message: `Model '${target}' found in pi's catalog${resolution.refreshed ? " after refreshing it from pi.dev" : ""}`,
  });
  return { ok: true, evidence, row: piRow(resolution.model), steps };
}

/** What spawn resolved for a codon before building its pi session. */
interface PiSpawnContext {
  codon: Codon;
  provider: string;
  modelId: string;
  /** The pi routing string, "<provider>/<model>". */
  resolved: string;
  envOverlay: EnvOverlay;
  effectiveEnv: NodeJS.ProcessEnv;
}

/**
 * Whether spawn may re-adopt a model record pi's catalog lacks: only a record
 * the registries or the user vouch for, as at startup. Never for a provider
 * priced under another (openai-codex as openai): startup never adopts those
 * either.
 */
function isAdoptableRecord(model: Codon["model"], provider: string): boolean {
  const confidence = model.provenance?.confidence;
  return (
    (confidence === "registry" || confidence === "user") && pricingProviderId(provider) === provider
  );
}

/**
 * Custom tools registered via customTools replace same-named built-ins in
 * pi's tool registry, so this bash tool (with the codon's effective env
 * overlaid onto pi's shell env — preserving pi's PATH additions) supplants
 * the built-in one. Without it, agent commands run with the server's
 * unmodified process env and never see codon.env / HANKWEAVE_ pass-through.
 * The schema-typed definition doesn't assign to the untyped ToolDefinition
 * customTools expects (render-callback contravariance); the registry only
 * consumes it through the untyped interface.
 */
function createCodonBashTool(cwd: string, envOverlay: EnvOverlay): ToolDefinition {
  return createBashToolDefinition(cwd, {
    spawnHook: (context: BashSpawnContext) => ({
      ...context,
      env: applyEnvOverlay(context.env, envOverlay),
    }),
  }) as unknown as ToolDefinition;
}

/** The init message's apiKeySource: hankweave's env var for the provider, if set. */
function piApiKeySource(provider: string, env: NodeJS.ProcessEnv): string {
  const config = PROVIDER_CREDENTIALS[provider.toLowerCase()];
  if (!config) return "none";
  return getConfiguredEnvValue(config.envVars, env) ? config.apiKeySource : "none";
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
  private unregisterShutdownHook: (() => void) | undefined;
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
    this.promptBuilder = new PromptBuilder(
      agentRootPath,
      new ExecutionLayout(executionPath).dataPathInExecutionDir,
      logger,
      globalSystemPrompt,
    );
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

    const actualLogPath = this.openLogStream(codon, logPath, isExhaustionMode);
    this.resetForSpawn();

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
    // The pi routing string ("<provider>/<model>", the identity as written)
    // is derived HERE from the model's real identity —
    // late-bound, never persisted — so routing-rule changes apply to resumed
    // plans too.
    const { provider, modelId, resolved } = resolveModelIdentifier(
      toPiTarget(codon.model.providerId, codon.model.modelId),
    );
    const context: PiSpawnContext = {
      codon,
      provider,
      modelId,
      resolved,
      envOverlay,
      effectiveEnv,
    };
    let session: AgentSession;
    try {
      session = await this.createSession(context, sessionManager);
    } catch (error) {
      this.scheduleSetupFailure(toError(error), resolved);
      return actualLogPath;
    }
    this.startSession(session, context, resumeId, promptContent);
    return actualLogPath;
  }

  /** Open this codon's JSONL log (appending for an exhaustion extension); returns its path. */
  private openLogStream(
    codon: Codon,
    logPath: string | undefined,
    isExhaustionMode: boolean,
  ): string {
    const actualLogPath =
      logPath || path.join(this.executionPath, `.hankweave/logs/log-${codon.id}-pi.jsonl`);
    fs.mkdirSync(path.dirname(actualLogPath), { recursive: true });
    this.logStream = fs.createWriteStream(
      actualLogPath,
      isExhaustionMode ? { flags: "a" } : undefined,
    );
    return actualLogPath;
  }

  /** Reset per-turn state before a spawn. */
  private resetForSpawn(): void {
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
  }

  /**
   * Resolve the codon's model and build its pi session. Throws on any setup
   * failure; spawn routes those through scheduleSetupFailure.
   */
  private async createSession(
    context: PiSpawnContext,
    sessionManager: SessionManager,
  ): Promise<AgentSession> {
    const { codon } = context;
    const {
      runtime: modelRuntime,
      model: resolvedModel,
      thinkingLevel,
    } = await this.resolveSpawnModel(context);
    const resourceLoader = await this.createResourceLoader(codon);
    const bashTool = createCodonBashTool(this.agentRootPath, context.envOverlay);

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

    const { session } = await createAgentSession({
      cwd: this.agentRootPath,
      model: resolvedModel,
      tools: PI_TOOLS,
      customTools: [bashTool],
      sessionManager,
      settingsManager,
      modelRuntime,
      resourceLoader,
      ...(thinkingLevel ? { thinkingLevel } : {}),
    });
    return session;
  }

  /**
   * Find the codon's model in a configured runtime, re-adopting a record pi's
   * catalog lacks. Throws "Pi model not found" when neither yields it.
   */
  private async resolveSpawnModel(
    context: PiSpawnContext,
  ): Promise<PiModelResolution & { model: Model<Api> }> {
    const { codon, provider, modelId, effectiveEnv } = context;
    const resolveOptions = {
      network: !isModelCatalogOffline(),
      logger: this.logger,
      // Startup confirmed credentials (checkPiModel); asking again here
      // catches a resumed plan whose provider has none in this env.
      requireAuth: true,
    };
    let resolution = await resolvePiRuntimeModel(effectiveEnv, provider, modelId, resolveOptions);
    // A resumed plan's model that was adopted into pi's catalog when its
    // run started lives only in that process's models.json: adopt it again
    // from the persisted record — the base's, unscaled, for an effort
    // variant — with a sibling chosen from pi's own models.
    if (!resolution.model && isAdoptableRecord(codon.model, provider)) {
      const base = effortBase(codon.model);
      const injected = injectPiModel(
        resolution.runtime,
        provider,
        base.modelId,
        base,
        [],
        this.logger,
      );
      if (injected.ok) {
        resolution = await resolvePiRuntimeModel(effectiveEnv, provider, modelId, resolveOptions);
      }
    }
    const { model } = resolution;
    if (!model) {
      throw new Error(
        `Pi model not found: ${codon.model.modelId} (provider=${provider}, model=${modelId})`,
      );
    }
    return { ...resolution, model };
  }

  /** A resource loader with every filesystem-discovered resource disabled. */
  private async createResourceLoader(codon: Codon): Promise<DefaultResourceLoader> {
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
    return resourceLoader;
  }

  /** Adopt a built session: shutdown hook, init message, event stream, prompt run. */
  private startSession(
    session: AgentSession,
    context: PiSpawnContext,
    resumeId: string | null,
    promptContent: string,
  ): void {
    const { codon, resolved } = context;
    this.session = session;
    this.unregisterShutdownHook = RuntimeLock.registerShutdownHook(() => {
      // Pi aborts its active tool signal before its first await. Bash handles
      // that signal by killing the detached process group synchronously on POSIX.
      // Do not call kill()/cleanup(): those parse logs and flush protected files.
      this.abortSession();
    });
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
        apiKeySource: piApiKeySource(context.provider, context.effectiveEnv),
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
      void this.session?.abort?.()?.catch(() => {});
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
    this.unregisterShutdownHook?.();
    this.unregisterShutdownHook = undefined;
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
   * Verify the embedded Pi SDK environment: SDK importable, the runtime
   * starts, and, when a model id is given, credentials for its provider and
   * the model in pi's catalog — the same checks startup model validation runs
   * (checkPiModel).
   */
  async runSelfTest(modelId?: string): Promise<ShimSelfTestResult> {
    this.logger.log("Running Pi SDK self-test", "info");
    // Self-test has no codon, but the HANKWEAVE_ pass-through still applies —
    // a key supplied only as HANKWEAVE_OPENAI_API_KEY must not fail the check.
    const effectiveEnv = applyEnvOverlay(process.env, buildEnvOverlay());
    let checks: ShimSelfTestResult["checks"];
    if (modelId) {
      const { provider, modelId: targetModelId } = resolveModelIdentifier(modelId);
      const result = await checkPiModel(provider, targetModelId, effectiveEnv, {
        network: !isModelCatalogOffline(),
        logger: this.logger,
      });
      checks = result.steps ?? [];
    } else {
      checks = [
        {
          name: "sdk_installed",
          passed: true,
          message: `Pi coding-agent SDK found (version ${PI_VERSION})`,
        },
      ];
      try {
        await configureModelRuntime(effectiveEnv);
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
