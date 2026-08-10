import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Options, query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  BEDROCK_DEFAULT_REGION,
  defaultProfileDefinesRegion,
  describeAmbientAwsCredentialSource,
  detectInstanceMetadataCredentials,
} from "./aws-credentials.js";
import { BaseProcessManager } from "./base-process-manager.js";
import type { ClaudeLogParser } from "./claude-log-parser.js";
import {
  CLAUDE_SDK_VERSION,
  extractClaudeSdkFiles,
  getExtractedCliPath,
  needsExtraction,
} from "./claude-runtime-extractor.js";
import { TIMEOUTS } from "./config.js";
import { PromptBuilder } from "./prompt-builder.js";
import type { Codon, ShimSelfTestResult } from "./types/types.js";
import type { Logger } from "./utils.js";
import { IdleTimeoutError, isCompiledExecutable, toError, withIdleTimeout } from "./utils.js";

/**
 * Error thrown when Claude executable cannot be found.
 * This allows callers to handle this specific case.
 */
export class ClaudeExecutableNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeExecutableNotFoundError";
  }
}

/**
 * Default stream-inactivity timeout for SDK sessions, in seconds.
 *
 * Unlike the shim binaries (which apply their own internal 120s default), the
 * SDK path historically had NO inactivity bound when shimIdleTimeout was
 * unset — a hung streaming connection would sit silent until the OS killed
 * the socket. SDK messages arrive at message granularity (not per token), so 180s of total silence
 * reliably indicates a dead stream rather than a slow turn.
 */
export const DEFAULT_SDK_IDLE_TIMEOUT_SECONDS = 180;

/**
 * Whether lenient ("legacy") Claude auth is enabled via HW_INTERNAL_CLAUDE_LEGACY_AUTH.
 *
 * When enabled, the pre-flight self-test does NOT hard-require ANTHROPIC_API_KEY and instead
 * trusts the Agent SDK to resolve credentials itself — including the SDK's fallback to a local
 * Claude Code login (macOS Keychain `Claude Code-credentials` / `~/.claude/.credentials.json`).
 *
 * Intended for local/dev use on a machine already logged in via `claude login`. CI and
 * production should still set ANTHROPIC_API_KEY (the supported, ToS-compliant path).
 */
export function isLegacyClaudeAuthEnabled(): boolean {
  const v = process.env.HW_INTERNAL_CLAUDE_LEGACY_AUTH;
  if (!v) return false;
  return !["0", "false", "no", "off"].includes(v.trim().toLowerCase());
}

/**
 * Detect an installed Claude executable.
 * Checks common installation locations and falls back to `which claude`.
 *
 * @returns Path to Claude executable, or null if not found
 */
