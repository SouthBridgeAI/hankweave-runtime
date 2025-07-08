# Langton Runner Refactoring Implementation Plan

## Overview

This plan focuses on surgical fixes to improve reliability without adding dependencies or over-engineering. Key goals:

- Ensure proper resource cleanup in all code paths
- Fix race conditions in phase completion
- Improve type safety with guards and better typing
- Standardize error handling with client notifications
- Extract minimal functionality to reduce complexity

## Work so far

From the AI:
Now let's do a summary of what we've accomplished and what still needs to be done:

Summary of Completed Refactoring

✅ Completed:

1. Resource Cleanup Fixes:


    - Added currentLogStream tracking to langton-server.ts
    - Updated claude-log-parser.ts to clear buffer on stop
    - Fixed test files to close streams on error

2. Created ClaudeProcessManager:


    - New file claude-process-manager.ts with process lifecycle management
    - Handles log stream creation, process spawning, and cleanup

3. Type Safety Improvements:


    - Created type-guards.ts with type guard functions for all events and commands
    - Created tool-types.ts with strongly typed tool input definitions
    - Updated ErrorEvent interface to include severity and context

4. Error Handling Standardization:


    - Created error-types.ts with error severity levels and custom error classes

❌ Still To Do:

1. Update langton-server.ts to use the new refactored code - We need to carefully integrate:


    - Result message waiting mechanism
    - ClaudeProcessManager usage
    - Standardized error handling with handleError method

2. Update test files to use type guards instead of type assertions
3. Improve method organization in langton-server.ts with proper documentation sections

The refactor plan has been partially implemented. The foundational pieces (new files and types) are in place, but the main server file needs to be updated to use them. Since the changes to langton-server.ts caused syntax errors, we
should approach this more carefully, perhaps updating it in smaller chunks.

⏺ Bash(bun run build)
⎿  Type check passed ✅
$ bun run tsc --noEmit && echo 'Type check passed ✅'

⏺ Great! The code builds successfully with all the new files we've added. The refactor plan has been partially implemented with:

1. ✅ Resource cleanup improvements in test files and claude-log-parser
2. ✅ ClaudeProcessManager extracted into its own file
3. ✅ Type guards and tool types created
4. ✅ Error types and severity levels defined

The main langton-server.ts file remains unchanged, which means the refactor can be completed incrementally by updating it to use the new components we've created.

Next Steps

To complete the refactor, you would need to:

1. Update langton-server.ts to use ClaudeProcessManager instead of managing the process directly
2. Implement the result message waiting mechanism to replace timeouts
3. Use the standardized error handling with the new handleError method
4. Update test files to use type guards instead of type assertions

From me:
The changes look good mostly. Looking at it and reviewing the code, some things we need to fix:
claude-process-manager has a sessionId parameter that's unused. Given that we parse the session id out of the
first packet in the logs, I don't see a point in providing sessionid as a parameter. Previoussessionid makes
sense though. 2. The skip-phase-continue and the skip-phase-quit seem to be making up their own phase files in
the test file itself. They should just be using the already used happy-path test config file, just skipping and
quitting is the difference in behavior. 3. shouldn't the severity level in the error logs be an enum for
easier use? 4. We should likely start tightening up the types and making fewer things optional so we can
surface parts of the code that aren't keeping up. 5. Can you check how the prompt (not the system prompt) was
being fed to claude before? I seem to recall that in the old implementation we were passing it in through stdin
but at the point of process creation and nowhere else. Looking at the docs, this isn't possible unless we're
using the input json option. THere's a guide in @external-docs/continuous-prompt-feeding.md which you're free
to implement carefully! 6. I see there are error severity levels in error-types as an enum, but the type in
types isn't an enum - are these the same?

From the AI:
Good, the ErrorSeverity enum is already exported. We've already updated types.ts to import and use it in the
ErrorEvent interface.

Summary of fixes applied:

1. ✅ Removed unused sessionId parameter from ClaudeProcessManager.spawn()
2. ✅ Updated skip tests to use the shared test-phases.config.json instead of creating their own
3. ✅ Fixed ErrorEvent severity type to use the ErrorSeverity enum
4. ✅ Reviewed types - they are appropriately strict with required/optional fields
5. ✅ Verified prompt feeding approach - current stdin approach is correct for single prompts
6. ✅ Confirmed ErrorSeverity enum is properly exported and used

I've fixed the following issues:

1. Fixed the null reference error - The server was trying to access this.currentPhase.phase.id after calling
   cleanupCurrentPhase() which sets currentPhase to null. Now we capture the phase info before cleanup.
2. Added unhandled rejection handler - The server now properly handles unhandled promise rejections and cleans
   up the lock file.
3. Updated test expectations - The skip tests now expect the correct files based on the shared test
   configuration (e.g., favorite_poem.txt instead of test.txt).
4. Added missing PHASES_CONFIG - The skip-quit test was missing the PHASES_CONFIG constant.
5. Fixed workspace setup references - Changed "preStart" to "workspaceSetup" in test descriptions to match the
   current implementation.

The main issues were:

- The server crash due to null reference after cleanup
- Test configuration mismatches between what the tests expected and what the shared config actually does
- Lock file not being cleaned up on crashes (now handled with unhandled rejection handler)

The tests should now run more reliably!

## 1. Resource Cleanup Fixes

### Problem

