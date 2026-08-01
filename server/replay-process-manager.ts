import fs from "node:fs";
import path from "node:path";
import { BaseProcessManager } from "./base-process-manager.js";
import type { ClaudeLogParser } from "./claude-log-parser.js";
import type { Codon } from "./types/types.js";
import type { Logger } from "./utils.js";

/**
 * Maximum inter-message delay during replay (ms), capping gaps that came from
 * long tool executions in the original run.
 *
 * Replay paces itself off the recorded timestamps so a replayed run *feels*
 * like the original, which is useful when watching one. It is pure cost when
 * something is only reading the output: a single recorded codon log carries
 * 80–450 seconds of gaps even after this cap, and none of it affects what the
 * runtime produces. `HANKWEAVE_REPLAY_MAX_DELAY_MS` collapses the pacing for
 * callers that want replay's other promise — fast, deterministic reproduction —
 * without the wait. The test suite sets it; the default is unchanged.
 */
const MAX_REPLAY_DELAY_MS = (() => {
  const raw = Number.parseInt(process.env.HANKWEAVE_REPLAY_MAX_DELAY_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5000;
})();

/**
 * ReplayProcessManager replays a previously recorded JSONL log file
 * instead of making real LLM API calls.
 *
 * It implements the same interface as ClaudeAgentSDKManager and PiSdkManager,
 * writing source JSONL lines progressively to the target log file so that
 * ClaudeLogParser can pick them up via its normal polling mechanism.
 *
 * For extensions (context exhaustion), tracks position across multiple spawn() calls,
 * writing lines from after the previous result message to the next result message.
 */
export class ReplayProcessManager extends BaseProcessManager {
  private logStream: fs.WriteStream | undefined;
  private syntheticPid: number | undefined;
  private running = false;
  private finished = false;
  private replayTimer: ReturnType<typeof setTimeout> | undefined;
  private sourceLines: string[] = [];
  private currentLineIndex = 0;

  constructor(
    private executionPath: string,
    logger: Logger,
    logParser: ClaudeLogParser,
    private sourceLogPath: string,
    private replaySpeed: number = 5,
  ) {
    super(logger, logParser);
  }

  /** Replay doesn't use prompt frontmatter */
  get promptFrontmatter(): undefined {
    return undefined;
  }

  /**
   * Spawn a replay session for the given codon.
   * Reads from the source JSONL log and writes lines progressively to the target log file.
   *
   * Matches the ClaudeAgentSDKManager.spawn() signature.
   */
  async spawn(
    codon: Codon,
    _sessionToResume: string | null,
    options?: {
      logPath?: string;
      exhaustionPrompt?: string;
    },
  ): Promise<string> {
    if (this.running) {
      throw new Error("Replay session already running");
    }

    const { logPath, exhaustionPrompt } = options ?? {};
    const isExhaustionMode = !!exhaustionPrompt;

    const actualLogPath =
      logPath || path.join(this.executionPath, `.hankweave/logs/log-${codon.id}-replay.jsonl`);

    // Ensure log directory exists
    const logsDir = path.dirname(actualLogPath);
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    // Create log stream — append mode for extensions (same as ClaudeAgentSDKManager)
    this.logStream = fs.createWriteStream(
      actualLogPath,
      isExhaustionMode ? { flags: "a" } : undefined,
    );

    // Generate synthetic PID (same pattern as ClaudeAgentSDKManager)
    this.syntheticPid = 900000 + Math.floor(Math.random() * 99999);
    this.running = true;
    this.finished = false;

    // Load source lines on first spawn (lazy load)
    if (this.sourceLines.length === 0) {
      if (!fs.existsSync(this.sourceLogPath)) {
        throw new Error(`Replay source log not found: ${this.sourceLogPath}`);
      }
      const content = fs.readFileSync(this.sourceLogPath, "utf-8");
      this.sourceLines = content.split("\n").filter((line) => line.trim().length > 0);

      this.logger.log(
        `[ReplayProcessManager] Loaded ${this.sourceLines.length} lines from ${this.sourceLogPath}`,
        "info",
      );
    }

    this.logger.log(
      `[ReplayProcessManager] Starting replay for codon ${codon.id} (line ${this.currentLineIndex}/${this.sourceLines.length}, speed=${this.replaySpeed}ms)`,
      "info",
    );

    // Start progressive writing
    this.writeNextLine();

    return actualLogPath;
  }

  /**
   * Write lines one at a time with delays between them.
   * Uses timestamps from log entries for realistic timing when available,
   * falling back to fixed replaySpeed for old logs without timestamps.
   * Stops at result messages and emits exit.
   */
  private writeNextLine(): void {
    if (!this.running || !this.logStream) return;

    if (this.currentLineIndex >= this.sourceLines.length) {
      // All lines written — no result message found, emit exit
      this.logger.log(
        `[ReplayProcessManager] All lines written without result message, emitting exit`,
        "info",
      );
      void this.finishReplay(0);
      return;
    }

    const line = this.sourceLines[this.currentLineIndex];
    this.currentLineIndex++;

    // Write line to target log
    this.logStream.write(`${line}\n`);

    // Check if this is a result message, and extract timestamp
    let isResultMessage = false;
    let currentTimestamp: string | null = null;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "result") {
        isResultMessage = true;
      }
      if (typeof parsed.timestamp === "string") {
        currentTimestamp = parsed.timestamp;
      }
    } catch {
      // Not valid JSON — skip, write next line
    }

    if (isResultMessage) {
      // Result message written — finish this replay session
      this.logger.log(
        `[ReplayProcessManager] Result message found at line ${this.currentLineIndex}`,
        "info",
      );
      // Small delay to let the LogParser pick up the final messages
      this.replayTimer = setTimeout(() => {
        void this.finishReplay(0);
      }, this.replaySpeed * 2);
    } else {
      // Calculate delay from current line's timestamp to the next line's timestamp
      const nextTimestamp = this.peekNextTimestamp();
      const delay = this.calculateDelay(currentTimestamp, nextTimestamp);
      this.replayTimer = setTimeout(() => this.writeNextLine(), delay);
    }
  }

  /**
   * Peek at the timestamp of the next unwritten line without advancing the index.
   */
  private peekNextTimestamp(): string | null {
    if (this.currentLineIndex >= this.sourceLines.length) return null;
    try {
      const parsed = JSON.parse(this.sourceLines[this.currentLineIndex]);
      return typeof parsed.timestamp === "string" ? parsed.timestamp : null;
    } catch {
      return null;
    }
  }

  /**
   * Calculate the delay before writing the next line.
   * Uses timestamps for realistic timing when available,
   * falls back to fixed replaySpeed for old logs without timestamps.
   * Caps maximum delay to avoid long waits from tool executions.
   */
  private calculateDelay(currentTimestamp: string | null, nextTimestamp: string | null): number {
    if (!currentTimestamp || !nextTimestamp) {
      return this.replaySpeed;
    }

    const currTime = new Date(currentTimestamp).getTime();
    const nextTime = new Date(nextTimestamp).getTime();
    const delta = nextTime - currTime;

    // Guard against invalid dates or negative deltas
    if (Number.isNaN(delta) || delta < 0) {
      return this.replaySpeed;
    }

    return Math.min(delta, MAX_REPLAY_DELAY_MS);
  }

  /**
   * Finish a replay session: flush log parser, clean up, emit exit.
   */
  private async finishReplay(exitCode: number): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.running = false;

    // Flush and close log stream before emitting exit so that emitExit's
    // synchronous re-parse of the log file sees every buffered line.
    await this.closeLogStream();

    this.logger.log(`[ReplayProcessManager] Replay finished, exitCode=${exitCode}`, "info");

    this.emitExit(exitCode);
  }

  /**
   * Kill the replay session.
   */
  async kill(_signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (!this.running) return;

    this.logger.log(`[ReplayProcessManager] Kill requested, stopping replay`, "info");

    if (this.replayTimer) {
      clearTimeout(this.replayTimer);
      this.replayTimer = undefined;
    }

    await this.finishReplay(0);
  }

  /**
   * Force-kill the replay session.
   */
  async forceKill(): Promise<void> {
    if (this.replayTimer) {
      clearTimeout(this.replayTimer);
      this.replayTimer = undefined;
    }

    this.running = false;

    if (this.logStream && !this.logStream.destroyed) {
      this.logStream.end();
      this.logStream = undefined;
    }
  }

  /**
   * Check if replay is in progress.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get synthetic PID.
   */
  getPid(): number | undefined {
    return this.syntheticPid;
  }

  /**
   * Close log stream explicitly.
   */
  async closeLogStream(): Promise<void> {
    if (this.logStream && !this.logStream.destroyed) {
      await new Promise<void>((resolve) => {
        this.logStream?.end(() => resolve());
      });
      this.logStream = undefined;
    }
  }
}
