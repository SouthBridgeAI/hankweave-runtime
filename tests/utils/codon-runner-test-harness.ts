/**
 * Shared test harness for unit tests that exercise CodonRunner directly.
 *
 *  - `sdkLog` / `jsonl`: builders for the session-log lines the runner parses.
 *  - `useCodonRunnerSuite(prefix)`: registers the beforeEach/afterEach temp-dir
 *    and runner-cleanup hooks; call it once at describe scope.
 *  - `suite.makeRunner(options)`: writes the log, constructs the runner over
 *    standard mocks, attaches always-on event collectors, spies kill, and
 *    returns a handle with typed access to the internals tests poke at.
 *
 * Tests that need an unusual log shape can pass raw JSON strings to `jsonl`;
 * the builders only cover the shapes used by more than one test.
 */

import { afterEach, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Budget, type BudgetConfig } from "../../server/budget.js";
import type {
  CodonRunnerConfig,
  ExtensionConfig,
  ExtensionInfo,
} from "../../server/codon-runner.js";
import { CodonRunner } from "../../server/codon-runner.js";
import type { ExecutionCodonEntry } from "../../server/execution-planner.js";
import type { LlmProviderRegistry } from "../../server/llm/llm-provider-registry.js";
import type { StateManager } from "../../server/state-manager.js";
import type { CodonId, RunId, SessionId } from "../../server/types/branded-types.js";
import type { FailureReason } from "../../server/types/types.js";
import { Logger } from "../../server/utils.js";
import { createTestCodon } from "./test-codon-factory.js";

/** The Claude CLI's exact API-timeout text, matched verbatim by the runner. */
export const TIMEOUT_TEXT = "API Error: Request timed out.";

/** logParsingInterval passed to every harness runner. */
export const LOG_PARSING_INTERVAL_MS = 50;
/** How long parseLog() lets the parser run — 3× the interval. */
const PARSE_SETTLE_MS = 150;
/** How long emitted process events get to propagate through handlers. */
const EVENT_SETTLE_MS = 50;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let messageCounter = 0;
const nextMessageId = () => `msg_test${String(++messageCounter).padStart(8, "0")}`;

/**
 * Builders for the JSONL lines CodonRunner's log parser consumes. Each returns
 * one serialized line; combine with `jsonl(...)`.
 */
export const sdkLog = {
  /** The system/init line that establishes a session. */
  init(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "test-session",
      model: "claude-sonnet-4-5",
      cwd: "/test",
      tools: ["Read"],
      mcp_servers: [],
      permissionMode: "bypassPermissions",
      apiKeySource: "ANTHROPIC_API_KEY",
      ...overrides,
    });
  },

  /** Generic result message; pass subtype/is_error/result via overrides. */
  result(overrides: Record<string, unknown>): string {
    return JSON.stringify({
      type: "result",
      num_turns: 1,
      duration_ms: 5000,
      duration_api_ms: 4000,
      ...overrides,
    });
  },

  successResult(text = "Done."): string {
    return sdkLog.result({ subtype: "success", is_error: false, result: text });
  },

  errorResult(text: string, overrides: Record<string, unknown> = {}): string {
    return sdkLog.result({ subtype: "error", is_error: true, result: text, ...overrides });
  },

  /** The SDK's transport-failure shape: subtype "success" but is_error set. */
  disguisedErrorResult(text: string): string {
    return sdkLog.result({ subtype: "success", is_error: true, result: text });
  },

  /**
   * An assistant message with a single text item. `stringContent` uses the
   * plain-string content form (seen even on normal models) instead of the
   * content array.
   */
  assistantText(text: string, opts: { model?: string; stringContent?: boolean } = {}): string {
    const { model = "claude-sonnet-4-5", stringContent = false } = opts;
    return JSON.stringify({
      type: "assistant",
      message: {
        id: nextMessageId(),
        type: "message",
        role: "assistant",
        model,
        content: stringContent ? text : [{ type: "text", text }],
        stop_reason: null,
        ...(stringContent ? {} : { usage: { input_tokens: 3, output_tokens: 5 } }),
      },
      session_id: "test-session",
    });
  },

  /** The CLI's synthetic timeout: model "<synthetic>", string content. */
  syntheticTimeout(): string {
    return sdkLog.assistantText(TIMEOUT_TEXT, { model: "<synthetic>", stringContent: true });
  },
};