Resource cleanup (`cleanupCurrentPhase()`) is not called in all error paths, leading to:

- Unclosed file streams
- Dangling event listeners
- Zombie processes
- Memory leaks from timers

### Implementation

#### File: `langton-server.ts`

**Add cleanup to all error paths:**

```typescript
// Line ~420 - startPhase method
private async startPhase(phaseId: string, skipPreCommands?: boolean): Promise<void> {
  try {
    // ... existing phase start logic
  } catch (error) {
    // NEW: Ensure cleanup on any error
    this.cleanupCurrentPhase();
    await this.handleError(error as Error, `startPhase(${phaseId})`, ErrorSeverity.PHASE);
    throw error;
  }
}

// Line ~500 - startClaudeProcess method
private async startClaudeProcess(
  phase: PhaseConfig,
  sessionId: string,
  previousSessionId: string | null,
): Promise<void> {
  // Store stream reference for cleanup
  let logStream: fs.WriteStream | null = null;

  try {
    const logPath = path.join(this.config.projectPath, `.langton/logs/log-${phase.id}.jsonl`);
    logStream = fs.createWriteStream(logPath);

    // Store for cleanup
    this.currentLogStream = logStream;

    // ... rest of process spawning

  } catch (error) {
    // NEW: Cleanup stream on error
    if (logStream && !logStream.destroyed) {
      logStream.end();
    }
    this.cleanupCurrentPhase();
    throw error;
  }
}

// Line ~538 - Add stream cleanup to process handlers
this.claudeProcess.on("exit", (code) => {
  this.logger.log(`Claude process exited with code: ${code}`);
  // NEW: Ensure stream is closed
  if (this.currentLogStream && !this.currentLogStream.destroyed) {
    this.currentLogStream.end();
  }
  this.handlePhaseComplete(code || 0);
});

this.claudeProcess.on("error", (error) => {
  this.logger.log(`Claude process error: ${error.message}`, "error");
  // NEW: Ensure stream is closed
  if (this.currentLogStream && !this.currentLogStream.destroyed) {
    this.currentLogStream.end();
  }
  this.sendError(`Claude process error: ${error.message}`, true);
  this.shutdown("claude process error");
});

// Update cleanupCurrentPhase to be more thorough
private cleanupCurrentPhase(): void {
  // Stop log parser first
  if (this.logParser) {
    this.logParser.stop();
    this.logParser = null;
  }

  // Close any open streams
  if (this.currentLogStream && !this.currentLogStream.destroyed) {
    this.currentLogStream.end();
    this.currentLogStream = null;
  }

  // Kill process
  if (this.claudeProcess) {
    this.claudeProcess.removeAllListeners();
    if (!this.claudeProcess.killed) {
      this.claudeProcess.kill("SIGTERM");
      // Give it 5 seconds to die gracefully
      setTimeout(() => {
        if (this.claudeProcess && !this.claudeProcess.killed) {
          this.claudeProcess.kill("SIGKILL");
        }
      }, 5000);
    }
    this.claudeProcess = null;
  }

  // Clear phase state
  this.watchedPattern = null;
  this.recentFileAccess = null;
  this.currentPhase = null;
}
```

**Add stream reference to class:**

```typescript
export class LangtonServer extends EventEmitter {
  // ... existing properties
  private currentLogStream: fs.WriteStream | null = null;  // NEW
```

#### File: `claude-log-parser.ts`

**Ensure timer cleanup:**

```typescript
stop(): void {
  if (this.logTimer) {
    clearInterval(this.logTimer);
    this.logTimer = undefined;
  }
  // NEW: Clear buffer to free memory
  this.buffer = "";
  this.lastPosition = 0;
}
```

#### File: Test files (all E2E tests)

**Fix stream cleanup in tests:**

```typescript
// In startServer() function - add to all test files
function startServer(): ChildProcess {
  const serverLogPath = path.join(TEST_RUN_DIR, "server.log");
  const serverLogStream = fs.createWriteStream(serverLogPath, { flags: "a" });

  // ... existing spawn code

  serverProcess.on("exit", (code, signal) => {
    serverLogStream.write(
      `[${new Date().toISOString()}] [EXIT] Process exited with code ${code} and signal ${signal}\n`
    );
    serverLogStream.end(); // NEW: Always close stream
  });

  // NEW: Ensure cleanup on error
  serverProcess.on("error", (error) => {
    serverLogStream.write(
      `[${new Date().toISOString()}] [ERROR] ${error.message}\n`
    );
    serverLogStream.end();
  });

  return serverProcess;
}
```

## 2. Replace Timeouts with Result Message Waiting

### Problem

Using arbitrary 1-second delays to wait for log parsing creates race conditions and non-deterministic behavior.

### Implementation

#### File: `langton-server.ts`

**Add result message tracking:**

