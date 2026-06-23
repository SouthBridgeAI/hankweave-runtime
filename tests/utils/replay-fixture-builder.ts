/**
 * Self-contained replay-fixture builder for error-classification / failure-policy
 * e2e tests.
 *
 * Replay mode (`--replay`) re-feeds a previously captured JSONL log through the
 * REAL runtime: the log parser classifies an error `result` exactly as in
 * production, driving `finalStatus="failed"` → `resolveFailurePolicy`. That makes
 * replay the deterministic, no-API seam for testing how classified failures are
 * routed (retry / shutdown / continue).
 *
 * Unlike the captured fixtures under tests/fixtures/, these are generated entirely
 * in-memory from a small spec, so a test can dial in the exact error text and
 * `onFailure`/`retryConfig` it wants. See ReplayProcessManager (replays the log)
 * and server/replay.ts (`loadReplayManifest` reads `state.json` →
 * `runs[0].codons[].claudeLogPath`).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** A single JSONL log line (a Claude session message). */
export type LogLine = Record<string, unknown>;

export interface ReplayCodonSpec {
  id: string;
  name?: string;
  /** Failure policy for this codon. Omit for the runtime default ("abort"). */
  onFailure?: "abort" | "retry" | "ignore";
  /** Only meaningful with onFailure:"retry". */
  retryConfig?: { maxAttempts: number; delayMs?: number };
  /** Model alias written to hank.json (default "haiku" → ClaudeAgentSDKManager). */
  model?: string;
  /**
   * The JSONL log lines replayed for this codon, in order. A system `init` line
   * is auto-prepended unless `includeInit` is false. Use the helpers below
   * (`successResultLine`, `errorResultLine`, `assistantTextLine`).
   */
  logLines: LogLine[];
  /** Set false to skip the auto-prepended system init line (rarely needed). */
  includeInit?: boolean;
}

export interface BuiltReplayFixture {
  /** Directory passed as `replayDir` (and where hank.json/data live). */
  execDir: string;
  configPath: string;
  dataPath: string;
  runId: string;
  /** Best-effort recursive removal of execDir. */
  cleanup: () => void;
}

// Static, schema-valid values lifted from a real captured init line so the log
// parser accepts the synthetic system message (systemMessageSchema in
// server/types/claude-session-schema.ts).
const INIT_TOOLS = [
  "Task",
  "Bash",
  "Glob",
  "Grep",
  "Read",
  "Edit",
  "Write",
  "WebFetch",
  "TodoWrite",
  "WebSearch",
] as const;

/** A schema-valid `system/init` line. */
export function systemInitLine(opts: { sessionId: string; model?: string }): LogLine {
  return {
    type: "system",
    subtype: "init",
    cwd: "/replay/agentRoot",
    session_id: opts.sessionId,
    tools: [...INIT_TOOLS],
    mcp_servers: [],
    model: opts.model ?? "claude-haiku-4-5",
    permissionMode: "bypassPermissions",
    apiKeySource: "none",
  };
}

/** A minimal assistant text turn. */
export function assistantTextLine(text: string, opts: { sessionId: string }): LogLine {
  return {
    type: "assistant",
    message: {
      model: "claude-haiku-4-5",
      id: "msg_replayfixture000000000",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      stop_reason: null,
      usage: { input_tokens: 3, output_tokens: 5 },
    },
    session_id: opts.sessionId,
  };
}

/** A successful `result` line — drives the codon to "completed". */
export function successResultLine(text = "Done.", opts?: { sessionId?: string }): LogLine {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1000,
    duration_api_ms: 900,
    num_turns: 1,
    result: text,
    ...(opts?.sessionId ? { session_id: opts.sessionId } : {}),
    total_cost_usd: 0.0001,
  };
}

/**
 * An error `result` line — drives the codon to "failed" and routes `text`
 * through `classifyApiErrorText` (set `disguised` for the
 * `subtype:"success"+is_error:true` socket-drop shape).
 */
export function errorResultLine(
  text: string,
  opts?: { disguised?: boolean; sessionId?: string },
): LogLine {
  return {
    type: "result",
    subtype: opts?.disguised ? "success" : "error",
    is_error: true,
    duration_ms: 1000,
    duration_api_ms: 900,
    num_turns: 1,
    result: text,
    ...(opts?.sessionId ? { session_id: opts.sessionId } : {}),
  };
}