export function detectClaudeExecutable(): string | null {
  const possiblePaths = [
    // Installed via curl installer (cline)
    path.join(os.homedir(), ".cline/cli/bin/claude"),
    // Installed via claude installer
    path.join(os.homedir(), ".claude/local/claude"),
    // Homebrew installation (macOS)
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];

  // Check known paths
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // Try `which claude` as fallback
  try {
    const whichResult = execSync("which claude", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (whichResult && fs.existsSync(whichResult)) {
      return whichResult;
    }
  } catch {
    // which claude failed, that's okay
  }

  return null;
}

/**
 * The settings tiers the Agent SDK child actually loads: the user settings
 * file (CLAUDE_CONFIG_DIR override honored) — the SDK runs with
 * settingSources: ["user"] — plus managed (enterprise policy/MDM) settings,
 * which the CLI always applies regardless of settingSources, from a fixed
 * per-platform location. Project settings are excluded by settingSources, so
 * they aren't consulted here either.
 */
function claudeSettingsFilePaths(): string[] {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const managedSettingsPath =
    process.platform === "darwin"
      ? "/Library/Application Support/ClaudeCode/managed-settings.json"
      : process.platform === "win32"
        ? path.join(
            process.env.ProgramData || "C:\\ProgramData",
            "ClaudeCode",
            "managed-settings.json",
          )
        : "/etc/claude-code/managed-settings.json";
  return [path.join(configDir, "settings.json"), managedSettingsPath];
}

/**
 * Whether the Claude CLI's own settings define an Agent-managed AWS
 * credential helper (awsAuthRefresh / awsCredentialExport). With one
 * configured, the CLI fetches or refreshes Bedrock credentials itself, so
 * no ambient credential source exists for preflight to see. Consults the
 * same settings cascade the SDK child resolves (user + managed), so an
 * enterprise-supplied helper doesn't fail preflight on a machine with no
 * ambient credentials. `settingsFiles` is a test seam.
 */
export function claudeSettingsDefineAwsCredentialHelpers(
  settingsFiles: string[] = claudeSettingsFilePaths(),
): boolean {
  return settingsFiles.some((file) => {
    try {
      const settings = JSON.parse(fs.readFileSync(file, "utf-8"));
      return Boolean(settings?.awsAuthRefresh || settings?.awsCredentialExport);
    } catch {
      return false;
    }
  });
}

/**
 * Manages Claude Agent SDK lifecycle, mimicking the ClaudeProcessManager API.
 * Handles log stream creation and converts SDK messages to JSONL format.
 */
/**
 * AWS variables handed to the Agent SDK subprocess in Bedrock mode only —
 * every credential source of the standard AWS chain (bearer token, key pair,
 * profile/SSO, ECS container creds, IRSA web identity) plus region and config
 * locations. Enumerated, not a prefix rule: non-Bedrock codons must see a
 * byte-identical environment to before Bedrock support existed.
 */
const BEDROCK_AWS_ENV_VARS = [
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONFIG_FILE",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  // EKS Pod Identity (and any token-protected full-URI endpoint) needs the
  // authorization token alongside the URI, or the subprocess can't fetch creds.
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_EC2_METADATA_DISABLED",
  // Custom/IPv6 IMDS endpoints: the child's SDK chain must target the same
  // metadata endpoint the preflight probe resolved.
  "AWS_EC2_METADATA_SERVICE_ENDPOINT",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE",
  "AWS_CA_BUNDLE",
] as const;

// Moved to aws-credentials.ts so the sentinel provider registry shares the
// same detection; re-exported to keep this module's public surface stable.
export { BEDROCK_DEFAULT_REGION, describeAmbientAwsCredentialSource };

export class ClaudeAgentSDKManager extends BaseProcessManager {
  private abortController: AbortController | undefined;
  private logStream: fs.WriteStream | undefined;
  private killed = false;
  private sessionId: string | undefined;
  private syntheticPid: number | undefined;
  private queryPromise: Promise<void> | undefined;
  private promptBuilder: PromptBuilder;

  constructor(
    private executionPath: string,
    private agentRootPath: string,
    logger: Logger,
    logParser: ClaudeLogParser,
    private anthropicBaseUrl?: string,
    private globalSystemPrompt?: string | null,
    private defaultShimIdleTimeout?: number,
    /**
     * Amazon Bedrock mode: run the Agent SDK against Bedrock-hosted Anthropic
     * models (CLAUDE_CODE_USE_BEDROCK=1 + AWS credentials from the ambient
     * environment) instead of the Anthropic API.
     */
    private bedrockMode: boolean = false,
  ) {
    super(logger, logParser);
    this.promptBuilder = new PromptBuilder(agentRootPath, logger, globalSystemPrompt);
  }

  /** Frontmatter metadata from the prompt file (if any) */
  get promptFrontmatter(): import("./prompt-frontmatter.js").PromptFrontmatter | undefined {
    return this.promptBuilder.getLastFrontmatter();
  }

  /**
   * Ensure Claude SDK files are available, extracting if necessary.
   *
   * This static method should be called at application startup before creating
   * any ClaudeAgentSDKManager instances. It handles:
   * - Detecting if running from compiled executable or source
   * - Extracting embedded SDK files for compiled mode
   * - Verifying extracted files exist
   * - Setting CLAUDE_PATH_TO_CLAUDE_EXECUTABLE environment variable
   *
   * @returns Path to cli.js if compiled (and sets env var), or null if running from source
   * @throws Error if extraction fails or extracted file doesn't exist
   */
  static async ensureSdkAvailable(): Promise<{
    path: string | null;
    version: string;
    cached: boolean;
  }> {
    try {
      const isCompiled = isCompiledExecutable();

      // If we're not compiled, return null to use normal detection (node_modules)
      if (!isCompiled) {
        return { path: null, version: "node_modules", cached: true };
      }

      // Check if we already have extracted files
      let cliPath: string;
      let cached = false;
      if (!needsExtraction()) {
        cliPath = getExtractedCliPath();
        cached = true;
      } else {
        // Need to extract
        cliPath = await extractClaudeSdkFiles();
      }

      // Verify the extracted file actually exists
      if (!fs.existsSync(cliPath)) {
        throw new Error(
          `Extracted Claude CLI not found at: ${cliPath}\nThis indicates a problem with the compilation or extraction process.`,
        );
      }

      // Set environment variable so SDK knows where to find the CLI
      process.env.CLAUDE_PATH_TO_CLAUDE_EXECUTABLE = cliPath;

      return { path: cliPath, version: CLAUDE_SDK_VERSION, cached };
    } catch (error) {
      console.error(`❌ Claude SDK extraction failed: ${(error as Error).message}`);
      if ((error as Error).stack) {
        console.error(`   Stack: ${(error as Error).stack}`);
      }
      throw error;
    }
  }

  /**
   * Spawn a Claude Agent SDK session for the given codon configuration.
   * Sets up logging, environment, and message handling.
   *
   * This unified method handles both normal codon execution and exhaustion extensions.
   * From Claude's perspective, both are identical: resume a session with a new prompt.
   * The difference is only where the prompt comes from.
   *
   * @param codon - Codon configuration (not Loop - loops must be expanded first)
   * @param sessionToResume - Session ID to resume (if any). When provided with exhaustionPrompt,
   *                          always resumes regardless of codon.continuationMode.
   * @param options - Optional spawn configuration
   * @param options.logPath - Custom log file path (defaults to .hankweave/logs/)
   * @param options.exhaustionPrompt - If provided, activates exhaustion mode: uses this prompt
   *                                   instead of codon config, appends to log, forces resume.
   */
  async spawn(
    codon: Codon,
    sessionToResume: string | null,
    options?: {
      logPath?: string;
      exhaustionPrompt?: string;
    },
  ): Promise<string> {
    if (this.abortController) {
      throw new Error("Session already running");
    }

    const { logPath, exhaustionPrompt } = options ?? {};
    const isExhaustionMode = !!exhaustionPrompt;

    // Use provided logPath or default to .hankweave/logs/
    const actualLogPath =
      logPath || path.join(this.executionPath, `.hankweave/logs/log-${codon.id}-sdk.jsonl`);

    // Ensure log directory exists
    const logsDir = path.dirname(actualLogPath);
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    // Create log stream - append mode for exhaustion (extensions continue the same log)
    this.logStream = fs.createWriteStream(
      actualLogPath,
      isExhaustionMode ? { flags: "a" } : undefined,
    );

    // Build prompt content
    const promptContent = this.promptBuilder.buildPromptForExecution(codon, exhaustionPrompt);

    // Create abort controller BEFORE building SDK options so the SDK receives
    // our controller instance. Previously this was created after buildSDKOptions(),
    // meaning the SDK got undefined and created its own internal controller that
    // our kill() → abort() could never reach.
    this.abortController = new AbortController();
    this.killed = false;

    // Build Claude Agent SDK options
    // In exhaustion mode with sessionToResume, always resume
    // Otherwise, respect codon.continuationMode (normal case)
    const sdkOptions = this.buildSDKOptions(codon, isExhaustionMode ? null : sessionToResume);

    // Force resume when in exhaustion mode with a session to resume
    if (sessionToResume && isExhaustionMode) {
      sdkOptions.continue = true;
      sdkOptions.resume = sessionToResume;
    }

    this.logger.log(`Starting Claude Agent SDK for codon ${codon.id}`);
    this.logger.log(`Working directory: ${this.executionPath}`);
    this.logger.log(`Session to resume: ${sessionToResume || "none"}`);
    this.logger.log(`Prompt content (${promptContent.length} chars):\n${promptContent}`);

    // Generate synthetic PID for compatibility with ClaudeProcessManager API
    // Use a high range (900000+) to avoid conflicts with real PIDs
    this.syntheticPid = 900000 + Math.floor(Math.random() * 99999);
    this.logger.log(`Generated synthetic PID: ${this.syntheticPid} for SDK session`);

    // Resolve idle timeout: per-codon overrides runtime/hank default, which
    // overrides the built-in SDK default. Always bounded — a hung stream must
    // surface as a (retriable) failure instead of hanging indefinitely.
    const shimIdleTimeout =
      codon.shimIdleTimeout ?? this.defaultShimIdleTimeout ?? DEFAULT_SDK_IDLE_TIMEOUT_SECONDS;
    this.queryPromise = this.runQuery(promptContent, sdkOptions, codon.id, shimIdleTimeout);
    this.logger.log(`[SPAWN-DEBUG] runQuery called, promise returned`, "debug");

    this.queryPromise.catch((error) => {
      this.logger.log(`Query error: ${error.message}`, "error");
      this.cleanup();
      this.emit("error", error);
    });
    return actualLogPath;
  }

  /**
   * Build SDK options from codon configuration.
   */
  private buildSDKOptions(codon: Codon, previousSessionId: string | null): Options {
    // Model override is already applied in loadCodonSequence(), so just use codon.model
    const modelInfo = codon.model;

    const options: Options = {
      model: modelInfo.modelId,
      cwd: this.agentRootPath, // Agents work in agentRootPath (not executionPath)
      permissionMode: "bypassPermissions",
      abortController: this.abortController,
      settingSources: ["user"],
      // Flag-settings layer (highest user-controlled priority): pin compaction
      // regardless of the user's ~/.claude/settings.json. Default OFF — the
      // CLI then surfaces context overflow as a terminal "Prompt is too long"
      // error result (isContextExceeded Pattern 2) instead of compacting and
      // retrying. With autoCompact: true the CLI compacts reactively on the
      // provider's overflow 400, emits compact_boundary (Pattern 3), and
      // retries. Measured on CLI 2.1.215 — see intermediates/55.
      settings: { autoCompactEnabled: codon.autoCompact === true },
    };

    // Use custom Claude Code executable path if provided
    if (process.env.CLAUDE_PATH_TO_CLAUDE_EXECUTABLE) {
      options.pathToClaudeCodeExecutable = process.env.CLAUDE_PATH_TO_CLAUDE_EXECUTABLE;
      this.logger.log(
        `Using custom Claude Code executable: ${process.env.CLAUDE_PATH_TO_CLAUDE_EXECUTABLE}`,
      );
    }

    // Handle continuation
    if (codon.continuationMode === "continue-previous" && previousSessionId) {
      options.continue = true;
      options.resume = previousSessionId;
    }

    // Handle system prompt if provided
    const systemPrompt = this.promptBuilder.buildSystemPrompt(codon);
    if (systemPrompt) {
      options.systemPrompt = {
        type: "preset",
        preset: "claude_code",
        append: systemPrompt,
      };
      this.logger.log(`Added system prompt to Claude (${systemPrompt.length} chars)`);
      this.logger.log(`System prompt content:\n${systemPrompt}`);
    }

    // Initialize env object (SDK doesn't inherit all process.env, only what we explicitly pass)
    if (!options.env) options.env = {};

    // Pass through essential system environment variables that Claude Code SDK needs
    const essentialVars = [
      "PATH",
      "HOME",
      "USER",
      "SHELL",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "CLAUDE_CONFIG_DIR",
    ];
    for (const key of essentialVars) {
      if (process.env[key]) {
        options.env[key] = process.env[key];
      }
    }

    // Pass through critical environment variables that Claude Code SDK needs
    for (const key in process.env) {
      // Pass through CLAUDE_CODE_* variables (e.g. cloud-provider selectors like
      // CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX)
      if (key.startsWith("CLAUDE_CODE_")) {
        options.env[key] = process.env[key];
        this.logger.log(`Passing through Claude Code env var: ${key}`);
      }
      // Pass through ANTHROPIC_* variables (ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, etc.).
      // The Agent SDK authenticates via ANTHROPIC_API_KEY — OAuth tokens are not supported.
      else if (key.startsWith("ANTHROPIC_")) {
        options.env[key] = process.env[key];
        this.logger.log(`Passing through Anthropic env var: ${key}`);
      }
      // Pass through HANKWEAVE_* variables (with prefix stripped)
      // Exclude HANKWEAVE_RUNTIME_* (server config) and HANKWEAVE_SENTINEL_* (sentinel API keys)
      else if (
        key.startsWith("HANKWEAVE_") &&
        !key.startsWith("HANKWEAVE_RUNTIME_") &&
        !key.startsWith("HANKWEAVE_SENTINEL_")
      ) {
        const newKey = key.substring("HANKWEAVE_".length);
        if (process.env[key] === "unset") {
          delete options.env[newKey];
          this.logger.log(`Unsetting env var: ${newKey}`);
        } else {
          options.env[newKey] = process.env[key];
          this.logger.log(`Passing through env var: ${newKey}`);
        }
      }
    }

    // Apply anthropicBaseUrl if provided (overrides any ANTHROPIC_BASE_URL from env)
    if (this.anthropicBaseUrl) {
      options.env.ANTHROPIC_BASE_URL = this.anthropicBaseUrl;
      this.logger.log(`Using custom Anthropic base URL: ${this.anthropicBaseUrl}`);
    }

    // Bedrock mode: point the SDK at Amazon Bedrock and hand it the AWS
    // credential chain from the ambient environment. Bedrock-only — no other
    // codon's environment changes.
    if (this.bedrockMode) {
      options.env.CLAUDE_CODE_USE_BEDROCK = "1";
      for (const key of BEDROCK_AWS_ENV_VARS) {
        // AWS settings are ambient-only (same rule as the codon.env filter
        // below): the HANKWEAVE_ pass-through above may have inserted a
        // stripped HANKWEAVE_AWS_* alias, which pi ignores and preflight never
        // saw — honoring it would silently switch the child's account/region.
        if (key in options.env) {
          this.logger.log(`Ignoring HANKWEAVE_${key}: Bedrock AWS settings are ambient-only`);
          delete options.env[key];
        }
        if (process.env[key]) {
          options.env[key] = process.env[key];
        }
      }
      // These models ran in-process through pi (full ambient env) before the
      // Agent SDK became their default route — don't regress proxy-only
      // networks where Bedrock is unreachable without HTTP(S)_PROXY or
      // ALL_PROXY (the catch-all some deployments use exclusively).
      // NODE_EXTRA_CA_CERTS rides along: a corporate proxy that intercepts
      // TLS trusts its private CA through it, and without forwarding it the
      // child fails TLS on every Bedrock request the proxy vars point it at.
      for (const key of [
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "NODE_EXTRA_CA_CERTS",
      ]) {
        const value = process.env[key] ?? process.env[key.toLowerCase()];
        if (value) {
          options.env[key] = value;
        }
      }
      if (!options.env.AWS_REGION && !options.env.AWS_DEFAULT_REGION) {
        if (options.env.AWS_PROFILE) {
          // Mirror pi-ai: with a profile configured, leave the region unset so
          // the CLI (≥2.1.172) resolves it from the profile's config instead
          // of our fallback pinning us-east-1 over it.
          this.logger.log(
            `AWS_REGION not set — resolving region from AWS_PROFILE "${options.env.AWS_PROFILE}" (falls back to ${BEDROCK_DEFAULT_REGION}).`,
          );
        } else if (defaultProfileDefinesRegion()) {
          // Same rule as AWS_PROFILE: region resolution is independent of the
          // credential source — the SDK reads [default]'s region even when
          // credentials come from an env key pair, ECS, or IMDS — and an env
          // AWS_REGION would outrank it, so leave it for the CLI to resolve.
          this.logger.log(
            `AWS_REGION not set — resolving region from the default AWS profile (falls back to ${BEDROCK_DEFAULT_REGION}).`,
          );
        } else {
          options.env.AWS_REGION = BEDROCK_DEFAULT_REGION;
          this.logger.log(
            `AWS_REGION not set — defaulting to ${BEDROCK_DEFAULT_REGION}. Set AWS_REGION if your Bedrock model access is elsewhere.`,
          );
        }
      }
      this.logger.log(
        `Bedrock mode: CLAUDE_CODE_USE_BEDROCK=1, region ${
          options.env.AWS_REGION ??
          options.env.AWS_DEFAULT_REGION ??
          `resolved via AWS_PROFILE ${options.env.AWS_PROFILE}`
        }`,
      );
    }

    // Add codon-specific environment variables from config
    // These will override any existing variables with the same name
    if (codon.env) {
      this.logger.log("Applying codon-specific environment variables...");
      let codonEnv = codon.env;
      if (this.bedrockMode) {
        // AWS credentials are ambient-only: the pi route ignores these same
        // keys in codon.env, so honoring them here would let a harness switch
        // silently change the AWS account/region or disable Bedrock.
        const reserved = new Set<string>([...BEDROCK_AWS_ENV_VARS, "CLAUDE_CODE_USE_BEDROCK"]);
        codonEnv = Object.fromEntries(
          Object.entries(codonEnv).filter(([key]) => {
            if (reserved.has(key)) {
              this.logger.log(
                `Ignoring codon env var ${key}: Bedrock AWS settings are ambient-only`,
              );
              return false;
            }
            return true;
          }),
        );
      }
      Object.assign(options.env, codonEnv);
    }

    return options;
  }

  /**
   * Run the query and process messages.
   */
  private async runQuery(
    promptContent: string,
    options: Options,
    codonId: string,
    shimIdleTimeout?: number,
  ): Promise<void> {
    this.logger.log(
      `[SDK-runQuery] ======= ENTERED runQuery function for codon ${codonId} =======`,
      "info",
    );
    this.logger.log(`[SDK-runQuery] Starting query for codon ${codonId}`, "debug");
    this.logger.log(
      `[SDK-runQuery] Options: model=${options.model}, cwd=${
        options.cwd
      }, continue=${options.continue || false}, resume=${options.resume || "none"}`,
      "debug",
    );
    this.logger.log(`[SDK-runQuery] Prompt length: ${promptContent.length} chars`, "debug");

    try {
      this.logger.log(`[SDK-runQuery] Creating query generator`, "debug");
      this.logger.log(`[SDK-runQuery] About to call query() from SDK...`, "info");
      const queryGenerator = query({ prompt: promptContent, options });
      this.logger.log(`[SDK-runQuery] query() returned, generator created`, "info");
      this.logger.log(`[SDK-runQuery] Query generator created, entering message loop`, "debug");

      // Wrap with idle timeout if configured
      const events = shimIdleTimeout
        ? withIdleTimeout(queryGenerator, shimIdleTimeout * 1000)
        : queryGenerator;
      if (shimIdleTimeout) {
        this.logger.log(`[SDK-runQuery] Idle timeout enabled: ${shimIdleTimeout}s`, "info");
      }

      for await (const message of events) {
        if (this.killed) {
          this.logger.log(`[SDK-runQuery] Killed flag set, breaking loop`, "debug");
          break;
        }

        // Store session ID from first message
        if (!this.sessionId) {
          this.sessionId = message.session_id;
          this.logger.log(`[SDK-runQuery] Session ID: ${this.sessionId}`, "debug");
        }

        // Convert SDK message to JSONL format and write to log
        const jsonlMessage = this.convertSDKMessageToJSONL(message);
        if (jsonlMessage) {
          this.writeToLog(jsonlMessage);
        }

        // Emit events similar to process manager
        if (message.type === "assistant") {
          this.emit("stdout", JSON.stringify(jsonlMessage));
        }
      }

      this.logger.log(`[SDK-runQuery] Query complete, calling cleanup and emitting exit`, "info");
      this.cleanup();
      this.emitExit(0);
    } catch (error) {
      // Idle timeout: emit "exit" with code 1 to match shim behavior.
      // Shims handle timeout internally and exit with code 1, which flows through
      // the normal exit path (CodonRunner.handleProcessExit → handleCodonComplete).
      // Without this, IdleTimeoutError would re-throw → "error" event → FATAL shutdown.
      if (error instanceof IdleTimeoutError) {
        this.logger.log(`[SDK-runQuery] Error stack: ${toError(error).stack}`, "error");
        // Ensure the underlying SDK query is explicitly aborted so any child process
        // does not linger after idle timeout.
        this.abortController?.abort();
        // Write an error result to the log (mirroring the shims' final-result
        // emission) so the runtime classifies this as a retriable timeout and
        // onFailure: "retry" can fire. Without it, the codon fails with no
        // failure reason, which resolves as non-retriable.
        await this.writeSyntheticErrorResult(error.message);
        this.cleanup();
        this.emitExit(1);
        return;
      }
      const errorDetails = this.extractErrorDetails(error as Error, codonId);
      this.logger.log(errorDetails, "error");
      // Abort the in-flight SDK query so its streaming connection and child
      // process are torn down deterministically. An error that strikes
      // mid-stream (e.g. a 401/token-expiry or socket drop during the agent's
      // streaming turn) otherwise leaves the SDK's child process and stream
      // in-flight — orphaning the child and wedging subsequent teardown/shutdown.
      // The idle-timeout path above already aborts for this reason; every error
      // path must. abort() is idempotent and a no-op once the query has settled.
      this.abortController?.abort();
      this.cleanup();
      throw error;
    }
  }

  /**
   * Extract detailed error information from the error and log file.
   */
  private extractErrorDetails(error: Error, codonId: string): string {
    const lines: string[] = [];

    lines.push(`Query execution failed for codon ${codonId}`);
    lines.push(`Session ID: ${this.sessionId || "N/A"}`);
    lines.push(`Working directory: ${this.executionPath}`);
    lines.push(`Error type: ${error.name}`);
    lines.push(`Error message: ${error.message}`);

    // Add stack trace if available
    if (error.stack) {
      lines.push(`Stack trace:\n${error.stack}`);
    }

    // Parse log file to extract error details
    try {
      this.logParser.parseNow();
      const allMessages = this.logParser.getAllMessages();

      // Look for result messages with errors
      const resultErrors = allMessages.filter(
        (msg) => msg.type === "result" && msg.subtype === "error",
      );

      if (resultErrors.length > 0) {
        lines.push("\nLog file analysis:");
        for (const msg of resultErrors) {
          if (msg.type === "result") {
            lines.push(`- Result error: ${msg.result || "No details available"}`);
            if (msg.usage) {
              lines.push(`  Usage: ${JSON.stringify(msg.usage)}`);
            }
          }
        }
      }

      // Get last few assistant messages for context
      const assistantMessages = allMessages.filter((msg) => msg.type === "assistant");
      if (assistantMessages.length > 0) {
        const lastMessage = assistantMessages[assistantMessages.length - 1];
        if (lastMessage.type === "assistant") {
          lines.push("\nLast assistant message:");
          const content = lastMessage.message.content;
          if (Array.isArray(content)) {
            for (const block of content.slice(-3)) {
              if (block.type === "text") {
                // Truncate long messages
                const text =
                  block.text.length > 500 ? `${block.text.slice(0, 500)}...` : block.text;
                lines.push(`  ${text}`);
              } else if (block.type === "tool_use") {
                lines.push(`  [Tool use: ${block.name}]`);
              }
            }
          }
        }
      }
    } catch (parseError) {
      lines.push(`\nFailed to parse log file: ${(parseError as Error).message}`);
    }

    return lines.join("\n");
  }

  /**
   * Convert SDK message to JSONL format matching claude-session-schema.
   * SDK messages already have the correct structure, so we mostly just filter out
   * unwanted message types and handle edge cases.
   */
  private convertSDKMessageToJSONL(message: SDKMessage): Record<string, unknown> | null {
    // Filter out message types not supported by the JSONL schema
    if (
      message.type === "stream_event" ||
      message.type === "tool_progress" ||
      message.type === "auth_status"
    ) {
      return null;
    }

    // Filter out replay user messages (already in the conversation history)
    if (message.type === "user" && "isReplay" in message && message.isReplay) {
      return null;
    }

    // Filter out unknown system message subtypes
    if (
      message.type === "system" &&
      !["init", "hook_response", "compact_boundary", "status"].includes(message.subtype)
    ) {
      return null;
    }

    // Handle result messages: error subtypes don't have a 'result' field in SDK,
    // but our schema requires it, so we provide an empty string
    if (message.type === "result" && message.subtype !== "success") {
      return {
        ...message,
        result: "",
      };
    }

    // Pass through the message as-is (SDK format already matches our schema)
    return message as Record<string, unknown>;
  }

  /**
   * Write a message to the log file.
   */
  private writeToLog(message: Record<string, unknown>): void {
    if (this.logStream && !this.logStream.destroyed) {
      const timestamped = { ...message, timestamp: new Date().toISOString() };
      this.logStream.write(`${JSON.stringify(timestamped)}\n`);
    }
  }

  /**
   * Write a synthetic error result message to the log and wait for the write
   * to flush. Used when the session dies without the SDK emitting a result
   * (e.g. idle timeout): the log parser picks it up so the runtime gets a
   * classifiable failure reason. The flush matters — emitExit() synchronously
   * re-parses the log file, so a buffered write would be invisible to it.
   */
  private writeSyntheticErrorResult(errorText: string): Promise<void> {
    if (!this.logStream || this.logStream.destroyed) {
      return Promise.resolve();
    }
    const resultMessage = {
      type: "result",
      subtype: "error",
      is_error: true,
      result: errorText,
      num_turns: 0,
      duration_ms: 0,
      duration_api_ms: 0,
      ...(this.sessionId ? { session_id: this.sessionId } : {}),
      timestamp: new Date().toISOString(),
    };
    return new Promise((resolve) => {
      this.logStream?.write(`${JSON.stringify(resultMessage)}\n`, () => resolve());
    });
  }

  /**
   * Kill the Claude Agent SDK session gracefully.
   * Aborts the query (which triggers SIGTERM on the child via the SDK's abort handler),
   * then waits up to PROCESS_KILL_GRACE_MS for the query to actually complete.
   */
  async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (!this.abortController || this.killed) return;

    this.killed = true;
    this.logger.log(`Killing Claude Agent SDK session with ${signal}`);

    // Force an immediate parse of the log file to capture any final messages
    this.logParser.parseNow();

    // Abort the query — this triggers the SDK's abort handler which sends
    // SIGTERM to the Claude Code child process
    this.abortController.abort();

    // Wait for the query to actually complete (child process to terminate).
    // The SDK's abort handler sends SIGTERM, and the for-await loop in runQuery()
    // should break when the generator finishes. We wait up to PROCESS_KILL_GRACE_MS
    // for this to happen.
    if (this.queryPromise) {
      try {
        await Promise.race([
          this.queryPromise,
          new Promise<void>((resolve) => setTimeout(resolve, TIMEOUTS.PROCESS_KILL_GRACE_MS)),
        ]);
      } catch {
        // Query rejection on abort is expected — the important thing is we waited
        // for the child process to have time to exit
      }
    }
  }

  /**
   * Force-kill the Claude Agent SDK session immediately.
   * Sends abort (SIGTERM via SDK) without waiting for the child to exit.
   * Used by forceShutdown() when the user presses q/Ctrl+C a second time.
   *
   * Note: We cannot send SIGKILL to the SDK's child process because the SDK
   * does not expose the child PID. The abort sends SIGTERM; when our process
   * exits immediately after, the SDK's process.on("exit") handler fires another
   * SIGTERM as a belt-and-suspenders measure.
   */
  async forceKill(): Promise<void> {
    this.killed = true;
    if (this.abortController) {
      this.abortController.abort();
    }
    this.cleanup();
  }

  /**
   * Clean up resources.
   */
  private cleanup(): void {
    this.logger.log(`[CLEANUP-DEBUG] cleanup() called`, "info");
    this.logger.log(`[CLEANUP-DEBUG] Stack trace:\n${new Error().stack}`, "debug");

    if (this.logStream && !this.logStream.destroyed) {
      this.logStream.end();
      this.logStream = undefined;
    }

    if (this.abortController) {
      this.abortController = undefined;
    }

    this.queryPromise = undefined;
    this.syntheticPid = undefined;
  }

  /**
   * Check if session is running.
   */
  isRunning(): boolean {
    return this.abortController !== undefined && !this.killed;
  }

  /**
   * Get session ID.
   */
  getSessionId(): string | undefined {
    return this.sessionId;
  }

  /**
   * Whether the SDK delivered at least one message (the session id is captured
   * from the first message). This is a synchronous, race-free establishment
   * signal: it is set inside the message loop and survives `cleanup()`, so it is
   * still readable on the error path after a query-promise rejection — unlike the
   * log-parser-fed flag in CodonRunner, which may not have parsed the init line
   * yet when the SDK emits "error".
   */
  getSessionEstablished(): boolean {
    return this.sessionId !== undefined;
  }

  /**
   * Get synthetic PID (for compatibility with ClaudeProcessManager API).
   * Note: This is not a real process ID since SDK runs in-process.
   */
  getPid(): number | undefined {
    return this.syntheticPid;
  }

  /**
   * Close log stream explicitly (for external cleanup).
   */
  async closeLogStream(): Promise<void> {
    if (this.logStream && !this.logStream.destroyed) {
      await new Promise<void>((resolve) => {
        this.logStream?.end(() => resolve());
      });
      this.logStream = undefined;
    }
  }

  /**
   * Run self-test to verify Claude Agent SDK environment setup.
   * Checks for API authentication (API key or OAuth token) and SDK availability.
   *
   * @returns Promise resolving to self-test results
   */
  async runSelfTest(): Promise<ShimSelfTestResult> {
    this.logger.log("Running Claude Agent SDK self-test...");

    const checks: ShimSelfTestResult["checks"] = [];

    // Check 1: Verify SDK is installed (by trying to import it)
    let sdkFound = false;
    let sdkVersion = "unknown";
    try {
      // SDK is already imported, so if we got this far, it's available
      sdkFound = true;
      // Try to get version from package.json
      try {
        // The SDK's entry point (`sdk.mjs`) sits at the package root, so its
        // package.json is a sibling — no upward traversal.
        const sdkPackageJsonPath = path.join(
          path.dirname(require.resolve("@anthropic-ai/claude-agent-sdk")),
          "package.json",
        );
        const sdkPackageJson = JSON.parse(fs.readFileSync(sdkPackageJsonPath, "utf-8"));
        sdkVersion = sdkPackageJson.version || "unknown";
      } catch {
        // If we can't read the version, that's ok
        sdkVersion = "installed";
      }

      checks.push({
        name: "sdk_installed",
        passed: true,
        message: `Claude Agent SDK found (version ${sdkVersion})`,
      });
    } catch (error) {
      checks.push({
        name: "sdk_installed",
        passed: false,
        message:
          "Claude Agent SDK not found or failed to load: " +
          (error instanceof Error ? error.message : "Unknown error"),
      });
    }

    // Check 2: Verify Claude CLI executable is available
    const customCliPath = process.env.CLAUDE_PATH_TO_CLAUDE_EXECUTABLE;
    if (customCliPath) {
      // User explicitly set a path - verify it exists
      const cliExists = fs.existsSync(customCliPath);
      checks.push({
        name: "claude_cli_executable",
        passed: cliExists,
        message: cliExists
          ? `Claude CLI found at: ${customCliPath}`
          : `Claude CLI not found at specified path: ${customCliPath}`,
      });
    } else {
      // Try to detect Claude CLI in standard locations
      const detectedPath = detectClaudeExecutable();
      if (detectedPath) {
        checks.push({
          name: "claude_cli_executable",
          passed: true,
          message: `Claude CLI detected at: ${detectedPath}`,
        });
      } else {
        // No CLI found, but SDK will handle it internally
        checks.push({
          name: "claude_cli_executable",
          passed: true,
          message: "Claude CLI not detected, SDK will use internal CLI resolution",
        });
      }
    }

    // Check 3: Verify authentication. In Bedrock mode the SDK authenticates
    // via the AWS credential chain (CLAUDE_CODE_USE_BEDROCK) — check that some
    // credential source is visible; validity is proven at first invoke, whose
    // errors carry mapped remediation messages. Otherwise the Agent SDK
    // authenticates via ANTHROPIC_API_KEY (OAuth tokens are no longer
    // supported). When HW_INTERNAL_CLAUDE_LEGACY_AUTH is set, run in lenient
    // mode: don't hard-require ANTHROPIC_API_KEY and instead trust the SDK to
    // resolve credentials itself (e.g. a local `claude login` in the keychain).
    if (this.bedrockMode) {
      // Agent-managed authentication modes first: with
      // CLAUDE_CODE_SKIP_BEDROCK_AUTH the operator points the CLI at a
      // gateway (ANTHROPIC_BEDROCK_BASE_URL) that holds the credentials, and
      // with awsAuthRefresh/awsCredentialExport in Claude settings the CLI
      // fetches its own — in both, no ambient credential source exists by
      // design, and both variables/settings reach the child, so preflight
      // must not block what the child can authenticate. Then static ambient
      // sources; finally probe the instance metadata service so EC2/ECS
      // instance roles — invisible to any env/file check — still pass.
      let source: string | null = null;
      const skipAuth = process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH;
      if (skipAuth && skipAuth !== "0" && skipAuth.toLowerCase() !== "false") {
        source = "CLAUDE_CODE_SKIP_BEDROCK_AUTH (gateway-managed auth)";
      }
      if (source === null) source = describeAmbientAwsCredentialSource();
      if (source === null && claudeSettingsDefineAwsCredentialHelpers()) {
        source = "awsAuthRefresh/awsCredentialExport (Claude settings)";
      }
      if (source === null && (await detectInstanceMetadataCredentials())) {
        source = "instance metadata service (IMDS)";
      }
      const explicitRegion = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
      const regionFromProfile =
        !explicitRegion && (!!process.env.AWS_PROFILE || defaultProfileDefinesRegion());
      const region =
        explicitRegion ??
        (process.env.AWS_PROFILE
          ? `from AWS_PROFILE "${process.env.AWS_PROFILE}"`
          : regionFromProfile
            ? "from the default AWS profile"
            : BEDROCK_DEFAULT_REGION);
      checks.push({
        name: "authentication",
        passed: source !== null,
        message: source
          ? `Bedrock mode: AWS credentials via ${source}, region ${region}${
              explicitRegion || regionFromProfile ? "" : " (AWS_REGION not set — defaulting)"
            }`
          : "No AWS credentials found for Bedrock. Quickest: set AWS_BEARER_TOKEN_BEDROCK " +
            "(AWS Console → Bedrock → API keys → long-term key). Enterprise: set AWS_PROFILE " +
            "after `aws sso login`, or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY. Also set AWS_REGION.",
      });
    } else {
      const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
      const legacyAuth = isLegacyClaudeAuthEnabled();

      checks.push({
        name: "authentication",
        passed: hasApiKey || legacyAuth,
        message: hasApiKey
          ? "Authentication configured via ANTHROPIC_API_KEY"
          : legacyAuth
            ? "ANTHROPIC_API_KEY not set; HW_INTERNAL_CLAUDE_LEGACY_AUTH enabled — trusting local Claude Code login"
            : "No authentication found (set ANTHROPIC_API_KEY)",
      });
    }

    // Check 4: Verify custom base URL if set
    if (this.anthropicBaseUrl) {
      checks.push({
        name: "custom_base_url",
        passed: true,
        message: `Using custom Anthropic base URL: ${this.anthropicBaseUrl}`,
      });
    }

    // Overall result
    const allPassed = checks.every((check) => check.passed);

    const result: ShimSelfTestResult = {
      shim: {
        name: "claude-agent-sdk-manager",
        version: sdkVersion,
      },
      agent: {
        name: "claude-agent-sdk",
        version: sdkVersion,
        found: sdkFound,
      },
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