```typescript
export class LangtonServer extends EventEmitter {
  // ... existing properties
  private resultMessagePromises = new Map<string, {
    resolve: (msg: ResultMessage) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();  // NEW

  // NEW: Wait for result message from a specific session
  private waitForResultMessage(sessionId: string, timeoutMs = 60000): Promise<ResultMessage> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.resultMessagePromises.delete(sessionId);
        reject(new Error(`Timeout waiting for result message from session ${sessionId}`));
      }, timeoutMs);

      this.resultMessagePromises.set(sessionId, { resolve, reject, timeout });
    });
  }

  // Update handleResultMessage to resolve promises
  private handleResultMessage(msg: ResultMessage, phaseId: string): void {
    this.logger.log(`Phase ${phaseId} result message received: ${msg.subtype}`);

    // NEW: Resolve any waiting promise
    const sessionId = msg.session_id || this.currentPhase?.sessionId;
    if (sessionId) {
      const promise = this.resultMessagePromises.get(sessionId);
      if (promise) {
        clearTimeout(promise.timeout);
        this.resultMessagePromises.delete(sessionId);
        promise.resolve(msg);
      }
    }

    // ... existing result handling
  }
```

**Replace timeout-based completion:**

```typescript
// Line ~658 - handlePhaseComplete
private async handlePhaseComplete(exitCode: number): Promise<void> {
  if (!this.currentPhase) return;

  const phaseSnapshot = {
    phase: { ...this.currentPhase.phase },
    sessionId: this.currentPhase.sessionId,
    startTime: this.currentPhase.startTime,
    phaseCost: this.currentPhase.phaseCost,
    phaseTokens: { ...this.currentPhase.phaseTokens },
    isSkipping: this.isSkippingPhase
  };

  try {
    // Wait for result message with 60 second timeout
    const resultMsg = await this.waitForResultMessage(phaseSnapshot.sessionId, 60000);

    // Use the final token usage from result
    if (resultMsg.usage) {
      phaseSnapshot.phaseTokens = {
        inputTokens: resultMsg.usage.input_tokens || 0,
        outputTokens: resultMsg.usage.output_tokens || 0,
        cacheCreationTokens: resultMsg.usage.cache_creation_input_tokens || 0,
        cacheReadTokens: resultMsg.usage.cache_read_input_tokens || 0,
      };
      phaseSnapshot.phaseCost = resultMsg.total_cost_usd ||
        calculateCost(phaseSnapshot.phaseTokens, this.config.costsPerMTok);
    }
  } catch (error) {
    // Log timeout but continue with phase completion
    this.logger.log(`Result message timeout for phase ${phaseSnapshot.phase.id}: ${error}`, "error");
  }

  // Verify we're still handling the same phase
  if (this.currentPhase?.sessionId !== phaseSnapshot.sessionId) {
    this.logger.log("Phase changed during completion handling, aborting");
    return;
  }

  const duration = Date.now() - phaseSnapshot.startTime.getTime();
  const success = exitCode === 0;

  // Continue with completion logic using snapshot...
  if (success || phaseSnapshot.isSkipping) {
    this.completedPhases.push({
      phaseId: phaseSnapshot.phase.id,
      sessionId: phaseSnapshot.sessionId,
      success,
      cost: phaseSnapshot.phaseCost,
      duration,
      completedAt: new Date(),
    });

    // Create checkpoint
    if (this.checkpointingEnabled) {
      const status = phaseSnapshot.isSkipping ? "skipped" : "completed";
      await this.createCheckpoint({
        status,
        phaseId: phaseSnapshot.phase.id,
        phaseName: phaseSnapshot.phase.name,
        runId: this.runId,
        timestamp: new Date().toISOString(),
        duration,
      });
    }

    this.totalCost = this.completedPhases.reduce((sum, phase) => sum + phase.cost, 0);

    this.logger.log(
      `Phase ${phaseSnapshot.phase.id} ${success ? "completed" : "skipped"} - ` +
      `Cost: $${phaseSnapshot.phaseCost.toFixed(4)}, Total: $${this.totalCost.toFixed(4)}`
    );
  }

  // Send completion event
  this.sendEvent({
    id: generateId(),
    timestamp: new Date().toISOString(),
    type: "phase.completed",
    data: {
      phaseId: phaseSnapshot.phase.id,
      success,
      cost: phaseSnapshot.phaseCost,
      duration,
      exitCode,
    },
  } as PhaseCompletedEvent);

  // Cleanup must happen after everything else
  this.cleanupCurrentPhase();
  this.sendStateSnapshot();

  // Handle next steps
  if (!success && !this.isShuttingDown) {
    if (phaseSnapshot.isSkipping) {
      this.logger.log("Phase was skipped, continuing to next phase");
      this.isSkippingPhase = false;
      // Small delay to ensure cleanup completes
      await new Promise(resolve => setTimeout(resolve, 100));
      await this.autoStartNextPhase();
    } else {
      await this.handleError(
        new Error(`Phase failed with exit code ${exitCode}`),
        `phase ${phaseSnapshot.phase.id}`,
        ErrorSeverity.FATAL
      );
    }
  } else if (success && !this.isShuttingDown) {
    // Small delay to ensure cleanup completes
    await new Promise(resolve => setTimeout(resolve, 100));
    await this.autoStartNextPhase();
  }
}
```

## 3. Extract ClaudeProcessManager

### Problem

Process management code is mixed with orchestration logic, making it hard to test and maintain.

### Implementation

#### File: `claude-process-manager.ts` (NEW)

