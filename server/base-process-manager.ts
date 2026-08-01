import type { ClaudeLogParser } from "./claude-log-parser.js";
import { type ProcessEvents, TypedEventEmitter } from "./typed-event-emitter.js";
import { isContextExceeded } from "./types/types.js";
import type { Logger } from "./utils.js";

/**
 * Base class for process managers that provides shared context-exceeded detection.
 *
 * All process managers (ClaudeAgentSDKManager, PiSdkManager, ReplayProcessManager)
 * need to detect context-exceeded conditions from parsed log messages before emitting
 * the exit event. This base class centralizes that logic.
 *
 * Note: No abstract method signatures — the three managers have different spawn()
 * signatures, and CodonRunner uses instanceof narrowing. The union type in CodonRunner
 * remains unchanged.
 */
export class BaseProcessManager extends TypedEventEmitter<ProcessEvents> {
  constructor(
    protected logger: Logger,
    protected logParser: ClaudeLogParser,
  ) {
    super();
  }

  /**
   * Flush the log parser and scan all parsed messages for context-exceeded indicators.
   * Detects both synthetic assistant messages (output token exceeded) and
   * result messages with is_error.
   *
   * Public because CodonRunner's SDK-crash path needs it too: when an
   * in-process SDK emits an error result and THEN throws (the Claude SDK's
   * shape for input overflow — "Prompt is too long"), the runner converts the
   * error to an exit event itself and must carry the same detection the
   * managers' own emitExit() paths do, or a context-exceeded signal that
   * arrives via the crash path is silently dropped.
   */
  detectContextExceeded(): boolean {
    this.logParser.parseNow();
    const allMessages = this.logParser.getAllMessages();
    return allMessages.some((msg) => isContextExceeded(msg));
  }

  /**
   * Emit the "exit" event with automatic context-exceeded detection.
   * Ensures every exit path consistently detects context exhaustion.
   */
  protected emitExit(exitCode: number): void {
    const contextExceeded = this.detectContextExceeded();
    this.emit("exit", exitCode, contextExceeded);
  }
}
