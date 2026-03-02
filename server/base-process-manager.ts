import type { ClaudeLogParser } from "./claude-log-parser.js";
import { type ProcessEvents, TypedEventEmitter } from "./typed-event-emitter.js";
import { isContextExceeded } from "./types/types.js";
import type { Logger } from "./utils.js";

/**
 * Base class for process managers that provides shared context-exceeded detection.
 *
 * All process managers (ClaudeAgentSDKManager, ShimProcessManager, ReplayProcessManager)
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
   */
  protected detectContextExceeded(): boolean {
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