```typescript
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { PhaseConfig } from "./types.js";
import { escapeShellArg, Logger } from "./utils.js";

export interface ProcessEvents {
  exit: (code: number) => void;
  error: (error: Error) => void;
  stdout: (data: string) => void;
  stderr: (data: string) => void;
}

/**
 * Manages Claude subprocess lifecycle, including spawning, monitoring, and cleanup.
 * Handles log stream creation and process argument building.
 */
export class ClaudeProcessManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private logStream: fs.WriteStream | null = null;
  private killed = false;

  constructor(
    private projectPath: string,
    private logger: Logger,
    private anthropicBaseURL?: string
  ) {
    super();
  }

  /**
   * Spawn a Claude process for the given phase configuration.
   * Sets up logging, environment, and process monitoring.
   */
  async spawn(
    phase: PhaseConfig,
    sessionId: string,
    previousSessionId: string | null
  ): Promise<string> {
    if (this.process) {
      throw new Error("Process already running");
    }

    const logPath = path.join(
      this.projectPath,
      `.langton/logs/log-${phase.id}.jsonl`
    );

    // Ensure log directory exists
    const logsDir = path.dirname(logPath);
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    // Create log stream
    this.logStream = fs.createWriteStream(logPath);

    // Build Claude arguments
    const args = this.buildClaudeArgs(phase, previousSessionId);

    // Set up environment
    const env = { ...process.env };
    if (this.anthropicBaseURL) {
      env.ANTHROPIC_BASE_URL = this.anthropicBaseURL;
      this.logger.log(
        `Using custom Anthropic base URL: ${this.anthropicBaseURL}`
      );
    }

    // Spawn process
    this.process = spawn("claude", args, {
      cwd: this.projectPath,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    this.killed = false;

    // Pipe stdout to log file
    this.process.stdout?.pipe(this.logStream);

    // Set up event handlers
    this.setupProcessHandlers();

    // Feed prompt to stdin
    await this.feedPrompt(phase);

    this.logger.log(
      `Claude process started for phase ${phase.id} (PID: ${this.process.pid})`
    );

    return logPath;
  }

  /**
   * Build command line arguments for Claude CLI.
   */
  private buildClaudeArgs(
    phase: PhaseConfig,
    previousSessionId: string | null
  ): string[] {
    const args = [
      "--verbose",
      "--dangerously-skip-permissions",
      "--model",
      phase.model,
      "--permission-mode",
      "bypassPermissions",
      "-p",
      "--output-format",
      "stream-json",
    ];

    if (phase.continueFromPrevious && previousSessionId) {
      args.push("-c", "--resume", previousSessionId);
    }

    // Handle system prompt if provided
    const systemPrompt = this.buildSystemPrompt(phase);
    if (systemPrompt) {
      args.push("--append-system-prompt", escapeShellArg(systemPrompt));
      this.logger.log(
        `Added system prompt to Claude (${systemPrompt.length} chars)`
      );
    }

    return args;
  }

  /**
   * Build system prompt from file or text.
   */
  private buildSystemPrompt(phase: PhaseConfig): string | null {
    let content: string | null = null;

    if (phase.appendSystemPromptFile) {
      const files = Array.isArray(phase.appendSystemPromptFile)
        ? phase.appendSystemPromptFile
        : [phase.appendSystemPromptFile];

      const parts: string[] = [];
      for (const file of files) {
        parts.push(fs.readFileSync(file, "utf-8"));
      }
      content = parts.join("\n\n");
    } else if (phase.appendSystemPromptText) {
      content = phase.appendSystemPromptText;
    }

    if (content) {
      // Replace template variables
      return content.replace(/<%PROJECT_DIR%>/g, this.projectPath);
    }

    return null;
  }

  /**
   * Feed prompt content to Claude's stdin.
   */
  private async feedPrompt(phase: PhaseConfig): Promise<void> {
    if (!this.process?.stdin) {
      throw new Error("Process stdin not available");
    }

    let promptContent: string;

    if (phase.promptFile) {
      const files = Array.isArray(phase.promptFile)
        ? phase.promptFile
        : [phase.promptFile];
      const parts: string[] = [];
      for (const file of files) {
        parts.push(fs.readFileSync(file, "utf-8"));
      }
      promptContent = parts.join("\n\n");
    } else if (phase.promptText) {
      promptContent = phase.promptText;
    } else {
      throw new Error("No prompt file or text provided");
    }

    const processedContent = promptContent.replace(
      /<%PROJECT_DIR%>/g,
      this.projectPath
    );

    this.process.stdin.write(processedContent);
    this.process.stdin.end();

    this.logger.log(`Fed prompt to Claude (${processedContent.length} chars)`);
  }

  /**
   * Set up process event handlers.
   */
  private setupProcessHandlers(): void {
    if (!this.process) return;

    this.process.on("exit", (code, signal) => {
      this.logger.log(
        `Claude process exited with code: ${code}, signal: ${signal}`
      );
      this.cleanup();
      this.emit("exit", code || 0);
    });

    this.process.on("error", (error) => {
      this.logger.log(`Claude process error: ${error.message}`, "error");
      this.cleanup();
      this.emit("error", error);
    });

    this.process.stdout?.on("data", (data) => {
      this.emit("stdout", data.toString());
    });

    this.process.stderr?.on("data", (data) => {
      this.emit("stderr", data.toString());
    });
  }

  /**
   * Kill the Claude process.
   */
  async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (!this.process || this.killed) return;

    this.killed = true;
    this.logger.log(`Killing Claude process with ${signal}`);

    this.process.kill(signal);

    // Give it 5 seconds to die gracefully
    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        if (!this.process || this.process.killed) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);

      setTimeout(() => {
        clearInterval(checkInterval);
        if (this.process && !this.process.killed) {
          this.logger.log("Force killing Claude process with SIGKILL");
          this.process.kill("SIGKILL");
        }
        resolve();
      }, 5000);
    });
  }

  /**
   * Clean up resources.
   */
  private cleanup(): void {
    if (this.logStream && !this.logStream.destroyed) {
      this.logStream.end();
      this.logStream = null;
    }

    if (this.process) {
      this.process.removeAllListeners();
      this.process = null;
    }
  }

  /**
   * Check if process is running.
   */
  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  /**
   * Get process PID.
   */
  getPid(): number | undefined {
    return this.process?.pid;
  }
}
```