function codonSessionId(index: number): string {
  // A stable UUID-shaped id per codon (sessionIdSchema accepts arbitrary strings,
  // but a uuid shape keeps logs realistic).
  const suffix = String(index).padStart(12, "0");
  return `00000000-0000-4000-8000-${suffix}`;
}

/**
 * Build a self-contained replay execution directory for the given codons and
 * return paths to launch it with `launchHankweave({ replayDir, configPath,
 * dataDir, extraArgs:["--force"] })`.
 *
 * The generated `state.json` is intentionally minimal — replay starts a fresh
 * run from hank.json and only uses `state.json` to discover each codon's
 * `claudeLogPath` (server/replay.ts). It passes StateManager validation
 * (`isValidStateStructure`: runs[] array, currentRunId null, executionPlan []).
 */
export function buildReplayFixture(opts: {
  codons: ReplayCodonSpec[];
  runId?: string;
  /** Override the temp root (default os.tmpdir()). */
  tmpRoot?: string;
}): BuiltReplayFixture {
  const runId = opts.runId ?? `replay-${process.pid}-${counter()}`;
  const execDir = fs.mkdtempSync(path.join(opts.tmpRoot ?? os.tmpdir(), "hw-replay-fixture-"));

  const runDir = path.join(execDir, ".hankweave", "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });

  const stateCodons: Array<{ codonId: string; status: string; claudeLogPath: string }> = [];

  opts.codons.forEach((codon, index) => {
    const sessionId = codonSessionId(index);
    const lines: LogLine[] =
      codon.includeInit === false
        ? codon.logLines
        : [systemInitLine({ sessionId, model: "claude-haiku-4-5" }), ...codon.logLines];

    const logFileName = `${codon.id}-claude.log`;
    const content = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
    fs.writeFileSync(path.join(runDir, logFileName), content);

    stateCodons.push({
      codonId: codon.id,
      status: "completed", // terminal → detectCrashedRuns() ignores it
      claudeLogPath: path.join(".hankweave", "runs", runId, logFileName),
    });
  });

  // Minimal state.json — only the codon→log mapping is read in replay mode.
  const state = {
    runs: [
      {
        runId,
        status: "completed",
        startingConditions: { type: "fresh" },
        codons: stateCodons,
      },
    ],
    currentRunId: null,
    executionPlan: [],
  };
  fs.writeFileSync(path.join(execDir, ".hankweave", "state.json"), JSON.stringify(state, null, 2));

  // Minimal execution-meta.json (shape mirrors a real capture; --force bypasses
  // the data-hash check so the dummy data path is fine).
  const dataPath = path.join(execDir, "data.txt");
  fs.writeFileSync(dataPath, "replay fixture data\n");
  const configPath = path.join(execDir, "hank.json");
  fs.writeFileSync(
    path.join(execDir, ".hankweave", "execution-meta.json"),
    JSON.stringify(
      {
        version: "1.1.0",
        readOnlySourceDataPath: dataPath,
        readOnlySourceResolvedDataPath: dataPath,
        dataHash: "replayfixture",
        hankPath: configPath,
        linkType: "copy",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastUsed: "2026-01-01T00:00:00.000Z",
        hankweaveVersion: "0.0.0-replay-fixture",
      },
      null,
      2,
    ),
  );

  // hank.json from the codon specs.
  const hank = {
    hank: opts.codons.map((c) => ({
      id: c.id,
      name: c.name ?? c.id,
      promptText: `Replay fixture codon ${c.id}`,
      model: c.model ?? "haiku",
      continuationMode: "fresh",
      ...(c.onFailure ? { onFailure: c.onFailure } : {}),
      ...(c.retryConfig ? { retryConfig: c.retryConfig } : {}),
    })),
  };
  fs.writeFileSync(configPath, JSON.stringify(hank, null, 2));

  return {
    execDir,
    configPath,
    dataPath,
    runId,
    cleanup: () => {
      try {
        fs.rmSync(execDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

let _counter = 0;
function counter(): string {
  _counter += 1;
  return `${_counter}-${Math.floor(performance.now())}`;
}