/** Join log lines into file content with the trailing newline real logs have. */
export function jsonl(...lines: string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/**
 * The single typed view of the CodonRunner privates that tests reach into.
 * Kept here so a rename inside CodonRunner breaks one file, not every suite.
 */
export interface RunnerInternals {
  logParser: { start: () => void; stop: () => void };
  processManager: {
    kill: (signal?: string) => Promise<void>;
    emit: (event: string, ...args: unknown[]) => void;
  };
  costTracker: { handleAssistantUsage: (usage: unknown) => void };
  successResultReceived: boolean;
  systemMessageReceived: boolean;
  runExtension: (sessionId: SessionId, exhaustionPrompt: string) => Promise<void>;
  performExtension: (
    sessionId: SessionId,
    extensionConfig: ExtensionConfig,
    onExtension: (info: ExtensionInfo) => void,
    previousExitCode: number,
    wasContextExceeded: boolean,
  ) => Promise<void>;
}

export interface MakeRunnerOptions {
  /** Session-log content (use jsonl/sdkLog). Defaults to an empty log. */
  log?: string;
  /** Copy an existing fixture file into the temp dir as the session log. */
  logFile?: string;
  /** Overrides on the standard test codon (id, model, exhaustWithPrompt, …). */
  codon?: Partial<Parameters<typeof createTestCodon>[0]>;
  /** Extra CodonRunner config (extensionConfig, shouldInterrupt, …). */
  runner?: {
    logParsingInterval?: number;
    extensionConfig?: ExtensionConfig;
    shouldInterrupt?: () => boolean;
    onExtension?: (info: ExtensionInfo) => void;
    shimIdleTimeout?: number;
    anthropicBaseUrl?: string;
  };
  /** Override the mock LLM registry (e.g. a non-null calculateCost). */
  llmRegistry?: { calculateCost: () => number | null };
  /** Budget construction inputs. plan "self" means [{ codon, codonId }]. */
  budget?: { config?: BudgetConfig; plan?: ExecutionCodonEntry[] | "self" };
  stateManager?: StateManager;
}

export interface CodonRunnerHandle {
  runner: CodonRunner;
  internals: RunnerInternals;
  budget: Budget;
  codonId: CodonId;
  logPath: string;
  /** Always-on event collectors, attached before anything can fire. */
  events: {
    exits: Array<{ code: number; contextExceeded: boolean; extensionCount: number }>;
    errors: Error[];
    codonFailures: Array<{ reason: FailureReason; error?: Error }>;
    /** Text extracted from forwarded assistantMessage events. */
    assistantTexts: string[];
  };
  /** Signals passed to the (always-spied, inert) processManager.kill. */
  killCalls: string[];
  /** Replace runExtension with a no-op so no real SDK is ever spawned. */
  stubRunExtension(): void;
  /** Drive the log parser over the session log: start → settle → stop. */
  parseLog(): Promise<void>;
  /** Emit a process-manager "error" and wait for handlers to settle. */
  emitProcessError(error: Error | string): Promise<void>;
  /** Emit a process-manager "exit" and wait for handlers to settle. */
  emitProcessExit(code: number, contextExceeded?: boolean): Promise<void>;
}

export interface CodonRunnerSuite {
  /** The per-test temp dir (valid inside tests/hooks only). */
  readonly tempDir: string;
  makeRunner(options?: MakeRunnerOptions): Promise<CodonRunnerHandle>;
}

const defaultLlmRegistry = { calculateCost: () => null };

const defaultStateManager = {
  transition: () => {},
  getState: () => ({ executionPlan: [] }),
  getCodonInCurrentRun: () => null,
  getCurrentRun: () => null,
} as unknown as StateManager;

const mockRunId = "test-run-id" as unknown as RunId;

let suiteDirCounter = 0;
let logFileCounter = 0;

/**
 * Call once at describe scope. Registers beforeEach/afterEach that create a
 * fresh temp dir under tests/test-area and tear down every runner made through
 * the returned suite (logParser stopped, runner.cleanup(), dir removed).
 */
export function useCodonRunnerSuite(prefix: string): CodonRunnerSuite {
  let tempDir = "";
  const handles: CodonRunnerHandle[] = [];

  beforeEach(async () => {
    tempDir = path.resolve(
      "tests",
      "test-area",
      `temp-codon-runner-${prefix}-${Date.now()}-${++suiteDirCounter}`,
    );
    await fs.promises.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    for (const handle of handles) {
      handle.internals.logParser.stop();
      handle.runner.cleanup();
    }
    handles.length = 0;
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  async function makeRunner(options: MakeRunnerOptions = {}): Promise<CodonRunnerHandle> {
    const logPath = path.join(tempDir, `session-${++logFileCounter}.jsonl`);
    if (options.logFile !== undefined) {
      await fs.promises.copyFile(options.logFile, logPath);
    } else {
      await fs.promises.writeFile(logPath, options.log ?? "");
    }

    const codon = createTestCodon({
      id: "test-codon",
      name: "Test Codon",
      promptText: "Test prompt",
      model: "sonnet",
      continuationMode: "fresh",
      ...options.codon,
    });
    const codonId = (options.codon?.id ?? "test-codon") as CodonId;

    const plan =
      options.budget?.plan === "self" ? [{ codon, codonId }] : (options.budget?.plan ?? []);
    const budget = new Budget({
      config: options.budget?.config ?? {},
      executionPlan: plan,
      logger: new Logger("/dev/null"),
    });

    const runner = new CodonRunner({
      codon,
      codonId,
      executionPath: tempDir,
      agentRootPath: tempDir,
      logger: new Logger(path.join(tempDir, `runner-${logFileCounter}.log`)),
      llmRegistry: (options.llmRegistry ?? defaultLlmRegistry) as unknown as LlmProviderRegistry,
      runId: mockRunId,
      stateManager: options.stateManager ?? defaultStateManager,
      budget,
      logPath,
      logParsingInterval: LOG_PARSING_INTERVAL_MS,
      ...options.runner,
    } as CodonRunnerConfig);

    const internals = runner as unknown as RunnerInternals;

    // Spy on kill so teardown behavior is observable and never touches a real
    // process (no harness test ever spawns one).
    const killCalls: string[] = [];
    internals.processManager.kill = async (signal?: string) => {
      killCalls.push(signal ?? "SIGTERM");
    };

    const events: CodonRunnerHandle["events"] = {
      exits: [],
      errors: [],
      codonFailures: [],
      assistantTexts: [],
    };
    runner.on("exit", (code, contextExceeded, extensionCount) => {
      events.exits.push({ code, contextExceeded, extensionCount });
    });
    runner.on("error", (error) => {
      events.errors.push(error);
    });
    runner.on("codonFailure", (data) => {
      events.codonFailures.push(data);
    });
    runner.on("assistantMessage", (msg) => {
      const content = msg.message.content;
      if (typeof content === "string") {
        events.assistantTexts.push(content);
      } else {
        for (const item of content) {
          if ("text" in item && item.type === "text") events.assistantTexts.push(item.text);
        }
      }
    });

    const handle: CodonRunnerHandle = {
      runner,
      internals,
      budget,
      codonId,
      logPath,
      events,
      killCalls,
      stubRunExtension() {
        internals.runExtension = async () => {};
      },
      async parseLog() {
        internals.logParser.start();
        await sleep(PARSE_SETTLE_MS);
        internals.logParser.stop();
      },
      async emitProcessError(error) {
        internals.processManager.emit(
          "error",
          typeof error === "string" ? new Error(error) : error,
        );
        await sleep(EVENT_SETTLE_MS);
      },
      async emitProcessExit(code, contextExceeded = false) {
        internals.processManager.emit("exit", code, contextExceeded);
        await sleep(EVENT_SETTLE_MS);
      },
    };
    handles.push(handle);
    return handle;
  }

  return {
    get tempDir() {
      return tempDir;
    },
    makeRunner,
  };
}