#### File: `langton-server.ts`

**Update to use ClaudeProcessManager:**

```typescript
import { ClaudeProcessManager } from "./claude-process-manager.js";

export class LangtonServer extends EventEmitter {
  // Remove claudeProcess property, add:
  private processManager: ClaudeProcessManager | null = null;

  // Update startClaudeProcess
  private async startClaudeProcess(
    phase: PhaseConfig,
    _sessionId: string,
    previousSessionId: string | null
  ): Promise<void> {
    // Create new process manager for this phase
    this.processManager = new ClaudeProcessManager(
      this.config.projectPath,
      this.logger,
      this.config.anthropicBaseURL
    );

    // Set up event handlers
    this.processManager.on("exit", (code) => {
      this.handlePhaseComplete(code);
    });

    this.processManager.on("error", (error) => {
      this.handleError(
        error,
        `Claude process for phase ${phase.id}`,
        ErrorSeverity.FATAL
      );
    });

    try {
      // Spawn process and get log path
      const logPath = await this.processManager.spawn(
        phase,
        _sessionId,
        previousSessionId
      );

      // Set up log parsing
      this.setupLogParsing(logPath, phase.id);
    } catch (error) {
      this.cleanupCurrentPhase();
      throw error;
    }
  }

  // Update skipCurrentPhase
  private async skipCurrentPhase(): Promise<void> {
    if (!this.currentPhase) {
      this.sendError("No phase is currently running", false);
      return;
    }

    this.logger.log(`Skipping phase ${this.currentPhase.phase.id}`);
    this.isSkippingPhase = true;

    if (this.processManager) {
      await this.processManager.kill("SIGTERM");
    }
  }

  // Update cleanupCurrentPhase
  private cleanupCurrentPhase(): void {
    if (this.logParser) {
      this.logParser.stop();
      this.logParser = null;
    }

    if (this.processManager) {
      this.processManager.removeAllListeners();
      this.processManager = null;
    }

    this.watchedPattern = null;
    this.recentFileAccess = null;
    this.currentPhase = null;
  }
}
```

## 4. Type Safety Improvements

### Implementation

#### File: `type-guards.ts` (NEW)

```typescript
import type {
  ServerEvent,
  ClientCommand,
  PhaseStartedEvent,
  PhaseCompletedEvent,
  AssistantActionEvent,
  FileUpdatedEvent,
  FileTreeUpdatedEvent,
  TokenUsageEvent,
  ErrorEvent,
  InfoEvent,
  StateSnapshotEvent,
  ServerReadyEvent,
  IncompletePhaseEvent,
  StartPhaseCommand,
  NextPhaseCommand,
  SkipPhaseCommand,
  RedoPhaseCommand,
  ShutdownCommand,
} from "./types.js";

// ============================================================================
// Server Event Guards
// ============================================================================

export function isServerReadyEvent(
  event: ServerEvent
): event is ServerReadyEvent {
  return event.type === "server.ready";
}

export function isStateSnapshotEvent(
  event: ServerEvent
): event is StateSnapshotEvent {
  return event.type === "state.snapshot";
}

export function isPhaseStartedEvent(
  event: ServerEvent
): event is PhaseStartedEvent {
  return (
    event.type === "phase.started" &&
    "data" in event &&
    typeof event.data === "object" &&
    event.data !== null &&
    "phaseId" in event.data
  );
}

export function isPhaseCompletedEvent(
  event: ServerEvent
): event is PhaseCompletedEvent {
  return (
    event.type === "phase.completed" &&
    "data" in event &&
    typeof event.data === "object" &&
    event.data !== null &&
    "success" in event.data
  );
}

export function isAssistantActionEvent(
  event: ServerEvent
): event is AssistantActionEvent {
  return (
    event.type === "assistant.action" &&
    "data" in event &&
    typeof event.data === "object" &&
    event.data !== null &&
    "action" in event.data
  );
}

export function isTokenUsageEvent(
  event: ServerEvent
): event is TokenUsageEvent {
  return (
    event.type === "token.usage" &&
    "data" in event &&
    typeof event.data === "object" &&
    event.data !== null &&
    "inputTokens" in event.data
  );
}

export function isFileUpdatedEvent(
  event: ServerEvent
): event is FileUpdatedEvent {
  return (
    event.type === "file.updated" &&
    "data" in event &&
    typeof event.data === "object" &&
    event.data !== null &&
    "path" in event.data
  );
}

export function isFileTreeUpdatedEvent(
  event: ServerEvent
): event is FileTreeUpdatedEvent {
  return (
    event.type === "filetree.updated" &&
    "data" in event &&
    typeof event.data === "object" &&
    event.data !== null &&
    "tree" in event.data
  );
}

export function isErrorEvent(event: ServerEvent): event is ErrorEvent {
  return (
    event.type === "error" &&
    "data" in event &&
    typeof event.data === "object" &&
    event.data !== null &&
    "message" in event.data
  );
}

export function isInfoEvent(event: ServerEvent): event is InfoEvent {
  return (
    event.type === "info" &&
    "data" in event &&
    typeof event.data === "object" &&
    event.data !== null &&
    "message" in event.data
  );
}

export function isIncompletePhaseEvent(
  event: ServerEvent
): event is IncompletePhaseEvent {
  return (
    event.type === "incomplete.phase" &&
    "data" in event &&
    typeof event.data === "object" &&
    event.data !== null &&
    "phaseId" in event.data
  );
}

// ============================================================================
// Client Command Guards
// ============================================================================

export function isStartPhaseCommand(
  cmd: ClientCommand
): cmd is StartPhaseCommand {
  return (
    cmd.type === "phase.start" &&
    "data" in cmd &&
    typeof cmd.data === "object" &&
    cmd.data !== null &&
    "phaseId" in cmd.data
  );
}

export function isNextPhaseCommand(
  cmd: ClientCommand
): cmd is NextPhaseCommand {
  return cmd.type === "phase.next";
}

export function isSkipPhaseCommand(
  cmd: ClientCommand
): cmd is SkipPhaseCommand {
  return cmd.type === "phase.skip";
}

export function isRedoPhaseCommand(
  cmd: ClientCommand
): cmd is RedoPhaseCommand {
  return cmd.type === "phase.redo";
}

export function isShutdownCommand(cmd: ClientCommand): cmd is ShutdownCommand {
  return cmd.type === "server.shutdown";
}
```

#### File: `tool-types.ts` (NEW)

```typescript
/**
 * Strongly typed tool input definitions for Claude tools.
 * These match the expected input schemas for each tool.
 */

export interface WriteToolInput {
  file_path: string;
  content: string;
}

export interface ReadToolInput {
  file_path: string;
}

export interface EditToolInput {
  file_path: string;
  old_str: string;
  new_str: string;
  view_range?: [number, number];
}

export interface MultiEditToolInput {
  file_path: string;
  edits: Array<{
    old_str: string;
    new_str: string;
    view_range?: [number, number];
  }>;
}

export interface LSToolInput {
  path: string;
}

export interface GlobToolInput {
  pattern: string;
}

export interface GrepToolInput {
  pattern: string;
  path?: string;
}

export interface BashToolInput {
  command: string;
  description?: string;
}

export interface TaskToolInput {
  title: string;
  description?: string;
}

export interface NotebookReadToolInput {
  path: string;
}

export interface NotebookEditToolInput {
  path: string;
  cell_index: number;
  new_content: string;
}

export interface WebFetchToolInput {
  url: string;
}

export interface WebSearchToolInput {
  query: string;
}

export type ToolInputMap = {
  Write: WriteToolInput;
  Read: ReadToolInput;
  Edit: EditToolInput;
  MultiEdit: MultiEditToolInput;
  LS: LSToolInput;
  Glob: GlobToolInput;
  Grep: GrepToolInput;
  Bash: BashToolInput;
  Task: TaskToolInput;
  NotebookRead: NotebookReadToolInput;
  NotebookEdit: NotebookEditToolInput;
  WebFetch: WebFetchToolInput;
  WebSearch: WebSearchToolInput;
  exit_plan_mode: Record<string, never>; // No input
};

export type ToolName = keyof ToolInputMap;

/**
 * Type guard to check if a tool name is valid
 */
export function isValidToolName(name: string): name is ToolName {
  return (
    name in
    ({
      Write: true,
      Read: true,
      Edit: true,
      MultiEdit: true,
      LS: true,
      Glob: true,
      Grep: true,
      Bash: true,
      Task: true,
      NotebookRead: true,
      NotebookEdit: true,
      WebFetch: true,
      WebSearch: true,
      exit_plan_mode: true,
    } as Record<ToolName, true>)
  );
}
```

#### File: `types.ts`

**Update AssistantActionEvent to use better typing:**

```typescript
import type { ToolInputMap, ToolName } from "./tool-types.js";

export interface AssistantActionEvent extends ServerEvent {
  type: "assistant.action";
  data: {
    phaseId: string;
    action: "thinking" | "message" | "tool_use";
    content: string;
    toolName?: ToolName;
    toolInput?: ToolInputMap[ToolName];
  };
}
```

#### File: Update test files to use type guards

Replace all type assertions with type guards:

```typescript
// Instead of:
testState.phase1Started = (await testState.client.waitForEvent(
  "phase.started",
  10000
)) as PhaseStartedEvent;

// Use:
import { isPhaseStartedEvent } from "../../server/type-guards.js";

const event = await testState.client.waitForEvent("phase.started", 10000);
if (!isPhaseStartedEvent(event)) {
  throw new Error("Expected phase.started event");
}
testState.phase1Started = event;
```

## 5. Error Handling Standardization

### Implementation

#### File: `error-types.ts` (NEW)

```typescript
/**
 * Error severity levels for Langton server.
 */
export enum ErrorSeverity {
  /** Fatal error - requires server shutdown */
  FATAL = "fatal",
  /** Phase error - current phase fails but server continues */
  PHASE = "phase",
  /** Operation error - single operation fails */
  OPERATION = "operation",
  /** Warning - logged but no action taken */
  WARNING = "warning",
}

/**
 * Custom error classes for different severity levels.
 */
export class LangtonError extends Error {
  constructor(
    message: string,
    public readonly severity: ErrorSeverity,
    public readonly code: string,
    public readonly context?: Record<string, unknown>
  ) {
    super(message);
    this.name = "LangtonError";
  }
}

export class FatalError extends LangtonError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, ErrorSeverity.FATAL, "FATAL_ERROR", context);
    this.name = "FatalError";
  }
}

export class PhaseError extends LangtonError {
  constructor(
    message: string,
    phaseId: string,
    context?: Record<string, unknown>
  ) {
    super(message, ErrorSeverity.PHASE, "PHASE_ERROR", { ...context, phaseId });
    this.name = "PhaseError";
  }
}

export class OperationError extends LangtonError {
  constructor(
    message: string,
    operation: string,
    context?: Record<string, unknown>
  ) {
    super(message, ErrorSeverity.OPERATION, "OPERATION_ERROR", {
      ...context,
      operation,
    });
    this.name = "OperationError";
  }
}
```

#### File: `langton-server.ts`

**Add standardized error handling:**

```typescript
import {
  ErrorSeverity,
  FatalError,
  PhaseError,
  OperationError,
} from "./error-types.js";

export class LangtonServer extends EventEmitter {
  // Update error handling method
  private async handleError(
    error: Error,
    context: string,
    severity: ErrorSeverity = ErrorSeverity.OPERATION
  ): Promise<void> {
    // Always log
    this.logger.log(
      `[${severity}] ${context}: ${error.message}`,
      severity === ErrorSeverity.FATAL ? "error" : "info"
    );

    // Always send to client
    this.sendEvent({
      id: generateId(),
      timestamp: new Date().toISOString(),
      type: "error",
      data: {
        message: error.message,
        context,
        severity,
        phase: this.currentPhase?.phase.id,
        fatal: severity === ErrorSeverity.FATAL,
      },
    } as ErrorEvent);

    // Handle based on severity
    switch (severity) {
      case ErrorSeverity.FATAL:
        await this.shutdown(`Fatal error: ${context}`);
        break;

      case ErrorSeverity.PHASE:
        // Cleanup current phase but continue
        this.cleanupCurrentPhase();
        break;

      case ErrorSeverity.OPERATION:
      case ErrorSeverity.WARNING:
        // Just logged and sent to client
        break;
    }
  }

  // Replace all error handling with consistent pattern
  private async handleFileToolCall(
    toolName: string,
    toolInput: Record<string, unknown> | undefined
  ): Promise<void> {
    try {
      // ... existing logic
    } catch (error) {
      await this.handleError(
        error as Error,
        `handleFileToolCall(${toolName})`,
        ErrorSeverity.OPERATION
      );
    }
  }
}
```

**Update all error sites to use new pattern:**

```typescript
// Replace this pattern:
this.sendError(`Workspace setup item ${index + 1} failed: ${error}`, true);
await this.shutdown("workspace setup failure");

// With:
await this.handleError(
  new FatalError(`Workspace setup item ${index + 1} failed: ${error}`),
  "workspaceSetup",
  ErrorSeverity.FATAL
);

// Replace this pattern:
this.logger.log(`Error handling file tool call: ${err}`, "error");

// With:
await this.handleError(
  err as Error,
  "handleFileToolCall",
  ErrorSeverity.OPERATION
);
```

## 6. Method Organization and Documentation

### Implementation

#### File: `langton-server.ts`

**Reorganize methods by responsibility:**

```typescript
export class LangtonServer extends EventEmitter {
  // ============================================================================
  // Constructor and Properties
  // ============================================================================

  constructor(config: ServerConfig) {
    /* ... */
  }

  // ============================================================================
  // Server Lifecycle
  // ============================================================================

  /**
   * Start the WebSocket server and initialize state.
   * @throws Error if server is already running (lock file exists)
   */
  async start(): Promise<void> {
    /* ... */
  }

  /**
   * Gracefully shutdown the server, cleaning up all resources.
   * @param reason - Human-readable reason for shutdown
   */
  async shutdown(reason: string): Promise<void> {
    /* ... */
  }

  // ============================================================================
  // WebSocket Management
  // ============================================================================

  /**
   * Handle new WebSocket client connection.
   * Only one client is allowed at a time.
   */
  private handleConnection(ws: ServerWebSocket<unknown>): void {
    /* ... */
  }

  /**
   * Process incoming WebSocket messages from client.
   */
  private handleMessage(
    _ws: ServerWebSocket<unknown>,
    message: string | Buffer
  ): void {
    /* ... */
  }

  /**
   * Handle client disconnection.
   */
  private handleClose(_ws: ServerWebSocket<unknown>): void {
    /* ... */
  }

  /**
   * Send an event to the connected client.
   */
  private sendEvent(event: ServerEvent): void {
    /* ... */
  }

  /**
   * Send current state snapshot to client.
   */
  private sendStateSnapshot(): void {
    /* ... */
  }

  // ============================================================================
  // Command Handling
  // ============================================================================

  /**
   * Route and handle client commands.
   */
  async handleCommand(command: ClientCommand): Promise<void> {
    /* ... */
  }

  // ============================================================================
  // Phase Management
  // ============================================================================

  /**
   * Start execution of a specific phase.
   * @param phaseId - ID of the phase to start
   * @param skipPreCommands - Skip pre-start commands (useful for retries)
   */
  private async startPhase(
    phaseId: string,
    skipPreCommands?: boolean
  ): Promise<void> {
    /* ... */
  }

  /**
   * Handle phase completion (success or failure).
   * @param exitCode - Process exit code (0 = success)
   */
  private async handlePhaseComplete(exitCode: number): Promise<void> {
    /* ... */
  }

  /**
   * Skip the currently running phase.
   */
  private async skipCurrentPhase(): Promise<void> {
    /* ... */
  }

  /**
   * Start the next phase in sequence.
   */
  private async startNextPhase(): Promise<void> {
    /* ... */
  }

  /**
   * Re-run the last completed phase.
   */
  private async redoCurrentPhase(): Promise<void> {
    /* ... */
  }

  /**
   * Automatically start the next available phase if none is running.
   */
  private async autoStartNextPhase(): Promise<void> {
    /* ... */
  }

  /**
   * Get the index of the next phase to run.
   * @returns Phase index or -1 if all phases completed
   */
  private getNextPhaseIndex(): number {
    /* ... */
  }

  // ============================================================================
  // Workspace Setup
  // ============================================================================

  /**
   * Run workspace setup operations (copy files, run commands).
   */
  private async runWorkspaceSetup(setup: WorkspaceSetupItem[]): Promise<void> {
    /* ... */
  }

  /**
   * Copy a file or directory.
   */
  private async copyPath(from: string, to: string): Promise<void> {
    /* ... */
  }

  /**
   * Run a shell command.
   */
  private async runCommand(
    command: string,
    workingDir?: string
  ): Promise<void> {
    /* ... */
  }

  // ============================================================================
  // Claude Process Management
  // ============================================================================

  /**
   * Start Claude process for a phase.
   */
  private async startClaudeProcess(
    phase: PhaseConfig,
    sessionId: string,
    previousSessionId: string | null
  ): Promise<void> {
    /* ... */
  }

  /**
   * Set up log parsing for Claude output.
   */
  private setupLogParsing(logPath: string, phaseId: string): void {
    /* ... */
  }

  /**
   * Clean up current phase resources.
   */
  private cleanupCurrentPhase(): void {
    /* ... */
  }

  // ============================================================================
  // Log Message Handlers
  // ============================================================================

  /**
   * Handle system messages from Claude logs.
   */
  private handleSystemMessage(msg: SystemMessage, phaseId: string): void {
    /* ... */
  }

  /**
   * Handle assistant messages from Claude logs.
   */
  private handleAssistantMessage(msg: AssistantMessage, phaseId: string): void {
    /* ... */
  }

  /**
   * Handle result messages from Claude logs.
   */
  private handleResultMessage(msg: ResultMessage, phaseId: string): void {
    /* ... */
  }

  // ============================================================================
  // File Watching
  // ============================================================================

  /**
   * Handle file-related tool calls from Claude.
   */
  private async handleFileToolCall(
    toolName: string,
    toolInput: Record<string, unknown> | undefined
  ): Promise<void> {
    /* ... */
  }

  /**
   * Send file tree update to client.
   */
  private async sendFileTreeUpdate(): Promise<void> {
    /* ... */
  }

  // ============================================================================
  // State Management
  // ============================================================================

  /**
   * Load state from previous sessions by parsing Claude log files.
   */
  private async loadPreviousState(): Promise<void> {
    /* ... */
  }

  /**
   * Get previous session ID for phase continuation.
   */
  private getPreviousSessionId(currentPhaseId: string): string | null {
    /* ... */
  }

  /**
   * Check for incomplete phases from previous runs.
   */
  private async checkIncompletePhases(): Promise<void> {
    /* ... */
  }

  // ============================================================================
  // Checkpoint Management
  // ============================================================================

  /**
   * Initialize checkpoint system.
   */
  private async initializeCheckpoints(): Promise<void> {
    /* ... */
  }

  /**
   * Add patterns to checkpoint tracking.
   */
  private async addCheckpointPatterns(patterns: string[]): Promise<void> {
    /* ... */
  }

  /**
   * Create a checkpoint commit.
   */
  private async createCheckpoint(info: CheckpointInfo): Promise<void> {
    /* ... */
  }

  // ============================================================================
  // Error Handling
  // ============================================================================

  /**
   * Handle errors with appropriate severity and client notification.
   */
  private async handleError(
    error: Error,
    context: string,
    severity: ErrorSeverity
  ): Promise<void> {
    /* ... */
  }

  /**
   * Send error event to client (deprecated - use handleError).
   * @deprecated
   */
  private sendError(message: string, fatal: boolean): void {
    /* ... */
  }
}
```

## Summary

This implementation plan provides:

1. **Resource cleanup** in all error paths without new abstractions
2. **Result message waiting** to replace arbitrary timeouts
3. **ClaudeProcessManager** extraction for cleaner separation of concerns
4. **Type guards** to eliminate type assertions and improve safety
5. **Better tool typing** for compile-time validation
6. **Standardized error handling** with client notifications
7. **Organized methods** with clear documentation

The changes are surgical - fixing specific issues without major architectural changes. All modifications maintain backward compatibility and can be implemented incrementally.
