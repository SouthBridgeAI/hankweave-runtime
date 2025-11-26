<server/basic-tui.ts>
import type { TadpoleServer } from "./tadpole-server.js";
import type {
  CheckpointListEvent,
  ClientCommand,
  NextPhaseCommand,
  ServerEvent,
  SkipPhaseCommand,
} from "./types/types.js";
import { generateId } from "./utils.js";

// ANSI color codes for terminal formatting
const COLORS = {
  // Basic colors
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",

  // Foreground colors
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",

  // Background colors
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m",
} as const;

// Character symbols to replace emojis
const SYMBOLS = {
  check: "✓",
  cross: "✗",
  arrow: "→",
  dot: "•",
  box: "▪",
  dash: "─",
  pipe: "│",
  corner: "└",
  branch: "├",
} as const;

/**
 * Basic Terminal UI for testing and debugging the server.
 *
 * Provides:
 * - WebSocket client that connects to the server
 * - Real-time event display in the terminal with color coding
 * - Keyboard shortcuts for common commands
 * - Structured output with boxes and formatting
 *
 * Usage: Run server with --basic flag
 * Controls: [n] next phase, [s] skip current, [q] quit
 */
export class BasicTUI {
  private ws: WebSocket | null = null;
  private isConnected = false;
  private checkpoints: CheckpointListEvent["data"]["checkpoints"] = [];
  private waitingForCheckpoints = false;

  constructor(private server: TadpoleServer) {
    this.connectToServer();
    this.setupKeyboardInput();
  }

  private connectToServer(): void {
    const port = this.server.config?.port || 7777;
    const url = `ws://localhost:${port}`;

    console.log(`${COLORS.dim}${SYMBOLS.pipe} Connecting to ${url}...${COLORS.reset}`);

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.isConnected = true;
      console.log(`${COLORS.green}${SYMBOLS.check} Connected to server${COLORS.reset}`);
    };

    this.ws.onmessage = (event) => {
      try {
        const serverEvent = JSON.parse(event.data) as ServerEvent;
        this.handleServerEvent(serverEvent);
      } catch (error) {
        console.error(
          `${COLORS.red}${SYMBOLS.cross} Failed to parse server message:${COLORS.reset}`,
          error,
        );
      }
    };

    this.ws.onerror = (error) => {
      console.error(`${COLORS.red}${SYMBOLS.cross} WebSocket error:${COLORS.reset}`, error);
    };

    this.ws.onclose = () => {
      this.isConnected = false;
      console.log(`${COLORS.dim}${SYMBOLS.pipe} Disconnected from server${COLORS.reset}`);
      // Server shutdown will handle process exit
    };
  }

  private formatTimestamp(timestamp: string): string {
    return `${COLORS.dim}[${new Date(timestamp).toLocaleTimeString()}]${COLORS.reset}`;
  }

  private drawBox(title: string, content: string[], color: string = COLORS.white): void {
    const maxLength = Math.max(title.length, ...content.map((line) => this.stripAnsi(line).length));
    const boxWidth = maxLength + 4;

    // Top border
    console.log(`${color}┌${"─".repeat(boxWidth - 2)}┐${COLORS.reset}`);

    // Title
    const titlePadding = Math.floor((boxWidth - 2 - title.length) / 2);
    console.log(
      `${color}│${" ".repeat(titlePadding)}${COLORS.bold}${title}${COLORS.reset}${color}${" ".repeat(boxWidth - 2 - titlePadding - title.length)}│${COLORS.reset}`,
    );

    // Separator
    console.log(`${color}├${"─".repeat(boxWidth - 2)}┤${COLORS.reset}`);

    // Content
    for (const line of content) {
      const strippedLength = this.stripAnsi(line).length;
      const padding = boxWidth - 2 - strippedLength;
      console.log(`${color}│ ${line}${" ".repeat(padding - 1)}${color}│${COLORS.reset}`);
    }

    // Bottom border
    console.log(`${color}└${"─".repeat(boxWidth - 2)}┘${COLORS.reset}`);
  }

  private stripAnsi(str: string): string {
    // ANSI escape sequences need control characters - this is intentional
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Required for ANSI stripping
    return str.replace(/\u001b\[[0-9;]*m/g, "");
  }

  private async handleServerEvent(event: ServerEvent): Promise<void> {
    const timestamp = this.formatTimestamp(event.timestamp);

    switch (event.type) {
      case "server.ready":
        console.log(`\n${timestamp} ${COLORS.green}${COLORS.bold}Server Ready${COLORS.reset}`);
        console.log(
          `${COLORS.dim}  ${SYMBOLS.arrow} Version: ${event.data.serverVersion}${COLORS.reset}`,
        );
        console.log(
          `${COLORS.dim}  ${SYMBOLS.arrow} Execution: ${event.data.executionPath}${COLORS.reset}`,
        );
        break;

      case "state.snapshot": {
        console.log(`\n${timestamp} ${COLORS.blue}State Snapshot${COLORS.reset}`);
        if (event.data.recentFileAccess) {
          console.log(
            `${COLORS.dim}  ${SYMBOLS.arrow} Recent file: ${event.data.recentFileAccess.path}${COLORS.reset}`,
          );
        }
        console.log(
          `  ${SYMBOLS.arrow} Total cost: ${COLORS.yellow}$${event.data.totalCost.toFixed(4)}${COLORS.reset}`,
        );
        break;
      }

      case "phase.started": {
        console.log(`\n${timestamp} ${COLORS.cyan}${COLORS.bold}Phase Started${COLORS.reset}`);
        this.drawBox(
          event.data.phaseName,
          [
            `Session: ${COLORS.dim}${event.data.sessionId}${COLORS.reset}`,
            ...(event.data.previousSessionId
              ? [`Continuing from: ${COLORS.dim}${event.data.previousSessionId}${COLORS.reset}`]
              : []),
            ...(event.data.phaseDescription ? [`${event.data.phaseDescription}`] : []),
          ],
          COLORS.cyan,
        );
        break;
      }

      case "phase.completed": {
        const status = event.data.success ? COLORS.green : COLORS.red;
        const statusSymbol = event.data.success ? SYMBOLS.check : SYMBOLS.cross;
        console.log(
          `\n${timestamp} ${status}${COLORS.bold}Phase Completed${COLORS.reset} ${status}${statusSymbol}${COLORS.reset}`,
        );

        const details = [
          `Cost: ${COLORS.yellow}$${event.data.cost.toFixed(4)}${COLORS.reset}`,
          `Duration: ${COLORS.dim}${(event.data.duration / 1000).toFixed(1)}s${COLORS.reset}`,
        ];

        if (!event.data.success && event.data.failureReason) {
          details.push(
            `Failure: ${COLORS.red}${event.data.failureReason.type}${COLORS.reset} (retriable: ${event.data.failureReason.retriable ? `${COLORS.green}yes` : `${COLORS.red}no`}${COLORS.reset})`,
          );
          if (event.data.failureReason.message) {
            details.push(
              `Message: ${COLORS.dim}${event.data.failureReason.message}${COLORS.reset}`,
            );
          }
        }

        this.drawBox(`Phase ${event.data.phaseId}`, details, status);
        break;
      }

      case "assistant.action": {
        if (event.data.action === "message") {
          console.log(`\n${timestamp} ${COLORS.bold}Assistant${COLORS.reset}`);
          // Split message by newlines and indent
          const lines = event.data.content.split("\n");
          for (const line of lines) {
            console.log(`  ${SYMBOLS.pipe} ${line}`);
          }
        } else if (event.data.action === "thinking") {
          console.log(`\n${timestamp} ${COLORS.gray}${COLORS.italic}Thinking${COLORS.reset}`);
          // Split thinking by newlines and indent with gray
          const lines = event.data.content.split("\n");
          for (const line of lines) {
            console.log(`${COLORS.gray}${COLORS.italic}  ${SYMBOLS.pipe} ${line}${COLORS.reset}`);
          }
        } else if (event.data.action === "tool_use") {
          const toolColor = this.getToolColor(event.data.toolName || "unknown");
          console.log(`\n${timestamp} ${toolColor}Tool Use: ${event.data.toolName}${COLORS.reset}`);
          if (event.data.toolInput) {
            console.log(
              `${COLORS.dim}  ${SYMBOLS.arrow} Input: ${JSON.stringify(event.data.toolInput, null, 2).replace(/\n/g, "\n    ")}${COLORS.reset}`,
            );
          }
        }
        break;
      }

      case "tool.result": {
        const toolColor = this.getToolColor(event.data.toolName);
        const statusColor = event.data.isError ? COLORS.red : COLORS.green;
        console.log(
          `\n${timestamp} ${toolColor}Tool Result: ${event.data.toolName}${COLORS.reset} ${statusColor}[${event.data.executionTimeMs}ms]${COLORS.reset}`,
        );

        // For file read/write operations, show full content unless it's creation/write
        const shouldTruncate =
          ["Write", "Create"].includes(event.data.toolName) && event.data.result.length > 500;

        if (shouldTruncate) {
          console.log(
            `${COLORS.dim}  ${SYMBOLS.arrow} Result: ${event.data.result.substring(0, 200)}...${COLORS.reset}`,
          );
          console.log(
            `${COLORS.dim}  ${SYMBOLS.arrow} (Truncated ${event.data.originalLength} bytes to 200 chars)${COLORS.reset}`,
          );
        } else {
          // Show full result with proper indentation
          const resultLines = event.data.result.split("\n");
          if (resultLines.length === 1) {
            console.log(
              `${COLORS.dim}  ${SYMBOLS.arrow} Result: ${event.data.result}${COLORS.reset}`,
            );
          } else {
            console.log(`${COLORS.dim}  ${SYMBOLS.arrow} Result:${COLORS.reset}`);
            for (const line of resultLines) {
              console.log(`${COLORS.dim}    ${SYMBOLS.pipe} ${line}${COLORS.reset}`);
            }
          }
        }

        if (event.data.isError) {
          console.log(`${COLORS.red}  ${SYMBOLS.cross} Tool execution failed${COLORS.reset}`);
        }
        break;
      }

      case "token.usage": {
        console.log(`\n${timestamp} ${COLORS.yellow}Token Usage${COLORS.reset}`);
        console.log(
          `  ${SYMBOLS.arrow} Input: ${event.data.inputTokens}, Output: ${event.data.outputTokens}`,
        );
        console.log(
          `  ${SYMBOLS.arrow} Cost: ${COLORS.yellow}$${event.data.totalCost.toFixed(4)}${COLORS.reset}`,
        );
        break;
      }

      case "file.updated": {
        const actionColor =
          event.data.action === "created"
            ? COLORS.green
            : event.data.action === "deleted"
              ? COLORS.red
              : COLORS.yellow;
        console.log(
          `\n${timestamp} ${actionColor}File ${event.data.action}${COLORS.reset}: ${COLORS.bold}${event.data.path}${COLORS.reset}`,
        );
        break;
      }

      case "filetree.updated": {
        console.log(
          `\n${timestamp} ${COLORS.magenta}File Tree Updated${COLORS.reset} (${event.data.tree.length} root items)`,
        );
        break;
      }

      case "error": {
        console.log(`\n${timestamp} ${COLORS.red}${COLORS.bold}Error${COLORS.reset}`);
        this.drawBox(
          "Error Details",
          [
            `${event.data.message}`,
            ...(event.data.context
              ? [`Context: ${COLORS.dim}${event.data.context}${COLORS.reset}`]
              : []),
            ...(event.data.phase ? [`Phase: ${event.data.phase}`] : []),
            ...(event.data.code ? [`Code: ${event.data.code}`] : []),
            `Fatal: ${event.data.fatal ? `${COLORS.red}yes` : `${COLORS.green}no`}${COLORS.reset}`,
          ],
          COLORS.red,
        );
        break;
      }

      case "incomplete.phase": {
        console.log(
          `\n${timestamp} ${COLORS.yellow}${COLORS.bold}Incomplete Phase Detected${COLORS.reset}`,
        );
        console.log(`  ${SYMBOLS.arrow} Phase: ${event.data.phaseName}`);
        console.log(`  ${SYMBOLS.arrow} ${event.data.message}`);
        break;
      }

      case "info": {
        console.log(`\n${timestamp} ${COLORS.blue}Info${COLORS.reset}: ${event.data.message}`);
        break;
      }

      case "server.idle": {
        console.log(`\n${timestamp} ${COLORS.dim}Server Idle${COLORS.reset}`);
        console.log(`  ${SYMBOLS.arrow} Reason: ${event.data.reason}`);
        console.log(`  ${SYMBOLS.arrow} ${event.data.message}`);
        break;
      }

      case "checkpoint.list": {
        // Store checkpoints for interactive selection
        this.checkpoints = event.data.checkpoints;

        if (this.waitingForCheckpoints) {
          // We're in interactive mode - show selection menu
          this.waitingForCheckpoints = false;
          await this.showCheckpointSelection(event.data);
        } else {
          // Regular display mode
          console.log(
            `\n${timestamp} ${COLORS.magenta}Checkpoints${COLORS.reset} in run ${event.data.runId}:`,
          );

          if (event.data.checkpoints.length === 0) {
            console.log(`  ${SYMBOLS.dot} No checkpoints found`);
          } else {
            this.drawBox(
              "Available Checkpoints",
              event.data.checkpoints.map(
                (cp, index) =>
                  `[${COLORS.bold}${index + 1}${COLORS.reset}] ${cp.phaseName} ${COLORS.dim}(${cp.checkpointType})${COLORS.reset} ${COLORS.gray}${cp.sha.substring(0, 7)}${COLORS.reset}`,
              ),
              COLORS.magenta,
            );
          }
        }
        break;
      }

      case "rollback.started": {
        console.log(`\n${timestamp} ${COLORS.yellow}${COLORS.bold}Rollback Started${COLORS.reset}`);
        console.log(`  ${SYMBOLS.arrow} From: ${event.data.fromPhase} (run ${event.data.fromRun})`);
        console.log(`  ${SYMBOLS.arrow} To: ${event.data.toPhase} (${event.data.checkpointType})`);
        console.log(`  ${SYMBOLS.arrow} Processing ${event.data.phasesToProcess.length} phases`);
        break;
      }

      case "rollback.progress": {
        const progress = Math.floor((event.data.currentStep / event.data.totalSteps) * 20);
        const progressBar = `[${"█".repeat(progress)}${" ".repeat(20 - progress)}]`;
        console.log(
          `\r${COLORS.yellow}Rollback Progress${COLORS.reset} ${progressBar} ${event.data.currentStep}/${event.data.totalSteps} - ${event.data.message}`,
        );
        break;
      }

      case "rollback.phaseCheckpoint": {
        console.log(`\n${timestamp} ${COLORS.cyan}Checkpoint Applied${COLORS.reset}`);
        console.log(`  ${SYMBOLS.arrow} ${event.data.message}`);
        break;
      }

      case "rollback.workspaceCleanup": {
        const statusColor =
          event.data.status === "completed"
            ? COLORS.green
            : event.data.status === "failed"
              ? COLORS.red
              : event.data.status === "partial"
                ? COLORS.yellow
                : COLORS.blue;
        console.log(
          `\n${timestamp} ${statusColor}Workspace Cleanup: ${event.data.status}${COLORS.reset}`,
        );
        console.log(`  ${SYMBOLS.arrow} Phase: ${event.data.phaseName}`);
        if (event.data.successfulCleanups && event.data.successfulCleanups.length > 0) {
          console.log(`  ${SYMBOLS.check} Cleaned: ${event.data.successfulCleanups.join(", ")}`);
        }
        if (event.data.failedCleanups && event.data.failedCleanups.length > 0) {
          for (const failure of event.data.failedCleanups) {
            console.log(
              `  ${COLORS.red}${SYMBOLS.cross} Failed: ${failure.directory} - ${failure.error}${COLORS.reset}`,
            );
          }
        }
        break;
      }

      case "rollback.completed": {
        console.log(
          `\n${timestamp} ${COLORS.green}${COLORS.bold}Rollback Completed${COLORS.reset}`,
        );
        this.drawBox(
          "Rollback Summary",
          [
            `From run: ${event.data.fromRun}`,
            `To run: ${event.data.toRun}`,
            `Phase: ${event.data.phaseName} (${event.data.checkpointType})`,
            `Checkpoint: ${COLORS.gray}${event.data.checkpoint.substring(0, 7)}${COLORS.reset}`,
          ],
          COLORS.green,
        );
        break;
      }

      default: {
        // Show all unknown events for debugging
        // Cast to a generic event structure for debugging
        const unknownEvent = event as { type: string; data?: unknown };
        console.log(
          `\n${timestamp} ${COLORS.gray}Unknown Event: ${unknownEvent.type}${COLORS.reset}`,
        );
        console.log(
          `${COLORS.dim}${JSON.stringify(unknownEvent.data ?? {}, null, 2)}${COLORS.reset}`,
        );
      }
    }
  }

  private getToolColor(toolName: string): string {
    // Color code different tool types
    switch (toolName) {
      case "Read":
      case "MultiRead":
        return COLORS.blue;
      case "Write":
      case "Edit":
      case "MultiEdit":
        return COLORS.yellow;
      case "Create":
      case "Delete":
        return COLORS.red;
      case "List":
      case "Find":
        return COLORS.cyan;
      case "Execute":
      case "Run":
        return COLORS.magenta;
      default:
        return COLORS.white;
    }
  }

  private sendCommand(command: ClientCommand): void {
    if (!this.isConnected || !this.ws) {
      console.error(`${COLORS.red}${SYMBOLS.cross} Not connected to server${COLORS.reset}`);
      return;
    }

    this.ws.send(JSON.stringify(command));
  }

  private setupKeyboardInput(): void {
    console.log(`\n${COLORS.bold}Commands:${COLORS.reset}`);
    console.log(`  ${COLORS.cyan}[n]${COLORS.reset} next phase`);
    console.log(`  ${COLORS.cyan}[s]${COLORS.reset} skip current`);
    console.log(`  ${COLORS.cyan}[f]${COLORS.reset} force stop`);
    console.log(`  ${COLORS.cyan}[l]${COLORS.reset} list checkpoints`);
    console.log(`  ${COLORS.cyan}[r]${COLORS.reset} rollback menu`);
    console.log(`  ${COLORS.cyan}[q]${COLORS.reset} quit\n`);

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    process.stdin.on("data", async (key: string) => {
      switch (key) {
        case "n":
          console.log(`\n${COLORS.cyan}${SYMBOLS.arrow} Advancing to next phase...${COLORS.reset}`);
          this.sendCommand({
            id: generateId(),
            type: "phase.next",
          } as NextPhaseCommand);
          break;

        case "s":
          console.log(
            `\n${COLORS.yellow}${SYMBOLS.arrow} Skipping current phase...${COLORS.reset}`,
          );
          this.sendCommand({
            id: generateId(),
            type: "phase.skip",
          } as SkipPhaseCommand);
          break;

        case "f":
          console.log(
            `\n${COLORS.red}${SYMBOLS.arrow} Force stopping current phase...${COLORS.reset}`,
          );
          this.sendCommand({
            id: generateId(),
            type: "phase.forceStop",
            data: { reason: "User requested from TUI" },
          } as ClientCommand);
          break;

        case "l":
          console.log(
            `\n${COLORS.magenta}${SYMBOLS.arrow} Requesting checkpoint list...${COLORS.reset}`,
          );
          this.sendCommand({
            id: generateId(),
            type: "checkpoint.list",
          });
          break;

        case "r":
          await this.showRollbackMenu();
          break;

        case "q":
        case "\u0003": // Ctrl+C
          console.log(`\n${COLORS.dim}${SYMBOLS.arrow} Shutting down...${COLORS.reset}`);
          if (this.ws) {
            this.ws.close();
          }
          this.server.shutdown("user request");
          break;
      }
    });
  }

  /**
   * Show interactive rollback menu
   */
  private async showRollbackMenu(): Promise<void> {
    console.log(`\n${COLORS.yellow}${COLORS.bold}Rollback Options${COLORS.reset}`);
    console.log(`  ${COLORS.cyan}[1]${COLORS.reset} Rollback to last successful phase`);
    console.log(`  ${COLORS.cyan}[2]${COLORS.reset} List checkpoints and select`);
    console.log(`  ${COLORS.cyan}[c]${COLORS.reset} Cancel`);

    const response = await this.waitForKey();

    switch (response) {
      case "1":
        await this.confirmAndRollback("last successful phase", async () => {
          this.sendCommand({
            id: generateId(),
            type: "rollback.toLastSuccess",
            data: { autoRestart: false },
          } as ClientCommand);
        });
        break;

      case "2":
        // Set flag to indicate we're waiting for interactive selection
        this.waitingForCheckpoints = true;
        this.sendCommand({
          id: generateId(),
          type: "checkpoint.list",
        });
        console.log(`\n${COLORS.dim}${SYMBOLS.arrow} Fetching checkpoints...${COLORS.reset}`);
        break;

      case "c":
        console.log(`\n${COLORS.red}${SYMBOLS.cross} Rollback cancelled${COLORS.reset}`);
        break;
    }
  }

  /**
   * Confirm rollback with effects
   */
  private async confirmAndRollback(target: string, action: () => Promise<void>): Promise<void> {
    console.log(`\n${COLORS.yellow}${COLORS.bold}Rollback Confirmation${COLORS.reset}`);
    this.drawBox(
      `Rollback to: ${target}`,
      [
        `${COLORS.yellow}This will:${COLORS.reset}`,
        `  ${SYMBOLS.dot} End the current run`,
        `  ${SYMBOLS.dot} Reset project files to checkpoint state`,
        `  ${SYMBOLS.dot} Start a new continuation run`,
        `  ${SYMBOLS.dot} Preserve all history in state.json`,
        "",
        `Continue? ${COLORS.cyan}(y/N)${COLORS.reset}:`,
      ],
      COLORS.yellow,
    );

    const response = await this.waitForKey();

    if (response === "y" || response === "Y") {
      await action();
    } else {
      console.log(`\n${COLORS.red}${SYMBOLS.cross} Rollback cancelled${COLORS.reset}`);
    }
  }

  /**
   * Show interactive checkpoint selection menu
   */
  private async showCheckpointSelection(data: CheckpointListEvent["data"]): Promise<void> {
    if (data.checkpoints.length === 0) {
      console.log(
        `\n${COLORS.red}${SYMBOLS.cross} No checkpoints found in current run${COLORS.reset}`,
      );
      return;
    }

    console.log(
      `\n${COLORS.magenta}${COLORS.bold}Select Checkpoint${COLORS.reset} (run ${data.runId}):`,
    );

    const checkpointLines = data.checkpoints.flatMap((cp, index) => {
      const timestamp = new Date(cp.timestamp).toLocaleTimeString();
      return [
        `${COLORS.cyan}[${index + 1}]${COLORS.reset} ${COLORS.bold}${cp.phaseName}${COLORS.reset} - ${cp.checkpointType} (${timestamp})`,
        `    SHA: ${COLORS.gray}${cp.sha.substring(0, 7)}...${COLORS.reset}`,
      ];
    });

    checkpointLines.push(`${COLORS.cyan}[c]${COLORS.reset} Cancel`);

    this.drawBox("Available Checkpoints", checkpointLines, COLORS.magenta);
    console.log(`\n${COLORS.bold}Enter your choice:${COLORS.reset} `);

    const response = await this.waitForKey();

    if (response === "c" || response === "C") {
      console.log(`\n${COLORS.red}${SYMBOLS.cross} Rollback cancelled${COLORS.reset}`);
      return;
    }

    const choice = parseInt(response, 10);
    if (Number.isNaN(choice) || choice < 1 || choice > data.checkpoints.length) {
      console.log(`\n${COLORS.red}${SYMBOLS.cross} Invalid selection${COLORS.reset}`);
      return;
    }

    const selectedCheckpoint = data.checkpoints[choice - 1];
    const target = `${selectedCheckpoint.phaseName} (${selectedCheckpoint.checkpointType})`;

    await this.confirmAndRollback(target, async () => {
      this.sendCommand({
        id: generateId(),
        type: "rollback.toCheckpoint",
        data: {
          checkpointSha: selectedCheckpoint.sha,
          autoRestart: false,
        },
      } as ClientCommand);
    });
  }

  /**
   * Wait for a single key press
   */
  private waitForKey(): Promise<string> {
    return new Promise((resolve) => {
      const handler = (key: string) => {
        process.stdin.removeListener("data", handler);
        resolve(key);
      };
      process.stdin.once("data", handler);
    });
  }
}

</server/basic-tui.ts>

<server/checkpoint-git.ts>
import fs from "node:fs";
import path from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";
import { fileResolver } from "./file-resolver.js";
import type { Logger } from "./utils.js";

/**
 * Git operations for the checkpoint system.
 * Handles the shadow git repository in .tadpole/checkpoints.
 */
export class CheckpointGit {
  private executionPath: string;
  private checkpointPath: string;
  private git: SimpleGit | null = null;
  private logger: Logger;
  private trackedPatterns: Set<string> = new Set();

  constructor(executionPath: string, logger: Logger) {
    this.executionPath = executionPath;
    this.checkpointPath = path.join(executionPath, ".tadpole", "checkpoints");
    this.logger = logger;
  }

  /**
   * Initialize the shadow git repository
   * @returns The initial commit SHA (either from new repo creation or existing repo HEAD)
   */
  async initialize(): Promise<string | undefined> {
    // Create checkpoint directory
    await fs.promises.mkdir(this.checkpointPath, { recursive: true });

    // Check if repository already exists
    const gitDir = path.join(this.checkpointPath, ".git");
    const repoExists = fs.existsSync(gitDir);

    if (repoExists) {
      // Repository exists - just set up git instance
      this.git = simpleGit(this.executionPath, {
        config: [
          `core.worktree=${this.executionPath}`,
          `core.gitdir=${path.join(this.checkpointPath, ".git")}`,
        ],
      }).env({
        GIT_DIR: path.join(this.checkpointPath, ".git"),
        GIT_WORK_TREE: this.executionPath,
        HOME: this.checkpointPath,
        XDG_CONFIG_HOME: this.checkpointPath,
      });

      try {
        // Get current HEAD as the initial checkpoint for this session
        const currentHead = await this.git.revparse(["HEAD"]);
        this.logger.log(`Using existing shadow git repository with HEAD: ${currentHead}`);
        return currentHead;
      } catch (error) {
        // Handle edge cases like empty repository
        this.logger.log(`Could not get HEAD from existing repository: ${error}`, "error");
        this.logger.log("Using existing shadow git repository");
        return undefined;
      }
    }

    // Create git config to isolate from user preferences
    const gitConfigPath = path.join(this.checkpointPath, ".gitconfig");
    const gitConfigContent = `[user]
  name = Tadpole Runner
  email = froggie@southbridge.ai
[commit]
  gpgsign = false
`;
    await fs.promises.writeFile(gitConfigPath, gitConfigContent);

    // Initialize git with proper environment
    this.git = simpleGit(this.executionPath, {
      config: [
        `core.worktree=${this.executionPath}`,
        `core.gitdir=${path.join(this.checkpointPath, ".git")}`,
      ],
    }).env({
      GIT_DIR: path.join(this.checkpointPath, ".git"),
      GIT_WORK_TREE: this.executionPath,
      HOME: this.checkpointPath,
      XDG_CONFIG_HOME: this.checkpointPath,
    });

    // Initialize repository
    await this.git.init(false, { "--initial-branch": "main" });
    await this.git.addConfig("user.name", "Tadpole Runner");
    await this.git.addConfig("user.email", "froggie@southbridge.ai");
    await this.git.addConfig("commit.gpgsign", "false");

    // Initial empty commit (don't add .gitignore to avoid conflicts with user's project)
    const result = await this.git.commit("Initial checkpoint setup", {
      "--allow-empty": null,
    });

    const initialSha = result.commit || undefined;
    this.logger.log(`Shadow git repository initialized with initial commit: ${initialSha}`);

    return initialSha;
  }

  /**
   * Check if repository is initialized
   */
  isInitialized(): boolean {
    return this.git !== null;
  }

  /**
   * Add patterns to track
   */
  async addPatterns(patterns: string[]): Promise<void> {
    for (const pattern of patterns) {
      this.trackedPatterns.add(pattern);
    }
    // No need to update gitignore - we'll use explicit file adds
  }

  /**
   * Clear all tracked patterns
   */
  clearPatterns(): void {
    this.trackedPatterns.clear();
    this.logger.log("Cleared all tracked patterns");
  }

  /**
   * Get resolved files for all tracked patterns
   */
  private async getTrackedFiles(): Promise<string[]> {
    if (this.trackedPatterns.size === 0) {
      return [];
    }

    const patterns = Array.from(this.trackedPatterns);
    // Use the unified file resolver to get files respecting gitignore
    const files = await fileResolver.resolveFiles(this.executionPath, patterns);
    return files;
  }

  /**
   * Create a checkpoint commit
   */
  async commit(message: string, options?: { branch?: string }): Promise<string | null> {
    if (!this.git) return null;

    this.logger.log(`[CHECKPOINT-COMMIT] Starting commit with message: ${message.split("\n")[0]}`);
    this.logger.log(
      `[CHECKPOINT-COMMIT] Tracked patterns: ${Array.from(this.trackedPatterns).join(", ")}`,
    );

    let originalBranch: string | undefined;

    // Always use the branch from options if provided
    if (options?.branch) {
      // Remember current branch to switch back later
      const currentBranchInfo = await this.git.branch();
      originalBranch = currentBranchInfo.current;
      this.logger.log(
        `[CHECKPOINT-COMMIT] Current branch: ${originalBranch}, switching to: ${options.branch}`,
      );

      // Check if branch exists
      const branches = await this.git.branch();
      if (!branches.all.includes(options.branch)) {
        // Create new branch from current HEAD
        this.logger.log(`[CHECKPOINT-COMMIT] Creating new branch: ${options.branch}`);
        await this.git.checkoutLocalBranch(options.branch);
      } else {
        // Switch to existing branch
        this.logger.log(`[CHECKPOINT-COMMIT] Switching to existing branch: ${options.branch}`);
        await this.git.checkout(options.branch);
      }
    }

    // Get resolved files to add
    const files = await this.getTrackedFiles();
    this.logger.log(`[CHECKPOINT-COMMIT] Resolved ${files.length} files to track`);
    if (files.length > 0) {
      this.logger.log(
        `[CHECKPOINT-COMMIT] First few files: ${files.slice(0, 5).join(", ")}${
          files.length > 5 ? "..." : ""
        }`,
      );
    }

    // Check working directory status before reset
    const statusBefore = await this.git.status();
    this.logger.log(
      `[CHECKPOINT-COMMIT] Status before reset - modified: ${statusBefore.modified.length}, not_added: ${statusBefore.not_added.length}`,
    );

    // IMPORTANT: Only reset the INDEX, not the working directory
    // Using 'mixed' reset (default) to only affect the index
    this.logger.log(
      `[CHECKPOINT-COMMIT] Resetting index (mixed mode - working directory unchanged)`,
    );
    await this.git.reset(["--mixed", "HEAD"]);

    // Check status after reset to confirm working directory unchanged
    const statusAfter = await this.git.status();
    this.logger.log(
      `[CHECKPOINT-COMMIT] Status after reset - modified: ${statusAfter.modified.length}, not_added: ${statusAfter.not_added.length}`,
    );

    // Explicitly add each resolved file
    if (files.length > 0) {
      // Add files in batches to avoid command line length limits
      const batchSize = 100;
      for (let i = 0; i < files.length; i += batchSize) {
        const batch = files.slice(i, i + batchSize);
        try {
          // Use force add to override any gitignore rules
          this.logger.log(
            `[CHECKPOINT-COMMIT] Adding batch ${
              Math.floor(i / batchSize) + 1
            }/${Math.ceil(files.length / batchSize)} (${batch.length} files)`,
          );
          await this.git.raw(["add", "-f", ...batch]);
        } catch (error) {
          this.logger.log(
            `[CHECKPOINT-COMMIT] Error adding files to checkpoint: ${error}`,
            "error",
          );
        }
      }
    }

    // Always create commit, even if empty (for semantic consistency)
    this.logger.log(`[CHECKPOINT-COMMIT] Creating commit`);
    const result = await this.git.commit(message, { "--allow-empty": null });

    const commitSha = result.commit || null;
    this.logger.log(`[CHECKPOINT-COMMIT] Commit complete: ${commitSha}`);
    return commitSha;
  }

  /**
   * Get the checkpoint repository path
   */
  getPath(): string {
    return this.checkpointPath;
  }

  /**
   * Switch to a specific branch
   */
  async switchToBranch(branchName: string): Promise<void> {
    if (!this.git) {
      throw new Error("Git repository not initialized");
    }

    try {
      const branches = await this.git.branch();
      if (branches.all.includes(branchName)) {
        await this.git.checkout(branchName);
        this.logger.log(`Switched to existing branch: ${branchName}`);
      } else {
        // Branch doesn't exist - this is expected for fresh runs
        // The branch will be created on the first checkpoint commit
        this.logger.log(`Branch ${branchName} not found - will be created on first checkpoint`);
      }
    } catch (error) {
      this.logger.log(`Failed to switch branch: ${error}`, "error");
    }
  }

  /**
   * Get all checkpoint SHAs from the repository
   * @returns Set of all commit SHAs in the repository
   */
  async getAllCheckpointShas(): Promise<Set<string>> {
    if (!this.git) {
      throw new Error("Git repository not initialized");
    }

    try {
      const log = await this.git.log(["--format=%H"]);
      return new Set(log.all.map((commit) => commit.hash));
    } catch (error) {
      this.logger.log(`Failed to get checkpoint SHAs: ${error}`, "error");
      return new Set();
    }
  }

  /**
   * Get all checkpoints with detailed information, ordered by time (newest first)
   * @returns Array of checkpoint information ordered by timestamp
   */
  async getAllCheckpoints(): Promise<
    Array<{
      sha: string;
      message: string;
      timestamp: string;
      branch: string;
    }>
  > {
    if (!this.git) {
      throw new Error("Git repository not initialized");
    }

    try {
      // Get all branches to check each one
      const branches = await this.git.branch();
      const allCheckpoints: Array<{
        sha: string;
        message: string;
        timestamp: string;
        branch: string;
      }> = [];

      // Get commits from all branches
      for (const branch of branches.all) {
        try {
          const log = await this.git.log([branch, "--format=%H|%s|%aI"]);

          for (const commit of log.all) {
            // Parse the custom format: hash|subject|authorDate
            const [sha, message, timestamp] = commit.hash.split("|");

            // Skip if we already have this commit from another branch
            if (!allCheckpoints.some((c) => c.sha === sha)) {
              allCheckpoints.push({
                sha: sha || commit.hash,
                message: message || commit.message,
                timestamp: timestamp || commit.date,
                branch,
              });
            }
          }
        } catch (error) {
          // Branch might not have any commits yet
          this.logger.log(`Could not get log for branch ${branch}: ${error}`, "debug");
        }
      }

      // Sort by timestamp descending (newest first)
      allCheckpoints.sort((a, b) => {
        const timeA = new Date(a.timestamp).getTime();
        const timeB = new Date(b.timestamp).getTime();
        return timeB - timeA;
      });

      return allCheckpoints;
    } catch (error) {
      this.logger.log(`Failed to get checkpoints: ${error}`, "error");
      return [];
    }
  }

  /**
   * Reset to a specific checkpoint
   */
  async resetToCheckpoint(sha: string): Promise<void> {
    if (!this.git) {
      throw new Error("Git repository not initialized");
    }

    this.logger.log(`[CHECKPOINT-DEBUG] Starting reset to checkpoint ${sha}`);

    // Verify SHA exists
    try {
      const log = await this.git.log();
      this.logger.log(`[CHECKPOINT-DEBUG] Found ${log.all.length} commits in log`);

      const commit = log.all.find((c) => c.hash.startsWith(sha));

      if (!commit) {
        this.logger.log(`[CHECKPOINT-DEBUG] Available commits:`);
        log.all.forEach((c, i) => {
          this.logger.log(
            `[CHECKPOINT-DEBUG]   ${i + 1}. ${c.hash.substring(0, 7)} - ${c.message}`,
          );
        });
        throw new Error(`Checkpoint ${sha} not found in repository`);
      }

      this.logger.log(`[CHECKPOINT-DEBUG] Found target commit: ${commit.hash} - ${commit.message}`);

      // Check current status before reset
      const statusBefore = await this.git.status();
      this.logger.log(
        `[CHECKPOINT-DEBUG] Status before reset - staged: ${statusBefore.staged.length}, modified: ${statusBefore.modified.length}, not_added: ${statusBefore.not_added.length}`,
      );

      // Hard reset to preserve exact file state
      const resetResult = await this.git.reset(["--hard", sha]);
      this.logger.log(`[CHECKPOINT-DEBUG] Git reset result: ${resetResult}`);

      // Check status after reset
      const statusAfter = await this.git.status();
      this.logger.log(
        `[CHECKPOINT-DEBUG] Status after reset - staged: ${statusAfter.staged.length}, modified: ${statusAfter.modified.length}, not_added: ${statusAfter.not_added.length}`,
      );

      // Show what files are in the working directory after reset
      const currentHead = await this.git.revparse(["HEAD"]);
      this.logger.log(`[CHECKPOINT-DEBUG] Current HEAD after reset: ${currentHead}`);

      this.logger.log(`[CHECKPOINT-DEBUG] Reset to checkpoint ${sha}: ${commit.message}`);
    } catch (error) {
      this.logger.log(`[CHECKPOINT-DEBUG] Reset failed: ${error}`);
      throw new Error(
        `Failed to reset to checkpoint: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

</server/checkpoint-git.ts>

<server/claude-log-parser.ts>
import fs from "node:fs";
import {
  type AssistantMessage,
  logMessageSchema,
  type ResultMessage,
  type SystemMessage,
  type UserMessage,
} from "./types/claude-session-schema.js";

/**
 * Configuration options for Claude log parser.
 */
export interface ClaudeLogParserOptions {
  /** Path to the Claude JSONL log file to parse */
  logPath: string;
  /** ID of the phase being parsed (for context) */
  phaseId: string;
  /** Callback for system messages (init, info) */
  onSystemMessage?: (msg: SystemMessage) => void;
  /** Callback for assistant messages (Claude's responses) */
  onAssistantMessage?: (msg: AssistantMessage) => void;
  /** Callback for user messages (tool results) */
  onUserMessage?: (msg: UserMessage) => void;
  /** Callback for result messages (success/error) */
  onResultMessage?: (msg: ResultMessage) => void;
  /** How often to check for new log entries (milliseconds) */
  parsingInterval: number;
}

/**
 * Real-time parser for Claude's JSON log output.
 *
 * Watches a log file and parses new lines as they're written,
 * validating them against the Claude session schema and calling
 * appropriate callbacks for each message type.
 *
 * Uses both file watching and periodic polling to ensure no
 * messages are missed.
 */
export class ClaudeLogParser {
  private buffer = ""; // Incomplete line buffer
  private lastPosition = 0; // Last read position in file
  private logTimer?: NodeJS.Timeout;
  private isFirstParse = true; // Track if this is the first parse

  constructor(private options: ClaudeLogParserOptions) {}

  start(): void {
    const { parsingInterval } = this.options;

    // Set up periodic parsing
    this.logTimer = setInterval(() => this.parseLogFile(), parsingInterval);

    // Initial parse
    this.parseLogFile();
  }

  stop(): void {
    if (this.logTimer) {
      clearInterval(this.logTimer);
      this.logTimer = undefined;
    }
    // NEW: Clear buffer to free memory
    this.buffer = "";
    this.lastPosition = 0;
  }

  /**
   * Force an immediate parse of the log file.
   * Useful when we need to ensure all messages are processed before process termination.
   */
  public parseNow(): void {
    this.parseLogFile();
  }

  private parseLogFile(): void {
    const { logPath } = this.options;
    if (!fs.existsSync(logPath)) {
      return;
    }

    try {
      const content = fs.readFileSync(logPath, "utf-8");

      // On first parse, read from beginning to catch any messages written before we started
      const newContent = this.isFirstParse ? content : content.slice(this.lastPosition);
      if (!newContent) {
        return;
      }

      this.buffer += newContent;
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          this.parseLogLine(line);
        }
      }

      this.lastPosition = content.length - this.buffer.length;
      this.isFirstParse = false; // Mark that we've done our first parse
    } catch (error) {
      console.error(`Error parsing log: ${error}`);
    }
  }

  private parseLogLine(line: string): void {
    try {
      const parsed = JSON.parse(line);
      const result = logMessageSchema.safeParse(parsed);
      if (!result.success) {
        // Log validation failures for debugging - especially important for system init messages
        if (parsed.type === "system" && parsed.subtype === "init") {
          console.error(
            `[ClaudeLogParser] Failed to parse system init message for phase ${this.options.phaseId}:`,
            result.error.format(),
          );
          console.error(
            `[ClaudeLogParser] Message that failed validation:`,
            JSON.stringify(parsed, null, 2),
          );
        }
        return; // Skip invalid messages
      }

      const message = result.data;

      switch (message.type) {
        case "system":
          if (this.options.onSystemMessage) {
            this.options.onSystemMessage(message);
          }
          break;

        case "assistant":
          if (this.options.onAssistantMessage) {
            this.options.onAssistantMessage(message);
          }
          break;

        case "user":
          if (this.options.onUserMessage) {
            this.options.onUserMessage(message);
          }
          break;

        case "result":
          if (this.options.onResultMessage) {
            this.options.onResultMessage(message);
          }
          break;
      }
    } catch {
      // Invalid JSON, skip
    }
  }
}

</server/claude-log-parser.ts>

<server/claude-process-manager.ts>
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ClaudeLogParser } from "./claude-log-parser.js";
import { TIMEOUTS } from "./config.js";
import { type ProcessEvents, TypedEventEmitter } from "./typed-event-emitter.js";
import type { PhaseConfig } from "./types/types.js";
import { escapeShellArg, type Logger } from "./utils.js";

/**
 * Manages Claude subprocess lifecycle, including spawning, monitoring, and cleanup.
 * Handles log stream creation and process argument building.
 */
export class ClaudeProcessManager extends TypedEventEmitter<ProcessEvents> {
  private process: ChildProcess | undefined;
  private logStream: fs.WriteStream | undefined;
  private killed = false;

  constructor(
    private executionPath: string,
    private logger: Logger,
    private logParser: ClaudeLogParser,
    private anthropicBaseURL?: string,
    private modelOverride?: import("./types/types.js").ModelName,
  ) {
    super();
  }

  /**
   * Spawn a Claude process for the given phase configuration.
   * Sets up logging, environment, and process monitoring.
   *
   * @param phase - Phase configuration
   * @param previousSessionId - Session ID to continue from (if any)
   * @param logPath - Custom log file path (optional, defaults to .tadpole/logs/)
   */
  async spawn(
    phase: PhaseConfig,
    previousSessionId: string | null,
    logPath?: string,
  ): Promise<string> {
    if (this.process) {
      throw new Error("Process already running");
    }

    // Use provided logPath or default to .tadpole/logs/
    const actualLogPath =
      logPath || path.join(this.executionPath, `.tadpole/logs/log-${phase.id}.jsonl`);

    // Ensure log directory exists
    const logsDir = path.dirname(actualLogPath);
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    // Create log stream
    this.logStream = fs.createWriteStream(actualLogPath);

    // Build Claude arguments
    const args = this.buildClaudeArgs(phase, previousSessionId);

    // Set up environment
    const env = { ...process.env }; // Start with server's environment

    // Pass through TADPOLE_ prefixed variables from server environment
    for (const key in process.env) {
      if (key.startsWith("TADPOLE_")) {
        const newKey = key.substring("TADPOLE_".length);
        env[newKey] = process.env[key];
        this.logger.log(`Passing through env var: ${newKey}`);
      }
    }

    if (this.anthropicBaseURL) {
      env.ANTHROPIC_BASE_URL = this.anthropicBaseURL;
      this.logger.log(`Using custom Anthropic base URL: ${this.anthropicBaseURL}`);
    }

    // Add phase-specific environment variables from config
    // These will override any existing variables with the same name
    if (phase.env) {
      this.logger.log("Applying phase-specific environment variables...");
      Object.assign(env, phase.env);
    }

    // Log the exact command being run
    const fullCommand = `claude ${args.join(" ")}`;
    this.logger.log(`Executing Claude command: ${fullCommand}`);
    this.logger.log(`Working directory: ${this.executionPath}`);

    // Additional debugging
    this.logger.log(`Current process.cwd(): ${process.cwd()}`);
    this.logger.log(`Absolute executionPath: ${path.resolve(this.executionPath)}`);
    this.logger.log(`Execution path exists: ${fs.existsSync(this.executionPath)}`);
    this.logger.log(
      `Execution path is directory: ${
        fs.existsSync(this.executionPath) && fs.statSync(this.executionPath).isDirectory()
      }`,
    );

    // Spawn process
    this.process = spawn("claude", args, {
      cwd: this.executionPath,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    this.killed = false;

    // Pipe stdout to log file with error handling
    if (this.process.stdout) {
      this.process.stdout.pipe(this.logStream);

      // Handle pipe errors
      this.process.stdout.on("error", (error) => {
        this.logger.log(`Stdout pipe error: ${error.message}`, "error");
      });

      this.logStream.on("error", (error) => {
        this.logger.log(`Log stream error: ${error.message}`, "error");
      });
    }

    // Set up event handlers
    this.setupProcessHandlers();

    // Feed prompt to stdin
    await this.feedPrompt(phase);

    this.logger.log(`Claude process started for phase ${phase.id} (PID: ${this.process.pid})`);

    return actualLogPath;
  }

  /**
   * Build command line arguments for Claude CLI.
   */
  private buildClaudeArgs(phase: PhaseConfig, previousSessionId: string | null): string[] {
    // Use model override if provided, otherwise use phase model
    const model = this.modelOverride || phase.model;

    const args = [
      "--verbose",
      "--dangerously-skip-permissions",
      "--model",
      model,
      "--permission-mode",
      "bypassPermissions",
      "-p",
      "--output-format",
      "stream-json",
    ];

    // Log model usage
    if (this.modelOverride) {
      this.logger.log(`Using model override: ${model} (phase config specified: ${phase.model})`);
    }

    if (phase.continuationMode === "continue-previous" && previousSessionId) {
      args.push("-c", "--resume", previousSessionId);
    }

    // Handle system prompt if provided
    const systemPrompt = this.buildSystemPrompt(phase);
    if (systemPrompt) {
      args.push("--append-system-prompt", escapeShellArg(systemPrompt));
      this.logger.log(`Added system prompt to Claude (${systemPrompt.length} chars)`);
      this.logger.log(`System prompt content:\n${systemPrompt}`);
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
      return content
        .replace(/<%PROJECT_DIR%>/g, this.executionPath) // Legacy support
        .replace(/<%EXECUTION_DIR%>/g, this.executionPath)
        .replace(/<%DATA_DIR%>/g, path.join(this.executionPath, "read_only_data_source"));
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
      const files = Array.isArray(phase.promptFile) ? phase.promptFile : [phase.promptFile];
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

    const processedContent = promptContent
      .replace(/<%PROJECT_DIR%>/g, this.executionPath) // Legacy support
      .replace(/<%EXECUTION_DIR%>/g, this.executionPath)
      .replace(/<%DATA_DIR%>/g, path.join(this.executionPath, "read_only_data_source"));

    this.process.stdin.write(processedContent);
    this.process.stdin.end();

    this.logger.log(`Fed prompt to Claude (${processedContent.length} chars)`);
    this.logger.log(`Prompt content:\n${processedContent}`);
  }

  /**
   * Set up process event handlers.
   */
  private setupProcessHandlers(): void {
    if (!this.process) return;

    this.process.on("exit", (code, signal) => {
      this.logger.log(`Claude process exited with code: ${code}, signal: ${signal}`);
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
      const errorMessage = data.toString().trim();
      this.logger.log(`Claude stderr: ${errorMessage}`, "error");

      // Write to log file as JSON entry (matching server behavior)
      if (this.logStream && !this.logStream.destroyed) {
        this.logStream.write(
          `{"type":"stderr","timestamp":"${new Date().toISOString()}","message":${JSON.stringify(
            errorMessage,
          )}}\n`,
        );
      }

      this.emit("stderr", errorMessage);
    });
  }

  /**
   * Kill the Claude process.
   */
  async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (!this.process || this.killed) return;

    this.killed = true;
    this.logger.log(`Killing Claude process with ${signal}`);

    // Force an immediate parse of the log file to capture any final messages
    // This ensures we don't lose token counts or other important data when killing
    this.logParser.parseNow();

    // Give the log parser a moment to process any final messages
    await new Promise((resolve) => setTimeout(resolve, 100));

    this.process.kill(signal);

    // Give it 5 seconds to die gracefully
    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        if (!this.process || this.process.killed) {
          clearInterval(checkInterval);
          resolve();
        }
      }, TIMEOUTS.LOG_PARSER_DELAY_MS);

      setTimeout(() => {
        clearInterval(checkInterval);
        if (this.process && !this.process.killed) {
          this.logger.log("Force killing Claude process with SIGKILL");
          this.process.kill("SIGKILL");
        }
        resolve();
      }, TIMEOUTS.PROCESS_KILL_GRACE_MS);
    });
  }

  /**
   * Clean up resources.
   */
  private cleanup(): void {
    if (this.logStream && !this.logStream.destroyed) {
      this.logStream.end();
      this.logStream = undefined;
    }

    if (this.process) {
      this.process.removeAllListeners();
      this.process = undefined;
    }
  }

  /**
   * Check if process is running.
   */
  isRunning(): boolean {
    return this.process !== undefined && !this.process.killed;
  }

  /**
   * Get process PID.
   */
  getPid(): number | undefined {
    return this.process?.pid;
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
}

</server/claude-process-manager.ts>

<server/cleanup-command.ts>
import fs from "node:fs";
import path from "node:path";
import { findExecutionDirs, hashDataSource } from "./data-hasher.js";
import { formatSize, getDirectorySize } from "./utils.js";

export interface CleanupOptions {
  dataSourcePath?: string; // For finding by hash
  executionPath?: string; // For direct cleanup
  skipConfirmation: boolean;
}

export interface CleanupResult {
  success: boolean;
  directoriesRemoved: string[];
  warnings: string[];
  errors: string[];
}

export class CleanupCommand {
  constructor(private options: CleanupOptions) {}

  async execute(): Promise<CleanupResult> {
    const result: CleanupResult = {
      success: false,
      directoriesRemoved: [],
      warnings: [],
      errors: [],
    };

    try {
      let dirsToRemove: string[] = [];

      if (this.options.executionPath) {
        // Direct execution path cleanup - just clean this one
        dirsToRemove = [this.options.executionPath];
      } else if (this.options.dataSourcePath) {
        // Validate data source exists
        if (!fs.existsSync(this.options.dataSourcePath)) {
          result.errors.push(`Data source not found: ${this.options.dataSourcePath}`);
          return result;
        }

        // Find by data hash - ONLY clean up the latest
        console.log("Calculating data signature for cleanup...");
        const dataHash = await hashDataSource(this.options.dataSourcePath);
        console.log(`Data signature: ${dataHash}`);

        const allDirs = await findExecutionDirs(dataHash);

        if (allDirs.length === 0) {
          console.log("No execution directories found for this data source.");
          result.success = true;
          return result;
        }

        // UPDATED: Only clean up the latest (first in sorted list)
        dirsToRemove = [allDirs[0]];

        // Show all directories found but note we're only cleaning the latest
        if (allDirs.length > 1) {
          console.log(`Found ${allDirs.length} execution directories.`);
          console.log("Only the latest will be cleaned up.\n");
        }
      } else {
        throw new Error("Either dataSourcePath or executionPath must be provided");
      }

      // Display what will be removed
      console.log("🧹 Tadpole Cleanup Tool\n");
      console.log("The following execution directory will be removed:\n");

      for (const dir of dirsToRemove) {
        const metaPath = path.join(dir, ".tadpole", "execution-meta.json");
        try {
          const meta = JSON.parse(await fs.promises.readFile(metaPath, "utf-8"));
          console.log(`📁 ${dir}`);
          console.log(`   Created: ${meta.createdAt}`);
          console.log(`   Last used: ${meta.lastUsed}`);
          console.log(`   Link type: ${meta.linkType}`);
          console.log(`   Original data: ${meta.readOnlySourceDataPath}`);

          // Calculate size
          const size = await getDirectorySize(dir);
          console.log(`   Size: ${formatSize(size)}`);
        } catch {
          console.log(`📁 ${dir} (metadata unavailable)`);
        }
        console.log();
      }

      // If there are other directories, list them but note they won't be removed
      if (this.options.dataSourcePath) {
        const allDirs = await findExecutionDirs(await hashDataSource(this.options.dataSourcePath));
        const otherDirs = allDirs.filter((d) => !dirsToRemove.includes(d));

        if (otherDirs.length > 0) {
          console.log("Other execution directories (will NOT be removed):");
          for (const dir of otherDirs) {
            console.log(`  - ${dir}`);
          }
          console.log();
        }
      }

      // Get confirmation
      if (!this.options.skipConfirmation) {
        const confirmed = await this.getConfirmation();
        if (!confirmed) {
          console.log("\n❌ Cleanup cancelled by user");
          return result;
        }
      }

      // Remove directory
      console.log("\n🗑️  Removing execution directory...\n");

      for (const dir of dirsToRemove) {
        try {
          // Check if directory exists
          if (!fs.existsSync(dir)) {
            console.log(`⚠️  Directory does not exist: ${dir}`);
            continue;
          }

          // Check for running server
          const lockFile = path.join(dir, ".tadpole", "server.lock");
          if (fs.existsSync(lockFile)) {
            result.errors.push(`Cannot remove ${dir}: Server is running`);
            console.log(`❌ Skipped (server running): ${dir}`);
            continue;
          }

          await fs.promises.rm(dir, { recursive: true, force: true });
          result.directoriesRemoved.push(dir);
          console.log(`✅ Removed: ${dir}`);
        } catch (error) {
          result.errors.push(`Failed to remove ${dir}: ${(error as Error).message}`);
          console.log(`❌ Failed: ${dir} - ${(error as Error).message}`);
        }
      }

      result.success = result.errors.length === 0;

      // Display summary
      console.log(`\n${"=".repeat(50)}\n`);
      if (result.success) {
        console.log(`✅ Cleanup completed successfully!`);
        console.log(`   Removed ${result.directoriesRemoved.length} execution directory`);
      } else {
        console.log(`⚠️  Cleanup completed with errors`);
        console.log(`   Removed: ${result.directoriesRemoved.length} directories`);
        console.log(`   Failed: ${result.errors.length} directories`);
      }
    } catch (error) {
      result.errors.push((error as Error).message);
      console.error(`\n❌ Cleanup failed: ${(error as Error).message}`);
    }

    return result;
  }

  private async getConfirmation(): Promise<boolean> {
    console.log("❓ Proceed with cleanup? This cannot be undone! (y/N): ");

    return new Promise((resolve) => {
      process.stdin.once("data", (data) => {
        const input = data.toString().trim().toLowerCase();
        resolve(input === "y" || input === "yes");
      });
    });
  }
}

</server/cleanup-command.ts>

<server/command-schemas.ts>
import { z } from "zod";
import { PhaseId } from "./types/branded-types.js";

const phaseIdSchema = z.string().transform((id) => PhaseId(id));

export const clientCommandSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string(),
    type: z.literal("phase.start"),
    data: z.object({
      phaseId: phaseIdSchema,
      skipPreCommands: z.boolean().optional(),
    }),
  }),
  z.object({
    id: z.string(),
    type: z.literal("phase.next"),
  }),
  z.object({
    id: z.string(),
    type: z.literal("phase.skip"),
  }),
  z.object({
    id: z.string(),
    type: z.literal("phase.redo"),
  }),
  z.object({
    id: z.string(),
    type: z.literal("server.shutdown"),
  }),

  // Query checkpoints
  z.object({
    id: z.string(),
    type: z.literal("checkpoint.list"),
    data: z
      .object({
        runId: z.string().optional(), // Defaults to current run
      })
      .optional(),
  }),

  // Force stop current phase
  z.object({
    id: z.string(),
    type: z.literal("phase.forceStop"),
    data: z
      .object({
        reason: z.string().optional(),
      })
      .optional(),
  }),

  // Rollback to specific checkpoint
  z.object({
    id: z.string(),
    type: z.literal("rollback.toCheckpoint"),
    data: z.object({
      checkpointSha: z.string(),
      autoRestart: z.boolean().optional().default(false),
    }),
  }),

  // Rollback to phase + checkpoint type
  z.object({
    id: z.string(),
    type: z.literal("rollback.toPhase"),
    data: z.object({
      phaseId: phaseIdSchema,
      checkpointType: z.enum(["start", "end", "workspace-setup", "completed", "error", "skipped"]),
      autoRestart: z.boolean().optional().default(false),
    }),
  }),

  // Rollback to last successful phase
  z.object({
    id: z.string(),
    type: z.literal("rollback.toLastSuccess"),
    data: z
      .object({
        autoRestart: z.boolean().optional().default(false),
      })
      .optional(),
  }),
]);

export type ClientCommand = z.infer<typeof clientCommandSchema>;

</server/command-schemas.ts>

<server/config.ts>
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { PhaseId } from "./types/branded-types.js";
import type { PhaseConfig, ServerConfig } from "./types/types.js";

// -------------
// Constants
// -------------

export const TIMEOUTS = {
  RESULT_MESSAGE_MS: 30000, // 30 seconds to wait for result message
  PROCESS_KILL_GRACE_MS: 5000, // 5 seconds grace period before SIGKILL
  LOG_PARSER_DELAY_MS: 100, // 100ms delay for log parsing
  PHASE_CLEANUP_DELAY_MS: 100, // 100ms delay for phase cleanup
} as const;

// -------------
// Error Formatting
// -------------

/**
 * Format Zod validation errors into a user-friendly message.
 * Provides context about which phase has the error and what field is affected.
 */
function formatZodErrors(error: z.ZodError, rawConfig: unknown): string {
  const errors: string[] = [];

  for (const issue of error.issues) {
    const path = issue.path;
    let errorMsg = "";

    // Determine if this is a phase-level error
    if (path[0] === undefined && issue.code === "too_small") {
      errorMsg = `  - ${issue.message}`;
    } else if (typeof path[0] === "number") {
      // This is an error in a specific phase
      const phaseIndex = path[0];
      const phaseData = Array.isArray(rawConfig) ? rawConfig[phaseIndex] : null;
      const phaseId = phaseData?.id || `index ${phaseIndex}`;
      const phaseName = phaseData?.name || "unnamed";

      if (path.length === 1) {
        // Top-level phase error
        errorMsg = `  - Phase "${phaseName}" (${phaseId}): ${issue.message}`;
      } else {
        // Field-specific error
        const fieldPath = path.slice(1).join(".");
        errorMsg = `  - Phase "${phaseName}" (${phaseId}) - ${fieldPath}: ${issue.message}`;
      }
    } else if (issue.code === "unrecognized_keys") {
      // Handle unrecognized keys specially
      const keys = (issue as z.ZodIssue & { keys?: string[] }).keys?.join(", ");
      const phaseIndex = typeof path[0] === "number" ? path[0] : undefined;
      const phaseData =
        phaseIndex !== undefined && Array.isArray(rawConfig) ? rawConfig[phaseIndex] : null;
      const phaseId = phaseData?.id || (phaseIndex !== undefined ? `index ${phaseIndex}` : "");
      const phaseName = phaseData?.name || "unnamed";

      if (phaseIndex !== undefined) {
        errorMsg = `  - Phase "${phaseName}" (${phaseId}) has unrecognized field(s): ${keys}. Fix: Remove these fields or check for typos. Valid fields are: id, name, promptFile, promptText, appendSystemPromptFile, appendSystemPromptText, model, continuationMode, workspaceSetup, description, trackedFiles, env.`;
      } else {
        errorMsg = `  - Unrecognized field(s): ${keys}. Fix: Remove these fields or check for typos.`;
      }
    } else {
      // Generic error
      const fieldPath = path.join(".");
      errorMsg = `  - ${fieldPath || "Configuration"}: ${issue.message}`;
    }

    errors.push(errorMsg);
  }

  return errors.join("\n");
}

// -------------
// Configuration Schema
// -------------

const workspaceSetupItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("copy"),
    copy: z.object({
      from: z.string().min(1, "Source path cannot be empty"),
      to: z.string().min(1, "Target path cannot be empty"),
    }),
  }),
  z.object({
    type: z.literal("command"),
    command: z.object({
      run: z.string().min(1, "Command cannot be empty"),
      workingDirectory: z.enum(["project", "lastCopied"]).optional().default("project"),
    }),
  }),
]);

const phaseConfigSchema = z
  .object({
    id: z
      .string()
      .min(
        1,
        "Phase ID cannot be empty. This uniquely identifies your phase (e.g., 'phase-1', 'analysis'). Fix: Add a unique id field.",
      ),
    name: z
      .string()
      .min(
        1,
        "Phase name cannot be empty. This is the human-readable name shown in the UI. Fix: Add a descriptive name field.",
      ),
    promptFile: z.union([z.string(), z.array(z.string())]).optional(),
    promptText: z.string().optional(),
    appendSystemPromptFile: z.union([z.string(), z.array(z.string())]).optional(),
    appendSystemPromptText: z.string().optional(),
    model: z.enum(["sonnet", "opus"], {
      errorMap: () => ({
        message:
          "Model must be either 'sonnet' or 'opus'. This determines which Claude model to use. Fix: Change model to 'sonnet' (faster, cheaper) or 'opus' (more capable).",
      }),
    }),
    continuationMode: z.enum(["fresh", "continue-previous"], {
      errorMap: () => ({
        message:
          "continuationMode must be either 'fresh' or 'continue-previous'. This controls whether to start a new conversation or continue from the previous phase. Fix: Add continuationMode field with either 'fresh' (new conversation) or 'continue-previous' (maintain context).",
      }),
    }),
    workspaceSetup: z.array(workspaceSetupItemSchema).optional(),
    description: z.string().optional(),
    trackedFiles: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
  })
  .strict()
  .refine((data) => data.promptFile || data.promptText, {
    message:
      "Either promptFile or promptText must be provided. The prompt tells Claude what to do in this phase. Fix: Add either promptFile (path to .md file) or promptText (inline prompt string).",
  })
  .refine((data) => !(data.appendSystemPromptFile && data.appendSystemPromptText), {
    message:
      "Cannot specify both appendSystemPromptFile and appendSystemPromptText. Use one or the other to add system-level instructions. Fix: Remove one of these fields.",
  });

const phaseConfigArraySchema = z.array(phaseConfigSchema).min(1, "At least one phase required");

// -------------
// Default Configuration
// -------------

/**
 * Default server configuration values.
 * Can be overridden by passing config to TadpoleServer constructor.
 *
 * Note: execution paths and phases must be provided by the user.
 */
export const DEFAULT_CONFIG: Omit<
  ServerConfig,
  | "readOnlySourceDataPath"
  | "executionPath"
  | "dataPathInExecutionDir"
  | "dataHash"
  | "isNewExecution"
  | "isResuming"
  | "linkType"
  | "phases"
> = {
  port: 7777,
  version: "1.0.0",
  lockFile: ".tadpole/server.lock",
  socketLogFile: ".tadpole/logs/websocket.log",
  serverLogFile: ".tadpole/logs/server.log",
  costsPerMTok: {
    input: 3.0, // $3 per million input tokens
    inputCache: 3.75, // $3.75 per million tokens when creating cache
    cacheRead: 0.3, // $0.30 per million tokens from cache
    output: 15.0, // $15 per million output tokens
  },
  logParsingInterval: 1000, // Check for new log entries every second
  autostart: true, // Default to current behavior
  dataHashTimeLimit: 5000, // 5 seconds for directory hashing
  toolResultTruncateLength: 2500, // Default truncation length for tool results
};

// -------------
// Configuration Loading
// -------------

/**
 * Load and validate phase configuration from a JSON file.
 *
 * The file should contain an array of phase configurations.
 * Each phase is validated against the schema to ensure required
 * fields are present and either promptFile or promptText is provided.
 *
 * @param configPath - Path to the JSON configuration file
 * @returns Validated array of phase configurations
 * @throws Error with detailed validation messages if config is invalid
 */
export function loadPhaseConfig(configPath: string): PhaseConfig[] {
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const rawConfig = JSON.parse(content);

    // Validate the configuration
    const result = phaseConfigArraySchema.safeParse(rawConfig);
    if (!result.success) {
      const errors = formatZodErrors(result.error, rawConfig);
      throw new Error(`Invalid phase configuration:\n${errors}`);
    }

    // Resolve relative paths for promptFile and appendSystemPromptFile
    const configDir = path.dirname(configPath);
    const resolvedConfig = result.data.map((phase) => {
      const resolved = { ...phase };

      // Handle promptFile - can be string or array
      if (phase.promptFile) {
        if (Array.isArray(phase.promptFile)) {
          resolved.promptFile = phase.promptFile.map((file) =>
            path.isAbsolute(file) ? file : path.resolve(configDir, file),
          );
        } else if (!path.isAbsolute(phase.promptFile)) {
          resolved.promptFile = path.resolve(configDir, phase.promptFile);
        }
      }

      // Handle appendSystemPromptFile - can be string or array
      if (phase.appendSystemPromptFile) {
        if (Array.isArray(phase.appendSystemPromptFile)) {
          resolved.appendSystemPromptFile = phase.appendSystemPromptFile.map((file) =>
            path.isAbsolute(file) ? file : path.resolve(configDir, file),
          );
        } else if (!path.isAbsolute(phase.appendSystemPromptFile)) {
          resolved.appendSystemPromptFile = path.resolve(configDir, phase.appendSystemPromptFile);
        }
      }

      // Handle workspaceSetup - resolve paths for copy operations
      if (phase.workspaceSetup) {
        resolved.workspaceSetup = phase.workspaceSetup.map((item) => {
          if (item.type === "copy" && item.copy) {
            return {
              ...item,
              copy: {
                from: path.isAbsolute(item.copy.from)
                  ? item.copy.from
                  : path.resolve(configDir, item.copy.from),
                to: item.copy.to, // Keep 'to' as relative to projectPath
              },
            };
          }
          return item;
        });
      }

      return resolved;
    });

    // Validate file existence, readability, and model names
    const validationErrors: string[] = [];
    const validModels = ["sonnet", "opus"];

    for (const [index, phase] of resolvedConfig.entries()) {
      // Validate model name
      if (!validModels.includes(phase.model)) {
        validationErrors.push(
          `Phase ${index + 1} (${phase.id}): model "${
            phase.model
          }" is not valid. Must be one of: ${validModels.join(", ")}`,
        );
      }

      // Validate promptFile existence and readability
      if (phase.promptFile) {
        const promptFiles = Array.isArray(phase.promptFile) ? phase.promptFile : [phase.promptFile];
        for (const file of promptFiles) {
          if (!fs.existsSync(file)) {
            validationErrors.push(
              `Phase ${index + 1} (${phase.id}): promptFile "${file}" does not exist`,
            );
          } else {
            try {
              fs.readFileSync(file, "utf-8");
            } catch (error) {
              validationErrors.push(
                `Phase ${index + 1} (${phase.id}): promptFile "${file}" is not readable: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }
        }
      }

      // Validate appendSystemPromptFile existence and readability
      if (phase.appendSystemPromptFile) {
        const systemPromptFiles = Array.isArray(phase.appendSystemPromptFile)
          ? phase.appendSystemPromptFile
          : [phase.appendSystemPromptFile];
        for (const file of systemPromptFiles) {
          if (!fs.existsSync(file)) {
            validationErrors.push(
              `Phase ${index + 1} (${phase.id}): appendSystemPromptFile "${file}" does not exist`,
            );
          } else {
            try {
              fs.readFileSync(file, "utf-8");
            } catch (error) {
              validationErrors.push(
                `Phase ${index + 1} (${
                  phase.id
                }): appendSystemPromptFile "${file}" is not readable: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }
        }
      }

      // Validate workspaceSetup items
      if (phase.workspaceSetup) {
        for (const [itemIndex, item] of phase.workspaceSetup.entries()) {
          if (item.type === "copy" && item.copy) {
            // Check if source exists
            if (!fs.existsSync(item.copy.from)) {
              validationErrors.push(
                `Phase ${index + 1} (${phase.id}), workspace setup item ${
                  itemIndex + 1
                }: source path "${item.copy.from}" does not exist`,
              );
            }
          }
        }
      }
    }

    if (validationErrors.length > 0) {
      throw new Error(`Phase configuration validation failed:\n${validationErrors.join("\n")}`);
    }

    // Transform string IDs to PhaseId branded types
    return resolvedConfig.map((phase) => ({
      ...phase,
      id: PhaseId(phase.id),
    }));
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to load phase config from ${configPath}: ${error.message}`);
    }
    throw error;
  }
}

// -------------
// Token Cost Calculation
// -------------

/**
 * Calculate the cost in dollars for a given token usage.
 *
 * Uses the configured costs per million tokens for each token type.
 * This matches Claude's pricing model with separate rates for:
 * - Standard input tokens
 * - Cache creation tokens
 * - Cache read tokens
 * - Output tokens
 *
 * @param usage - Token counts by type
 * @param costs - Cost configuration per million tokens
 * @returns Total cost in dollars
 */
export function calculateCost(
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  },
  costs: ServerConfig["costsPerMTok"],
): number {
  const inputCost = (usage.inputTokens / 1_000_000) * costs.input;
  const cacheCreationCost = (usage.cacheCreationTokens / 1_000_000) * costs.inputCache;
  const cacheReadCost = (usage.cacheReadTokens / 1_000_000) * costs.cacheRead;
  const outputCost = (usage.outputTokens / 1_000_000) * costs.output;

  return inputCost + cacheCreationCost + cacheReadCost + outputCost;
}

// -------------
// Enhanced Validation
// -------------

export interface ValidationResult {
  phases: PhaseConfig[];
  phaseCount: number;
  promptFileCount: number;
  systemPromptFileCount: number;
  workspaceSetupCount: number;
  watchingPhaseCount: number;
  checkpointPhaseCount: number;
  warnings: string[];
  environmentVariables: {
    fromSystem: Record<string, string>;
    fromPhases: Array<{
      phaseId: string;
      phaseName: string;
      variables: Record<string, string>;
    }>;
  };
}

/**
 * Validate phase configuration with enhanced checks.
 *
 * This performs all the validation of loadPhaseConfig plus additional
 * checks that are useful for pre-flight validation but not strictly
 * required for running.
 *
 * @param configPath - Path to configuration file
 * @param executionPath - Execution directory for relative path resolution
 * @returns Validation result with statistics and warnings
 * @throws Error with detailed messages if validation fails
 */
export async function validatePhaseConfig(
  configPath: string,
  executionPath: string,
): Promise<ValidationResult> {
  // First, use loadPhaseConfig to do basic validation
  // This will throw if there are any structural issues
  const phases = loadPhaseConfig(configPath);

  const result: ValidationResult = {
    phases,
    phaseCount: phases.length,
    promptFileCount: 0,
    systemPromptFileCount: 0,
    workspaceSetupCount: 0,
    watchingPhaseCount: 0,
    checkpointPhaseCount: 0,
    warnings: [],
    environmentVariables: {
      fromSystem: {},
      fromPhases: [],
    },
  };

  // Collect TADPOLE_ prefixed environment variables from system
  for (const key in process.env) {
    if (key.startsWith("TADPOLE_")) {
      const newKey = key.substring("TADPOLE_".length);
      result.environmentVariables.fromSystem[newKey] = process.env[key] || "";
    }
  }

  // Additional validation checks
  const phaseIds = new Set<string>();
  const phaseNames = new Set<string>();

  for (const [index, phase] of phases.entries()) {
    const phaseLabel = `Phase ${index + 1} (${phase.id})`;

    // Check for duplicate IDs
    if (phaseIds.has(phase.id)) {
      throw new Error(`${phaseLabel}: Duplicate phase ID "${phase.id}"`);
    }
    phaseIds.add(phase.id);

    // Warn about duplicate names (not fatal)
    if (phaseNames.has(phase.name)) {
      result.warnings.push(`${phaseLabel}: Duplicate phase name "${phase.name}"`);
    }
    phaseNames.add(phase.name);

    // Collect phase environment variables
    if (phase.env && Object.keys(phase.env).length > 0) {
      result.environmentVariables.fromPhases.push({
        phaseId: phase.id,
        phaseName: phase.name,
        variables: phase.env,
      });
    }

    // Count prompt files
    if (phase.promptFile) {
      const files = Array.isArray(phase.promptFile) ? phase.promptFile : [phase.promptFile];
      result.promptFileCount += files.length;

      // Verify files are readable (loadPhaseConfig checks existence)
      for (const file of files) {
        try {
          const stats = await fs.promises.stat(file);
          if (stats.size === 0) {
            result.warnings.push(`${phaseLabel}: Prompt file "${file}" is empty`);
          }
          if (stats.size > 1024 * 1024) {
            // 1MB
            result.warnings.push(
              `${phaseLabel}: Prompt file "${file}" is large (${(stats.size / 1024 / 1024).toFixed(
                2,
              )}MB)`,
            );
          }
        } catch (error) {
          // Should not happen as loadPhaseConfig already checked
          throw new Error(`${phaseLabel}: Cannot stat prompt file "${file}": ${error}`);
        }
      }
    }

    // Count system prompt files
    if (phase.appendSystemPromptFile) {
      const files = Array.isArray(phase.appendSystemPromptFile)
        ? phase.appendSystemPromptFile
        : [phase.appendSystemPromptFile];
      result.systemPromptFileCount += files.length;
    }

    // Validate workspace setup
    if (phase.workspaceSetup) {
      result.workspaceSetupCount += phase.workspaceSetup.length;

      for (const [itemIndex, item] of phase.workspaceSetup.entries()) {
        if (item.type === "copy" && item.copy) {
          // Check source exists (already done by loadPhaseConfig)
          // Check target parent directory
          const targetPath = path.join(executionPath, item.copy.to);
          const targetParent = path.dirname(targetPath);

          try {
            const relativeParent = path.relative(executionPath, targetParent);
            if (relativeParent.startsWith("..")) {
              throw new Error(
                `${phaseLabel}, workspace setup item ${itemIndex + 1}: ` +
                  `Target path "${item.copy.to}" would write outside execution directory`,
              );
            }
          } catch (_error) {
            // Path resolution error
            throw new Error(
              `${phaseLabel}, workspace setup item ${itemIndex + 1}: ` +
                `Invalid target path "${item.copy.to}"`,
            );
          }

          // Warn if target already exists
          if (fs.existsSync(targetPath)) {
            result.warnings.push(
              `${phaseLabel}: Copy target "${item.copy.to}" already exists and will be overwritten`,
            );
          }
        } else if (item.type === "command" && item.command) {
          // Basic command validation
          const command = item.command.run.trim();
          if (!command) {
            throw new Error(`${phaseLabel}, workspace setup item ${itemIndex + 1}: Empty command`);
          }

          // Warn about potentially dangerous commands
          const dangerousPatterns = [
            /rm\s+-rf\s+\//, // rm -rf /
            /rm\s+-rf\s+~/, // rm -rf ~
            />\s*\/dev\/sda/, // Writing to disk devices
            /format\s+/i, // Format commands
            /del\s+\/s\s+\/q\s+c:/i, // Windows delete
          ];

          for (const pattern of dangerousPatterns) {
            if (pattern.test(command)) {
              result.warnings.push(
                `${phaseLabel}: Potentially dangerous command detected: "${command}"`,
              );
              break;
            }
          }
        }
      }
    }

    // Count phases with file tracking
    if (phase.trackedFiles && phase.trackedFiles.length > 0) {
      result.watchingPhaseCount++;
      result.checkpointPhaseCount++;
    }

    // Validate continuation mode
    if (phase.continuationMode === "continue-previous" && index === 0) {
      result.warnings.push(
        `${phaseLabel}: First phase has continuationMode "continue-previous" but there's no previous phase`,
      );
    }

    // Check phase dependencies
    if (phase.continuationMode === "continue-previous" && index > 0) {
      const previousPhase = phases[index - 1];
      // Warn if previous phase doesn't produce output that might be needed
      if (!previousPhase.trackedFiles || previousPhase.trackedFiles.length === 0) {
        result.warnings.push(
          `${phaseLabel}: Continues from previous phase "${previousPhase.id}" ` +
            `which doesn't track any files`,
        );
      }
    }
  }

  // Global warnings
  if (result.phaseCount === 0) {
    throw new Error("Configuration must contain at least one phase");
  }

  return result;
}

</server/config.ts>

<server/data-hasher.ts>
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Generate a hash for a single file based on its content and metadata
 */
async function hashFile(filePath: string): Promise<string> {
  const stats = await fs.promises.stat(filePath);
  const fileContent = await fs.promises.readFile(filePath);
  const hash = crypto.createHash("sha256");
  // Include metadata to differentiate files with same content but different names/timestamps
  hash.update(`file:${path.basename(filePath)}:${stats.size}:${stats.mtimeMs}`);
  hash.update(fileContent);
  return hash.digest("hex").substring(0, 12);
}

/**
 * Generate a hash based on data source (file or directory) with depth and time limits
 * Uses file names, types, sizes, and modification times
 */
export async function hashDataSource(dataPath: string, timeLimit: number = 5000): Promise<string> {
  // Check if the provided path is a file or directory
  const stats = await fs.promises.stat(dataPath);

  if (stats.isFile()) {
    // Hash the file directly
    return await hashFile(dataPath);
  } else if (stats.isDirectory()) {
    // Use existing directory hashing logic
    return await hashDataDirectoryInternal(dataPath, timeLimit);
  } else {
    throw new Error(`Data source is neither a file nor a directory: ${dataPath}`);
  }
}

/**
 * Internal function to generate a hash based on directory structure with depth and time limits
 * Uses file names, types, sizes, and modification times
 */
async function hashDataDirectoryInternal(
  dataPath: string,
  timeLimit: number = 5000,
): Promise<string> {
  const maxDepth = 3;
  const startTime = Date.now();
  const entries: string[] = [];

  async function scan(currentDir: string, depth: number) {
    // Check time limit
    if (Date.now() - startTime > timeLimit) {
      entries.push("TIMEOUT:scan_truncated");
      return;
    }

    if (depth > maxDepth) return;

    try {
      const items = await fs.promises.readdir(currentDir, { withFileTypes: true });

      // Sort for deterministic hashing
      items.sort((a, b) => a.name.localeCompare(b.name));

      // Limit entries per directory to prevent explosion
      const limitedItems = items.slice(0, 100);
      if (items.length > 100) {
        entries.push(`TRUNCATED:${currentDir}:${items.length - 100}_more_items`);
      }

      for (const item of limitedItems) {
        // Skip hidden files and common large directories
        if (
          item.name.startsWith(".") ||
          item.name === "node_modules" ||
          item.name === "__pycache__" ||
          item.name === "dist" ||
          item.name === "build"
        ) {
          continue;
        }

        const fullPath = path.join(currentDir, item.name);
        const relativePath = path.relative(dataPath, fullPath);

        try {
          const stats = await fs.promises.stat(fullPath);

          // Include type, name, size, and mtime for better discrimination
          const mtime = Math.floor(stats.mtimeMs / 1000); // Round to seconds
          const entry = item.isDirectory()
            ? `d:${relativePath}:${mtime}`
            : `f:${relativePath}:${stats.size}:${mtime}`;

          entries.push(entry);

          // Recurse into directories
          if (item.isDirectory() && depth < maxDepth) {
            await scan(fullPath, depth + 1);
          }
        } catch (error) {
          // Skip files we can't stat (permissions, symlinks, etc)
          const errorMsg = error instanceof Error ? error.message : "unknown";
          entries.push(`e:${relativePath}:${errorMsg}`);
        }
      }
    } catch (error) {
      // Skip directories we can't read
      const errorMsg = error instanceof Error ? error.message : "unknown";
      entries.push(`e:${currentDir}:read_error:${errorMsg}`);
    }
  }

  await scan(dataPath, 0);

  // If we got very few entries, add the data path itself for uniqueness
  if (entries.length < 5) {
    entries.push(`path:${dataPath}`);
  }

  // Create hash from sorted entries
  const hash = crypto.createHash("sha256");
  hash.update(entries.join("\n"));
  return hash.digest("hex").substring(0, 12);
}

/**
 * @deprecated Use hashDataSource instead
 */
export async function hashDataDirectory(
  dataPath: string,
  timeLimit: number = 5000,
): Promise<string> {
  return await hashDataSource(dataPath, timeLimit);
}

/**
 * Find existing execution directories for a data hash
 */
export async function findExecutionDirs(dataHash: string): Promise<string[]> {
  const executionRoot = path.join(os.homedir(), ".tadpole-executions");
  if (!fs.existsSync(executionRoot)) return [];

  const dirs: string[] = [];
  const entries = await fs.promises.readdir(executionRoot, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const metaPath = path.join(executionRoot, entry.name, ".tadpole", "execution-meta.json");
    try {
      const meta = JSON.parse(await fs.promises.readFile(metaPath, "utf-8"));
      if (meta.dataHash === dataHash) {
        dirs.push(path.join(executionRoot, entry.name));
      }
    } catch {
      // Ignore directories without valid metadata
    }
  }

  return dirs.sort((a, b) => b.localeCompare(a)); // Newest first
}

</server/data-hasher.ts>

<server/execution-setup.ts>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "./config.js";
import { findExecutionDirs, hashDataSource } from "./data-hasher.js";

export interface ExecutionSetup {
  readOnlySourceDataPath: string; // Absolute path to original data
  executionPath: string; // Absolute path where we run
  dataPathInExecutionDir: string; // Always executionPath + '/read_only_data_source'
  dataHash: string;
  isNewExecution: boolean;
  isResuming: boolean;
  linkType: "symlink" | "copy";
  meta: {
    createdAt: string;
    lastUsed: string;
    readOnlySourceResolvedDataPath: string;
    version: string;
  };
}

export async function setupExecutionEnvironment(options: {
  readOnlySourceDataPath: string; // Already resolved to absolute
  executionPath?: string; // Already resolved to absolute, or undefined
  useSymlink?: boolean; // Default true, --copy flag sets to false
  dataHashTimeLimit?: number; // Time limit for hashing
  startNew?: boolean; // Force new execution
}): Promise<ExecutionSetup> {
  const {
    readOnlySourceDataPath,
    executionPath,
    useSymlink = true,
    dataHashTimeLimit = DEFAULT_CONFIG.dataHashTimeLimit,
    startNew = false,
  } = options;

  // Verify data source exists
  if (!fs.existsSync(readOnlySourceDataPath)) {
    throw new Error(`Data source not found: ${readOnlySourceDataPath}`);
  }

  const stats = await fs.promises.stat(readOnlySourceDataPath);
  if (!stats.isDirectory() && !stats.isFile()) {
    throw new Error(`Data source is not a file or directory: ${readOnlySourceDataPath}`);
  }

  // Calculate data hash
  console.log("Calculating data signature...");
  const dataHash = await hashDataSource(readOnlySourceDataPath, dataHashTimeLimit);
  console.log(`Data signature: ${dataHash}`);

  let finalExecutionPath: string;
  let isNewExecution = false;
  let isResuming = false;

  if (executionPath) {
    // Explicit execution path provided

    if (startNew) {
      // With --start-new, directory must not exist OR be empty
      if (fs.existsSync(executionPath)) {
        const entries = await fs.promises.readdir(executionPath);
        if (entries.length > 0) {
          throw new Error(
            `Cannot use --start-new with non-empty execution directory: ${executionPath}\n` +
              `Directory contains ${entries.length} items. Please use an empty directory or omit --execution.`,
          );
        }
        // Directory exists but is empty - OK to use
        console.log(`Using empty directory for new execution: ${executionPath}`);
      } else {
        // Directory doesn't exist - create it
        await fs.promises.mkdir(executionPath, { recursive: true });
        console.log(`Created directory for new execution: ${executionPath}`);
      }

      isNewExecution = true;
      isResuming = false;
      finalExecutionPath = executionPath;
    } else {
      // Without --start-new, existing logic applies
      if (!fs.existsSync(executionPath)) {
        throw new Error(`Execution directory not found: ${executionPath}`);
      }

      // Verify it's a directory
      const stats = await fs.promises.stat(executionPath);
      if (!stats.isDirectory()) {
        throw new Error(`Execution path is not a directory: ${executionPath}`);
      }

      // Prevent nested execution
      if (executionPath.includes("/.tadpole-executions/") && executionPath.includes("/data")) {
        throw new Error("Cannot create execution inside another execution directory");
      }

      // Prevent using data source as execution
      if (path.resolve(executionPath) === path.resolve(readOnlySourceDataPath)) {
        throw new Error("Execution directory cannot be the same as data source");
      }

      // Check if it has execution metadata
      const metaPath = path.join(executionPath, ".tadpole", "execution-meta.json");
      if (fs.existsSync(metaPath)) {
        // Verify data hash matches
        const meta = JSON.parse(await fs.promises.readFile(metaPath, "utf-8"));
        if (meta.dataHash !== dataHash) {
          throw new Error(
            `Data source mismatch. Execution directory was created for different data.\n` +
              `Expected hash: ${meta.dataHash}\n` +
              `Current hash: ${dataHash}`,
          );
        }
        isResuming = true;
      } else {
        // Directory exists but no metadata - treat as fresh execution
        isNewExecution = true;
        console.log(`Using existing directory as execution directory: ${executionPath}`);
      }

      finalExecutionPath = executionPath;
    }
  } else {
    // Auto-detect or create execution directory
    const executionRoot = path.join(os.homedir(), ".tadpole-executions");
    await fs.promises.mkdir(executionRoot, { recursive: true });

    if (startNew) {
      // With --start-new, always create new directory
      const timestamp = Date.now();
      const random = Math.random().toString(36).substring(2, 6);
      const dirName = `${timestamp}-${random}-${dataHash.substring(0, 6)}`;
      finalExecutionPath = path.join(executionRoot, dirName);
      await fs.promises.mkdir(finalExecutionPath, { recursive: true });
      isNewExecution = true;
      isResuming = false;
      console.log(`Created new execution directory: ${finalExecutionPath}`);
    } else {
      // Without --start-new, use existing logic
      const existingDirs = await findExecutionDirs(dataHash);

      if (existingDirs.length > 0) {
        // Use most recent
        finalExecutionPath = existingDirs[0];
        isResuming = true;
        console.log(`Resuming execution in: ${finalExecutionPath}`);
      } else {
        // Create new execution directory
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(2, 6);
        const dirName = `${timestamp}-${random}-${dataHash.substring(0, 6)}`;
        finalExecutionPath = path.join(executionRoot, dirName);
        await fs.promises.mkdir(finalExecutionPath, { recursive: true });
        isNewExecution = true;
        console.log(`Created execution directory: ${finalExecutionPath}`);
      }
    }
  }

  const dataPathInExecutionDir = path.join(finalExecutionPath, "read_only_data_source");

  // Set up data access (symlink or copy)
  let linkType: "symlink" | "copy" = useSymlink ? "symlink" : "copy";
  if (isNewExecution || !fs.existsSync(dataPathInExecutionDir)) {
    if (stats.isDirectory()) {
      // --- Directory Logic (Existing, but with new destination) ---
      if (useSymlink) {
        try {
          await fs.promises.symlink(readOnlySourceDataPath, dataPathInExecutionDir, "dir");
        } catch (error) {
          console.warn(`Failed to create symlink for directory: ${error}. Falling back to copy.`);
          await copyDirectory(readOnlySourceDataPath, dataPathInExecutionDir);
          linkType = "copy";
        }
      } else {
        await copyDirectory(readOnlySourceDataPath, dataPathInExecutionDir);
      }
    } else if (stats.isFile()) {
      // --- File Logic (New) ---
      // 1. Create the 'read_only_data_source' directory
      await fs.promises.mkdir(dataPathInExecutionDir, { recursive: true });
      const destFilePath = path.join(dataPathInExecutionDir, path.basename(readOnlySourceDataPath));

      // 2. Link or copy the file into it
      if (useSymlink) {
        try {
          await fs.promises.symlink(readOnlySourceDataPath, destFilePath);
        } catch (error) {
          console.warn(`Failed to create symlink for file: ${error}. Falling back to copy.`);
          await fs.promises.copyFile(readOnlySourceDataPath, destFilePath);
          linkType = "copy";
        }
      } else {
        await fs.promises.copyFile(readOnlySourceDataPath, destFilePath);
      }
    }
  }

  // Create/update metadata
  const metaDir = path.join(finalExecutionPath, ".tadpole");
  await fs.promises.mkdir(metaDir, { recursive: true });

  const meta = {
    version: "1.0.0",
    readOnlySourceDataPath,
    readOnlySourceResolvedDataPath: await fs.promises.realpath(readOnlySourceDataPath),
    dataHash,
    linkType,
    createdAt: isNewExecution
      ? new Date().toISOString()
      : fs.existsSync(path.join(metaDir, "execution-meta.json"))
        ? JSON.parse(await fs.promises.readFile(path.join(metaDir, "execution-meta.json"), "utf-8"))
            .createdAt
        : new Date().toISOString(),
    lastUsed: new Date().toISOString(),
  };

  await fs.promises.writeFile(
    path.join(metaDir, "execution-meta.json"),
    JSON.stringify(meta, null, 2),
  );

  return {
    readOnlySourceDataPath,
    executionPath: finalExecutionPath,
    dataPathInExecutionDir,
    dataHash,
    isNewExecution,
    isResuming,
    linkType,
    meta,
  };
}

async function copyDirectory(src: string, dest: string): Promise<void> {
  await fs.promises.mkdir(dest, { recursive: true });
  const entries = await fs.promises.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      // Handle symlinks
      const target = await fs.promises.readlink(srcPath);
      await fs.promises.symlink(target, destPath);
    } else if (entry.isFile()) {
      await fs.promises.copyFile(srcPath, destPath);
    }
    // Skip other types (FIFO, socket, etc.)
  }
}

</server/execution-setup.ts>

<server/execution-thread.ts>
// -------------
// execution-thread.ts - Clean implementation with simplified algorithm
// -------------

import {
  isTerminalPhaseStatus,
  type PhaseExecution,
  type PhaseId,
  type Run,
  type RunId,
  type SessionId,
  type TadpoleState,
} from "./types/state-types.js";
import type { PhaseConfig } from "./types/types.js";
import type { Logger } from "./utils.js";

// -------------
// Types
// -------------

/**
 * Complete checkpoint information including git metadata
 */
export interface CheckpointInfo {
  type: "workspace-setup" | "completed" | "error" | "skipped";
  sha: string;
  message: string;
  timestamp: string; // ISO 8601 timestamp
  branch: string;
}

/**
 * A phase with its complete context
 */
export interface ThreadPhase {
  // The phase data
  phase: PhaseExecution;

  // Run context
  runId: RunId;
  runStatus: "running" | "completed" | "failed" | "crashed";
  runStartTime: string;
  runEndTime: string | null; // null for running runs, string for completed runs
  gitBranch: string;

  // Position in execution history
  globalIndex: number; // 0 = latest phase across all runs
  runIndex: number; // Which run this came from (0 = latest run)
  phaseIndexInRun: number; // Position within that run

  // All checkpoints for this phase with validation
  validatedCheckpoints: CheckpointInfo[];

  // Derived information
  continuationSessionId: SessionId | null; // Session ID this phase continued from, null if none
}

/**
 * Complete execution thread
 */
export interface ExecutionThread {
  phases: ThreadPhase[]; // Ordered latest first
  totalRuns: number; // How many runs we traversed
  hasRunningPhase: boolean; // Quick check if anything is running
  nextPhaseId: PhaseId | null; // What phase should execute next, null if none
}

// -------------
// Main Analysis Function - Simplified Algorithm
// -------------

/**
 * Analyze execution history to build a unified thread with all metadata.
 *
 * @param state - The complete Tadpole state
 * @param phaseConfigs - Phase configuration array
 * @param checkpointData - Map of SHA to git checkpoint data (optional)
 * @param targetRunId - Specific run to analyze (defaults to latest)
 * @param logger - Optional logger for debugging
 * @returns Complete execution thread with all metadata preserved
 */
export async function analyzeExecutionThread(
  state: TadpoleState,
  phaseConfigs: PhaseConfig[],
  checkpointData?: Map<string, { message: string; timestamp: string; branch: string }>,
  targetRunId?: RunId,
  logger?: Logger,
): Promise<ExecutionThread> {
  // Find starting run
  const startRun = targetRunId ? state.runs.find((r) => r.runId === targetRunId) : state.runs[0]; // Latest run is first

  if (!startRun) {
    logger?.log("No runs found for execution thread analysis", "debug");
    return {
      phases: [],
      totalRuns: 0,
      hasRunningPhase: false,
      nextPhaseId: null,
    };
  }

  // Initialize thread building
  const phases: ThreadPhase[] = [];
  const visited = new Set<RunId>();
  let currentRun: Run | null = startRun;
  let untilPhase = startRun.phases.length - 1; // Start by including all phases
  let runIndex = 0;
  let globalIndex = 0;
  let hasRunningPhase = false;

  // Process runs following the continuation chain
  while (currentRun && !visited.has(currentRun.runId)) {
    visited.add(currentRun.runId);

    logger?.log(
      `Processing run ${currentRun.runId} (status: ${currentRun.status}, ` +
        `phases: ${currentRun.phases.length}, including up to index ${untilPhase})`,
      "debug",
    );

    // Process phases in this run (backwards, from untilPhase to 0)
    for (let i = untilPhase; i >= 0; i--) {
      const phase = currentRun.phases[i];

      // Check if this is a running phase
      if (!isTerminalPhaseStatus(phase.status)) {
        hasRunningPhase = true;
      }

      // Build checkpoint information with git metadata
      const validatedCheckpoints = buildCheckpointInfo(phase, checkpointData);

      // Extract continuation session ID if present
      const continuationSessionId: SessionId | null =
        "previousSessionId" in phase && phase.previousSessionId ? phase.previousSessionId : null;

      // Build the thread phase entry with all metadata
      const threadPhase: ThreadPhase = {
        phase,
        runId: currentRun.runId,
        runStatus: currentRun.status,
        runStartTime: currentRun.startTime,
        runEndTime: currentRun.endTime || null,
        gitBranch: currentRun.gitBranch,
        globalIndex,
        runIndex,
        phaseIndexInRun: i,
        validatedCheckpoints,
        continuationSessionId,
      };

      phases.push(threadPhase);
      globalIndex++;
    }

    // Check if this run is a continuation and move to parent
    if (currentRun.startingConditions.type === "continuation") {
      const source = currentRun.startingConditions.source;
      const parentRunId: RunId = source.runId;
      const afterPhase = source.afterPhase;
      const checkpointSha = source.checkpointSha;

      // Find parent run
      const parentRun = state.runs.find((r: Run) => r.runId === parentRunId);
      if (!parentRun) {
        logger?.log(`Parent run ${parentRunId} not found, ending chain`, "info");
        break;
      }

      // Calculate untilPhase for the parent run
      if (!afterPhase) {
        // Continuation from beginning - exclude all phases from parent
        untilPhase = -1;
      } else {
        // Find the phase in parent run
        const afterPhaseIndex = parentRun.phases.findIndex(
          (p: PhaseExecution) => p.phaseId === afterPhase,
        );

        if (afterPhaseIndex === -1) {
          logger?.log(
            `Phase ${afterPhase} not found in parent run ${parentRunId}, including all phases`,
            "info",
          );
          untilPhase = parentRun.phases.length - 1;
        } else {
          const afterPhaseData = parentRun.phases[afterPhaseIndex];

          // Check if it's a workspace-setup continuation
          if (
            "workspaceSetupCheckpoint" in afterPhaseData &&
            afterPhaseData.workspaceSetupCheckpoint === checkpointSha
          ) {
            // Workspace setup continuation - exclude the phase that will be re-run
            untilPhase = afterPhaseIndex - 1;
            logger?.log(
              `Workspace setup continuation for ${afterPhase}, excluding it from parent`,
              "debug",
            );
          } else {
            // Normal continuation - include up to and including afterPhase
            untilPhase = afterPhaseIndex;
            logger?.log(
              `Normal continuation after ${afterPhase}, including phases up to index ${afterPhaseIndex}`,
              "debug",
            );
          }
        }
      }

      // Move to parent run
      currentRun = parentRun;
      runIndex++;
    } else {
      // Fresh start - we're done
      break;
    }
  }

  // Calculate next phase at the thread level
  let nextPhaseId: PhaseId | null = null;

  // Don't suggest next phase if the current run failed
  if (startRun.status === "failed") {
    // TODO
    nextPhaseId = null;
  } else if (!hasRunningPhase && phases.length > 0) {
    const latestPhase = phases[0];

    // Check if we're continuing from a workspace-setup checkpoint
    // This happens when the latest run is a continuation that will re-run a phase
    if (startRun.startingConditions.type === "continuation") {
      const { afterPhase, checkpointSha } = startRun.startingConditions.source;

      // Check if this continuation is from a workspace-setup checkpoint
      if (afterPhase && phases.length === 0) {
        // TODO
        // No phases executed yet in continuation run
        // Check if the continuation is from workspace-setup
        const sourceRun = state.runs.find(
          (r) =>
            r.runId ===
            (
              startRun.startingConditions as {
                type: "continuation";
                source: { runId: RunId };
              }
            ).source.runId,
        );
        if (sourceRun) {
          const sourcePhase = sourceRun.phases.find((p) => p.phaseId === afterPhase);
          if (
            sourcePhase &&
            "workspaceSetupCheckpoint" in sourcePhase &&
            sourcePhase.workspaceSetupCheckpoint === checkpointSha
          ) {
            // Workspace-setup continuation - next phase is the same phase
            nextPhaseId = afterPhase;
          }
        }
      }
    }

    // If not workspace-setup continuation, find next phase in config
    if (!nextPhaseId) {
      const phaseConfigIndex = phaseConfigs.findIndex((c) => c.id === latestPhase.phase.phaseId);
      if (phaseConfigIndex >= 0 && phaseConfigIndex < phaseConfigs.length - 1) {
        nextPhaseId = phaseConfigs[phaseConfigIndex + 1].id as PhaseId;
      }
    }
  } else if (!hasRunningPhase && phases.length === 0) {
    // No phases executed yet
    if (startRun.startingConditions.type === "continuation") {
      const { afterPhase, checkpointSha } = startRun.startingConditions.source;

      if (!afterPhase) {
        // Continuation from beginning
        nextPhaseId = phaseConfigs[0]?.id ? (phaseConfigs[0].id as PhaseId) : null;
      } else {
        // Check if it's a workspace-setup continuation
        const sourceRun = state.runs.find(
          (r) =>
            r.runId ===
            (
              startRun.startingConditions as {
                type: "continuation";
                source: { runId: RunId };
              }
            ).source.runId,
        );
        if (sourceRun) {
          const sourcePhase = sourceRun.phases.find((p) => p.phaseId === afterPhase);
          if (
            sourcePhase &&
            "workspaceSetupCheckpoint" in sourcePhase &&
            sourcePhase.workspaceSetupCheckpoint === checkpointSha
          ) {
            // Workspace-setup continuation - re-run the same phase
            nextPhaseId = afterPhase;
          } else {
            // Normal continuation - run next phase after afterPhase
            const phaseIndex = phaseConfigs.findIndex((c) => c.id === afterPhase);
            if (phaseIndex >= 0 && phaseIndex < phaseConfigs.length - 1) {
              nextPhaseId = phaseConfigs[phaseIndex + 1].id as PhaseId;
            }
          }
        }
      }
    } else {
      // Fresh run - start with first phase
      nextPhaseId = phaseConfigs[0]?.id ? (phaseConfigs[0].id as PhaseId) : null;
    }
  }

  logger?.log(
    `Built execution thread: ${phases.length} phases across ${
      runIndex + 1
    } runs, next phase: ${nextPhaseId || "none"}`,
    "debug",
  );

  return {
    phases,
    totalRuns: runIndex + 1,
    hasRunningPhase,
    nextPhaseId,
  };
}

/**
 * Build checkpoint information for a phase with git metadata
 * Only includes checkpoints that exist in git
 */
function buildCheckpointInfo(
  phase: PhaseExecution,
  checkpointData?: Map<string, { message: string; timestamp: string; branch: string }>,
): CheckpointInfo[] {
  const checkpoints: CheckpointInfo[] = [];

  // Helper to add checkpoint only if it exists in git
  const addCheckpoint = (type: CheckpointInfo["type"], sha: string) => {
    // Only add if we have git data for this SHA
    const gitData = checkpointData?.get(sha);
    if (gitData) {
      checkpoints.push({
        type,
        sha,
        message: gitData.message,
        timestamp: gitData.timestamp,
        branch: gitData.branch,
      });
    }
  };

  // Check all checkpoint types
  if ("workspaceSetupCheckpoint" in phase && phase.workspaceSetupCheckpoint) {
    addCheckpoint("workspace-setup", phase.workspaceSetupCheckpoint);
  }

  if (phase.status === "completed" && phase.completionCheckpoint) {
    addCheckpoint("completed", phase.completionCheckpoint);
  }

  if (phase.status === "failed" && "errorCheckpoint" in phase && phase.errorCheckpoint) {
    addCheckpoint("error", phase.errorCheckpoint);
  }

  if (phase.status === "skipped" && "skipCheckpoint" in phase && phase.skipCheckpoint) {
    addCheckpoint("skipped", phase.skipCheckpoint);
  }

  return checkpoints;
}

// -------------
// Simple Query Functions
// -------------

/**
 * Get the next phase to execute from a thread
 */
export function getNextPhaseId(thread: ExecutionThread): PhaseId | null {
  // Simply return what was already calculated at the thread level
  return thread.nextPhaseId || null;
}

/**
 * Find session ID for continuing a specific phase
 */
export function findContinuationSessionId(
  thread: ExecutionThread,
  phaseId: PhaseId,
  phaseConfigs: PhaseConfig[],
): SessionId | null {
  const phaseConfig = phaseConfigs.find((c) => c.id === phaseId);

  // Only continue-previous phases need a session
  if (!phaseConfig || phaseConfig.continuationMode !== "continue-previous") {
    return null;
  }

  // Find the phase before this one in the config
  const configIndex = phaseConfigs.findIndex((c) => c.id === phaseId);
  if (configIndex <= 0) return null;

  const previousPhaseId = phaseConfigs[configIndex - 1].id as PhaseId;

  // Find the most recent execution of the previous phase
  for (const threadPhase of thread.phases) {
    if (threadPhase.phase.phaseId !== previousPhaseId) continue;

    const phase = threadPhase.phase;

    // Must have a session ID
    if (!("claudeSessionId" in phase) || !phase.claudeSessionId) continue;

    // Check if it's valid for continuation
    if (phase.status === "completed") {
      return phase.claudeSessionId;
    }

    if (
      phase.status === "skipped" &&
      "assistantMessageCount" in phase &&
      phase.assistantMessageCount &&
      phase.assistantMessageCount > 0
    ) {
      return phase.claudeSessionId;
    }
  }

  return null;
}

</server/execution-thread.ts>

<server/file-resolver.ts>
import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import type { Ignore } from "ignore";
import ignore from "ignore";

/**
 * Unified file resolver that applies gitignore rules consistently
 * across watching, checkpointing, and cleanup systems.
 */
export class UnifiedFileResolver {
  private ignoreCache = new Map<string, Ignore>();

  /**
   * Resolve files matching the given patterns while respecting gitignore rules.
   *
   * @param projectPath - The root directory to search from
   * @param patterns - Array of glob patterns to match
   * @returns Array of resolved file paths relative to projectPath
   */
  async resolveFiles(projectPath: string, patterns: string[]): Promise<string[]> {
    if (patterns.length === 0) {
      return [];
    }

    // Get ignore rules for this project
    const ig = await this.getIgnoreRules(projectPath);

    // Expand glob patterns
    // Note: We need to get all files first, including those in ignored directories,
    // because gitignore negation patterns might un-ignore specific files
    const allFiles = await fg(patterns, {
      cwd: projectPath,
      absolute: false,
      dot: true,
      onlyFiles: true,
      // Don't follow symlinks
      followSymbolicLinks: false,
      // Don't use gitignore - we'll handle it ourselves
      ignore: [".git/**"],
    });

    // Filter through ignore rules
    // The ignore library expects paths without leading "./"
    return allFiles.filter((file) => {
      const normalizedPath = file.startsWith("./") ? file.slice(2) : file;
      return !ig.ignores(normalizedPath);
    });
  }

  /**
   * Get combined ignore rules for a project by parsing all .gitignore files.
   * Results are cached per project path.
   */
  private async getIgnoreRules(projectPath: string): Promise<Ignore> {
    // Check cache first
    const cached = this.ignoreCache.get(projectPath);
    if (cached) {
      return cached;
    }

    // Create new ignore instance
    const ig = ignore();

    // Always ignore .git directory
    ig.add(".git");

    // IMPORTANT: Always ignore the read_only_data_source directory for checkpoints
    // This is enforced here, not via gitignore
    ig.add("/read_only_data_source/");
    ig.add("/read_only_data_source/**");

    // Find all .gitignore files in the project
    const gitignoreFiles = await this.findGitignoreFiles(projectPath);

    // Parse and add rules from each .gitignore file
    for (const gitignorePath of gitignoreFiles) {
      const rules = await this.parseGitignoreFile(projectPath, gitignorePath);
      if (rules.length > 0) {
        // Calculate the relative directory of this .gitignore
        const gitignoreDir = path.dirname(gitignorePath);
        const relativeDir = path.relative(projectPath, gitignoreDir);

        // Apply rules relative to the .gitignore location
        if (relativeDir === "") {
          // Root .gitignore
          ig.add(rules);
        } else {
          // For subdirectory .gitignore files, we need to be more careful
          // The ignore library expects patterns relative to the base directory
          for (const rule of rules) {
            if (rule.startsWith("!")) {
              // For negation rules in subdirectories, we need to handle them specially
              // Convert !file.txt in src/ to !src/file.txt
              const negatedPath = rule.substring(1);
              // Use forward slashes for ignore patterns
              const prefixedRule = `!${relativeDir}/${negatedPath}`.replace(/\\/g, "/");
              ig.add(prefixedRule);
            } else {
              // For other patterns, check if it's a wildcard that should apply recursively
              if (rule.includes("*") && !rule.includes("/")) {
                // Pattern like *.test.js in src/ should match src/**/*.test.js
                const prefixedRule = `${relativeDir}/**/${rule}`.replace(/\\/g, "/");
                ig.add(prefixedRule);
              } else {
                // For other patterns, just prefix with the directory
                const prefixedRule = `${relativeDir}/${rule}`.replace(/\\/g, "/");
                ig.add(prefixedRule);
              }
            }
          }
        }
      }
    }

    // Cache the result
    this.ignoreCache.set(projectPath, ig);
    return ig;
  }

  /**
   * Find all .gitignore files in the project directory tree.
   */
  private async findGitignoreFiles(projectPath: string): Promise<string[]> {
    try {
      const files = await fg("**/.gitignore", {
        cwd: projectPath,
        absolute: true,
        dot: true,
        // Don't search in .git directory
        ignore: [".git/**"],
      });

      // Always check for root .gitignore first
      const rootGitignore = path.join(projectPath, ".gitignore");
      if (fs.existsSync(rootGitignore) && !files.includes(rootGitignore)) {
        files.unshift(rootGitignore);
      }

      return files;
    } catch (error) {
      console.warn(`Failed to find .gitignore files: ${error}`);
      return [];
    }
  }

  /**
   * Parse a .gitignore file and return its rules.
   */
  private async parseGitignoreFile(_projectPath: string, gitignorePath: string): Promise<string[]> {
    try {
      const content = await fs.promises.readFile(gitignorePath, "utf-8");
      const lines = content.split("\n");

      // Filter out comments and empty lines
      const rules = lines
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"))
        .map((rule) => {
          // Handle directory patterns - if it ends with /, convert to wildcard pattern
          // This is needed because the ignore library treats them differently
          if (rule.endsWith("/") && !rule.startsWith("!")) {
            // Convert "build/" to "build/**" for consistency
            return rule.slice(0, -1); // Remove trailing slash, ignore library handles it
          }
          return rule;
        });

      return rules;
    } catch (error) {
      console.warn(`Failed to parse .gitignore at ${gitignorePath}: ${error}`);
      return [];
    }
  }

  /**
   * Clear the ignore cache for a specific project or all projects.
   */
  clearCache(projectPath?: string): void {
    if (projectPath) {
      this.ignoreCache.delete(projectPath);
    } else {
      this.ignoreCache.clear();
    }
  }
}

// Export a singleton instance for convenience
export const fileResolver = new UnifiedFileResolver();

</server/file-resolver.ts>

<server/index.ts>
#!/usr/bin/env bun
import path from "node:path";
import { BasicTUI } from "./basic-tui.js";
import { CleanupCommand } from "./cleanup-command.js";
import { validatePhaseConfig } from "./config.js";
import type { ExecutionSetup } from "./execution-setup.js";
import { setupExecutionEnvironment } from "./execution-setup.js";
import { TadpoleServer } from "./tadpole-server.js";

// -------------
// Main Entry Point
// -------------

async function main() {
  // Strict argument validation
  const rawArgs = process.argv.slice(2);
  const validPatterns = [
    /^--basic$/,
    /^-b$/,
    /^--validate$/,
    /^-v$/,
    /^--cleanup$/,
    /^-y$/,
    /^--no-autostart$/,
    /^--start-new$/,
    /^--config=.+$/,
    /^--data=.+$/,
    /^--execution=.+$/,
    /^--copy$/,
    /^--anthropic-base-url=.+$/,
    /^--port=\d+$/,
    /^--model=(sonnet|opus)$/,
    /^--help$/,
    /^-h$/,
  ];
  for (const arg of rawArgs) {
    if (!validPatterns.some((pattern) => pattern.test(arg))) {
      console.error(`❌ Error: Unknown argument '${arg}'. Run with --help for available options.`);
      process.exit(1);
    }
  }
  const args = process.argv.slice(2);
  const configPath =
    args.find((arg) => arg.startsWith("--config="))?.split("=")[1] || "phases.json";
  const dataSourcePath = args.find((arg) => arg.startsWith("--data="))?.split("=")[1];
  const executionPath = args.find((arg) => arg.startsWith("--execution="))?.split("=")[1];
  const useSymlink = !args.includes("--copy");
  const basicMode = args.includes("--basic") || args.includes("-b");
  const validateMode = args.includes("--validate") || args.includes("-v");
  const cleanupMode = args.includes("--cleanup");
  const skipConfirmation = args.includes("-y");
  const noAutostart = args.includes("--no-autostart");
  const startNew = args.includes("--start-new");
  const anthropicBaseURL = args
    .find((arg) => arg.startsWith("--anthropic-base-url="))
    ?.split("=")[1];
  const port = args.find((arg) => arg.startsWith("--port="))?.split("=")[1];
  const modelOverride = args.find((arg) => arg.startsWith("--model="))?.split("=")[1] as
    | "sonnet"
    | "opus"
    | undefined;

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Tadpole Server - Phase Orchestration

Usage: bun server/index.ts [options]

Options:
  --config=<path>           Path to phases configuration file (default: phases.json)
  --data=<path>             Path to data file or directory (default: current directory)
  --execution=<path>        Resume in specific execution directory
  --start-new               Force creation of a new execution directory
  --copy                    Copy data instead of symlinking (for compatibility)
  --port=<port>             WebSocket server port (default: 7777)
  --basic, -b               Run in basic TUI mode
  --validate, -v            Validate configuration without running
  --cleanup                 Clean up execution directories
  -y                        Skip confirmation prompts
  --no-autostart            Don't automatically start phases
  --model=<sonnet|opus>     Override model for all phases (ignores per-phase settings)
  --anthropic-base-url=<url> Custom Anthropic API base URL
  --help, -h                Show this help message

Execution Isolation:
  Tadpole runs in an isolated execution directory separate from your data.
  This enables clean rollbacks and multiple execution tracking.

  Your data is accessed via: <execution-dir>/read_only_data_source/

Template Variables:
  <%EXECUTION_DIR%>  - The execution directory path
  <%DATA_DIR%>       - The data directory path (execution-dir/read_only_data_source)

Examples:
  # Run with default data (current directory)
  bun server/index.ts

  # Run with specific data directory
  bun server/index.ts --data=/path/to/project

  # Run with specific data file
  bun server/index.ts --data=/path/to/file.txt

  # Resume specific execution
  bun server/index.ts --execution=/home/.tadpole-executions/1234-abc

  # Start fresh execution (ignore existing)
  bun server/index.ts --data=/path/to/project --start-new

  # Start fresh in specific empty directory
  bun server/index.ts --data=/path/to/project --execution=/path/to/empty/dir --start-new

  # Copy data instead of symlinking (for Windows/permissions issues)
  bun server/index.ts --data=/path/to/project --copy

  # Clean up all executions for a data directory
  bun server/index.ts --cleanup --data=/path/to/project

  # Override all phase models to use Opus
  bun server/index.ts --model=opus

  # Run in basic TUI mode with Sonnet override
  bun server/index.ts --basic --model=sonnet
`);
    process.exit(0);
  }

  // Resolve data source path
  const originalCwd = process.cwd(); // Save original CWD
  const resolvedDataPath = path.resolve(dataSourcePath || originalCwd);

  // Set up execution environment
  let executionSetup: ExecutionSetup;
  try {
    executionSetup = await setupExecutionEnvironment({
      readOnlySourceDataPath: resolvedDataPath,
      executionPath: executionPath ? path.resolve(executionPath) : undefined,
      useSymlink,
      startNew,
    });
  } catch (error) {
    console.error(`❌ Execution setup failed: ${(error as Error).message}`);
    process.exit(1);
  }

  console.log(`📁 Data source: ${executionSetup.readOnlySourceDataPath}`);
  console.log(`🏃 Execution: ${executionSetup.executionPath}`);
  console.log(`🔗 Link type: ${executionSetup.linkType}`);

  // Change to execution directory for server operation
  process.chdir(executionSetup.executionPath);

  // Handle cleanup mode - UPDATED FOR LATEST EXECUTION ONLY
  if (cleanupMode) {
    try {
      const cleanup = new CleanupCommand({
        dataSourcePath: executionSetup.readOnlySourceDataPath,
        executionPath: executionSetup.executionPath,
        skipConfirmation,
      });

      const result = await cleanup.execute();
      process.exit(result.success ? 0 : 1);
    } catch (error) {
      console.error(`\n❌ Cleanup failed: ${(error as Error).message}`);
      process.exit(1);
    }
  }

  // Load and validate configuration
  // Config path is resolved relative to original CWD, not execution dir
  const absoluteConfigPath = path.isAbsolute(configPath)
    ? configPath
    : path.resolve(originalCwd, configPath);

  try {
    // Validation mode
    if (validateMode) {
      console.log(`\n🔍 Validating configuration: ${absoluteConfigPath}\n`);

      const validationResult = await validatePhaseConfig(
        absoluteConfigPath,
        executionSetup.executionPath, // Changed from readOnlySourceData
      );

      // Print summary
      console.log(`✅ Configuration is valid!\n`);
      console.log(`📋 Summary:`);
      console.log(`  - Phases: ${validationResult.phaseCount}`);
      console.log(`  - Total prompt files: ${validationResult.promptFileCount}`);
      console.log(`  - Total system prompt files: ${validationResult.systemPromptFileCount}`);
      console.log(`  - Workspace setup operations: ${validationResult.workspaceSetupCount}`);
      console.log(`  - Phases with file watching: ${validationResult.watchingPhaseCount}`);
      console.log(`  - Phases with checkpoints: ${validationResult.checkpointPhaseCount}`);

      // Display environment variables
      const hasSystemVars =
        Object.keys(validationResult.environmentVariables.fromSystem).length > 0;
      const hasPhaseVars = validationResult.environmentVariables.fromPhases.length > 0;

      if (hasSystemVars || hasPhaseVars) {
        console.log(`\n🔧 Environment Variables:`);

        if (hasSystemVars) {
          console.log(`\n  From System (TADPOLE_ prefixed):`);
          for (const [key, value] of Object.entries(
            validationResult.environmentVariables.fromSystem,
          )) {
            console.log(`    - ${key}: ${value}`);
          }
        }

        if (hasPhaseVars) {
          console.log(`\n  From Phase Configurations:`);
          for (const phaseEnv of validationResult.environmentVariables.fromPhases) {
            console.log(`    Phase "${phaseEnv.phaseName}" (${phaseEnv.phaseId}):`);
            for (const [key, value] of Object.entries(phaseEnv.variables)) {
              console.log(`      - ${key}: ${value}`);
            }
          }
        }
      }

      if (validationResult.warnings.length > 0) {
        console.log(`\n⚠️  Warnings:`);
        for (const warning of validationResult.warnings) {
          console.log(`  - ${warning}`);
        }
      }

      process.exit(0);
    }

    // Normal server mode - validate config
    const { phases, warnings } = await validatePhaseConfig(
      absoluteConfigPath,
      executionSetup.executionPath, // Changed from readOnlySourceData
    );

    // Log any non-fatal warnings
    if (warnings.length > 0) {
      console.log("\n⚠️  Configuration warnings:");
      for (const warning of warnings) {
        console.log(`  - ${warning}`);
      }
      console.log();
    }

    // Create server configuration by merging ExecutionSetup with other config
    const serverConfig = {
      // Required execution properties from ExecutionSetup
      readOnlySourceDataPath: executionSetup.readOnlySourceDataPath,
      executionPath: executionSetup.executionPath,
      dataPathInExecutionDir: executionSetup.dataPathInExecutionDir,
      dataHash: executionSetup.dataHash,
      isNewExecution: executionSetup.isNewExecution,
      isResuming: executionSetup.isResuming,
      linkType: executionSetup.linkType,

      // Required phases
      phases,

      // Optional config (will use defaults if not provided)
      ...(anthropicBaseURL && { anthropicBaseURL }),
      ...(port && { port: parseInt(port, 10) }),
      ...(modelOverride && { modelOverride }),
      autostart: !noAutostart,
    };

    const server = new TadpoleServer(serverConfig);
    await server.start();

    if (basicMode) {
      // Give server a moment to start before connecting
      setTimeout(() => {
        new BasicTUI(server);
      }, 100);
      console.log("🎮 Running in basic TUI mode");
    }
  } catch (error) {
    console.error(
      `Failed to start server: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}

</server/index.ts>

<server/state-manager.ts>
// server/state-manager.ts
import fs from "node:fs";
import path from "node:path";
import type { CheckpointGit } from "./checkpoint-git.js";
import { analyzeExecutionThread, type ExecutionThread } from "./execution-thread.js";
import { MetadataValidationError, validateTransitionMetadata } from "./state-transition-guards.js";
import { type StateManagerEvents, TypedEventEmitter } from "./typed-event-emitter.js";
import type { PhaseId, RunId } from "./types/branded-types.js";
import type * as ST from "./types/state-types.js";
import { getPhaseCost, isTerminalPhaseStatus, PhaseTransitions } from "./types/state-types.js";
import type { PhaseConfig } from "./types/types.js";
import type { Logger } from "./utils.js";

// Error types for state management
export class InvalidTransitionError extends Error {
  constructor(from: ST.PhaseStatus, to: ST.PhaseStatus) {
    super(`Invalid transition from ${from} to ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export class PersistenceError extends Error {
  constructor(operation: string, cause: Error) {
    super(`State persistence failed during ${operation}: ${cause.message}`);
    this.name = "PersistenceError";
    this.cause = cause;
  }
}

export class StateManager extends TypedEventEmitter<StateManagerEvents> implements ST.StateManager {
  private state: ST.TadpoleState;
  private readonly statePath: string;
  private readonly stateBackupPath: string;
  private readonly logger: Logger;

  // Enhanced transition queue system
  private transitionQueue: ST.StateTransition[] = [];
  private isProcessing = false;

  // Running cost tallies for performance
  private costCache = {
    total: 0,
    currentRun: 0,
    lastUpdated: null as string | null,
  };

  constructor(
    private readonly tadpoleDir: string,
    logger: Logger,
    private readonly phaseConfigs?: PhaseConfig[],
  ) {
    super();
    this.logger = logger;
    this.statePath = path.join(tadpoleDir, "state.json");
    this.stateBackupPath = path.join(tadpoleDir, "state.json.bak");

    // Initialize empty state
    this.state = {
      runs: [],
      currentRunId: null,
    };
  }

  async initialize(): Promise<void> {
    try {
      if (fs.existsSync(this.statePath)) {
        const content = await fs.promises.readFile(this.statePath, "utf-8");
        const parsedState = JSON.parse(content);

        // Validate before using
        const validation = this.validate(parsedState);
        if (!validation.valid) {
          this.logger.log("State validation errors found:", "error");
          validation.errors.forEach((e) => this.logger.log(`  - ${e.type}: ${e.message}`, "error"));

          if (validation.errors.some((e) => e.type === "corrupted_data")) {
            throw new Error("State file corrupted");
          }
        }

        // Log warnings but continue
        validation.warnings.forEach((w) =>
          this.logger.log(`Warning - ${w.type}: ${w.message}`, "info"),
        );

        this.state = parsedState;
        this.rebuildCostCache();
        this.logger.log("Loaded existing state file");
      } else {
        this.logger.log("No state file found, starting fresh");
      }

      // Detect any crashed runs
      await this.detectCrashedRuns();
    } catch (error) {
      this.logger.log(`Failed to load state: ${error}`, "error");

      // Try backup
      if (fs.existsSync(this.stateBackupPath)) {
        try {
          const content = await fs.promises.readFile(this.stateBackupPath, "utf-8");
          const parsedState = JSON.parse(content);

          // Validate backup too
          const validation = this.validate(parsedState);
          if (validation.valid) {
            this.state = parsedState;
            this.rebuildCostCache();
            this.logger.log("Recovered from backup state file");
          } else {
            this.logger.log("Backup also invalid, starting fresh", "error");
          }
        } catch {
          this.logger.log("Backup also corrupted, starting fresh", "error");
        }
      }
    }
  }

  getState(): Readonly<ST.TadpoleState> {
    return this.state;
  }

  // Public API - fire and forget!
  transition(event: ST.StateTransition): void {
    this.transitionQueue.push(event);
    this.processQueue(); // Don't await - let it run
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;

    this.isProcessing = true;

    while (this.transitionQueue.length > 0) {
      const event = this.transitionQueue.shift();
      if (!event) break; // Should never happen, but satisfies linter

      try {
        this.validateTransition(event);
        const _oldState = this.state;
        const newState = this.applyTransition(this.state, event);
        this.state = newState;

        // Update cost cache if needed
        this.updateCostCache(event);

        await this.save();

        // Log transition for debugging
        await this.logTransitionEvent(event);

        // Emit event AFTER state is persisted
        this.emit("stateChanged", event);
        this.logger.log(`State transition: ${event.type}`);

        // Emit specific events for important transitions
        if (event.type === "PhaseTransitioned" && event.data.to === "running") {
          this.emit("phaseRunning", {
            runId: event.data.runId,
            phaseId: event.data.phaseId,
            from: event.data.from,
            to: "running" as const,
            metadata: event.data.metadata,
          });
        }
      } catch (error) {
        this.logger.log(`State transition failed: ${error}`, "error");
        this.emit("transitionError", { event, error: error as Error });

        if (error instanceof InvalidTransitionError) {
        } else {
          break; // Fatal error
        }
      }
    }

    this.isProcessing = false;
  }

  // Cost cache management
  private updateCostCache(event: ST.StateTransition): void {
    if (
      event.type === "CostsUpdated" ||
      event.type === "CostsIncremented" ||
      event.type === "PhaseFinalCostSet"
    ) {
      // Just rebuild the cache from scratch to ensure accuracy
      this.rebuildCostCache();
    } else if (event.type === "RunStarted") {
      this.costCache.currentRun = 0;
      // Also reset total since we're starting fresh
      this.rebuildCostCache();
    } else if (event.type === "RunCompleted" || event.type === "RunFailed") {
      // Current run cost already in total, just reset current
      this.costCache.currentRun = 0;
    }
  }

  private rebuildCostCache(): void {
    this.costCache.total = this.state.runs.reduce((total, run) => {
      return (
        total +
        run.phases.reduce((runTotal, phase) => {
          return runTotal + getPhaseCost(phase);
        }, 0)
      );
    }, 0);

    const currentRun = this.getCurrentRun();
    if (currentRun) {
      this.costCache.currentRun = currentRun.phases.reduce((total, phase) => {
        return total + getPhaseCost(phase);
      }, 0);
    }
  }

  // Event logging for debugging
  private async logTransitionEvent(event: ST.StateTransition): Promise<void> {
    const eventLog = path.join(this.tadpoleDir, "events.jsonl");
    const logEntry = {
      timestamp: new Date().toISOString(),
      serverPid: process.pid,
      event,
      resultingState: {
        currentRunId: this.state.currentRunId,
        runCount: this.state.runs.length,
        totalCost: this.costCache.total,
        currentRunCost: this.costCache.currentRun,
      },
    };

    try {
      await fs.promises.appendFile(eventLog, `${JSON.stringify(logEntry)}\n`);
    } catch (error) {
      // Don't fail transitions due to logging errors
      this.logger.log(`Failed to log event: ${error}`, "debug");
    }
  }

  // State validation implementation
  validate(state: unknown): ST.StateValidation {
    const errors: ST.ValidationError[] = [];
    const warnings: ST.ValidationWarning[] = [];

    // Type structure validation
    if (!this.isValidStateStructure(state)) {
      errors.push({
        type: "corrupted_data",
        message: "State file has invalid structure",
      });
      return { valid: false, errors, warnings };
    }

    // Referential integrity
    const typedState = state as ST.TadpoleState;
    if (
      typedState.currentRunId &&
      !typedState.runs.find((r) => r.runId === typedState.currentRunId)
    ) {
      errors.push({
        type: "missing_run",
        message: `Current run ${typedState.currentRunId} not found`,
      });
    }

    // Check for orphaned run folders
    const runsDir = path.join(this.tadpoleDir, "runs");
    if (fs.existsSync(runsDir)) {
      const runFolders = fs.readdirSync(runsDir);
      const stateRunIds = new Set(typedState.runs.map((r) => r.runId));

      for (const folder of runFolders) {
        if (!stateRunIds.has(folder as RunId)) {
          warnings.push({
            type: "orphaned_folder",
            message: `Found run folder without state entry: ${folder}`,
          });
        }
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  private isValidStateStructure(state: unknown): state is ST.TadpoleState {
    // Basic type checking - can be expanded
    if (!state || typeof state !== "object") return false;
    const s = state as Record<string, unknown>;
    return Array.isArray(s.runs) && (s.currentRunId === null || typeof s.currentRunId === "string");
  }

  // Query methods with cached costs
  getCurrentRunCost(): number {
    return this.costCache.currentRun;
  }

  getTotalCost(): number {
    return this.costCache.total;
  }

  // Implement all query methods
  getCurrentRun(): ST.Run | null {
    if (!this.state.currentRunId) return null;
    return this.state.runs.find((r) => r.runId === this.state.currentRunId) || null;
  }

  getCurrentlyRunningPhase(): ST.PhaseExecution | null {
    const currentRun = this.getCurrentRun();
    if (!currentRun) return null;

    // Find the last non-terminal phase
    for (let i = currentRun.phases.length - 1; i >= 0; i--) {
      const phase = currentRun.phases[i];
      if (!isTerminalPhaseStatus(phase.status)) {
        return phase;
      }
    }

    return null;
  }

  getPhaseInCurrentRun(phaseId: PhaseId): ST.PhaseExecution | null {
    const currentRun = this.getCurrentRun();
    if (!currentRun) return null;

    return currentRun.phases.find((p) => p.phaseId === phaseId) || null;
  }

  /**
   * Get the next phase that should be executed based on current state.
   * Uses the execution thread to determine where we are in the workflow.
   *
   * @returns PhaseId of next phase to execute, or null if all phases are complete
   */
  async getNextPhaseToExecute(): Promise<PhaseId | null> {
    const thread = await this.getExecutionThread();

    this.logger.log(
      `[getNextPhaseToExecute] Execution thread determined next phase: ${
        thread.nextPhaseId || "none"
      }`,
      "debug",
    );

    return thread.nextPhaseId || null;
  }

  getRun(runId: RunId): ST.Run | null {
    return this.state.runs.find((r) => r.runId === runId) || null;
  }

  async getPhaseHistory(
    phaseId: PhaseId,
  ): Promise<Array<{ run: ST.Run; phase: ST.PhaseExecution }>> {
    const history: Array<{ run: ST.Run; phase: ST.PhaseExecution }> = [];

    // Search all runs in reverse chronological order (newest first)
    for (const run of this.state.runs) {
      for (const phase of run.phases) {
        if (phase.phaseId === phaseId) {
          history.push({ run, phase });
        }
      }
    }

    return history;
  }

  getCostSince(runId: RunId): number {
    let found = false;
    let total = 0;

    for (const run of this.state.runs) {
      if (run.runId === runId) {
        found = true;
      }

      if (found) {
        for (const phase of run.phases) {
          total += getPhaseCost(phase);
        }
      }
    }

    return total;
  }

  canContinueFrom(runId: RunId, afterPhase: PhaseId | null): boolean {
    const run = this.getRun(runId);
    if (!run) return false;

    if (afterPhase) {
      // Check if the phase exists and is completed
      const phase = run.phases.find((p) => p.phaseId === afterPhase);
      return phase?.status === "completed" || false;
    }

    // Can continue from beginning of any run
    return true;
  }

  getCheckpointForContinuation(runId: RunId, afterPhase: PhaseId | null): string | null {
    const run = this.getRun(runId);
    if (!run) return null;

    if (!afterPhase) {
      // Continue from beginning - use first phase's workspace setup checkpoint if available
      const firstPhase = run.phases[0];
      if (
        firstPhase &&
        "workspaceSetupCheckpoint" in firstPhase &&
        firstPhase.workspaceSetupCheckpoint
      ) {
        return firstPhase.workspaceSetupCheckpoint;
      }
      return null;
    }

    // Find the specified phase
    const phase = run.phases.find((p) => p.phaseId === afterPhase);
    if (!phase || phase.status !== "completed") return null;

    return phase.completionCheckpoint;
  }

  getRunById(runId: RunId): ST.Run | null {
    return this.state.runs.find((r) => r.runId === runId) || null;
  }

  // Add reference to CheckpointGit for git operations
  private checkpointGit?: CheckpointGit;

  /**
   * Set the checkpoint git instance for git operations.
   * Called by TadpoleServer after initializing CheckpointGit.
   */
  setCheckpointGit(checkpointGit: CheckpointGit): void {
    this.checkpointGit = checkpointGit;
  }

  /**
   * Get the execution thread for the current state.
   * This provides a unified view of phase execution across all runs.
   *
   * @param targetRunId - Optional run ID to start from (defaults to latest)
   * @param includeCheckpointValidation - Whether to validate checkpoints against git
   * @returns Complete execution thread with all metadata
   */
  async getExecutionThread(
    targetRunId?: RunId,
    includeCheckpointValidation = true,
  ): Promise<ExecutionThread> {
    // Get checkpoint data if requested and available
    const checkpointData =
      includeCheckpointValidation && this.checkpointGit?.isInitialized()
        ? await this.getCheckpointDataMap()
        : undefined;

    return analyzeExecutionThread(
      this.state,
      this.phaseConfigs || [],
      checkpointData,
      targetRunId,
      this.logger,
    );
  }

  /**
   * Helper to convert checkpoint array to map for execution thread
   */
  private async getCheckpointDataMap(): Promise<
    Map<
      string,
      {
        message: string;
        timestamp: string;
        branch: string;
      }
    >
  > {
    const checkpoints = await this.getAllCheckpoints();
    if (!checkpoints) return new Map();

    const map = new Map<
      string,
      {
        message: string;
        timestamp: string;
        branch: string;
      }
    >();

    for (const cp of checkpoints) {
      map.set(cp.sha, {
        message: cp.message,
        timestamp: cp.timestamp,
        branch: cp.branch,
      });
    }

    return map;
  }

  /**
   * Get all checkpoints with detailed information, ordered by time.
   * This exposes the checkpoint history for advanced use cases.
   *
   * @returns Array of checkpoint information ordered by timestamp (newest first), or null if git unavailable
   */
  async getAllCheckpoints(): Promise<Array<{
    sha: string;
    message: string;
    timestamp: string;
    branch: string;
  }> | null> {
    if (!this.checkpointGit?.isInitialized()) {
      return null;
    }

    try {
      return await this.checkpointGit.getAllCheckpoints();
    } catch (error) {
      this.logger.log(`Failed to get all checkpoints: ${error}`, "error");
      return null;
    }
  }

  // State modification internals
  private validateTransition(event: ST.StateTransition): void {
    if (event.type === "PhaseTransitioned") {
      const { from, to, metadata } = event.data;
      const validTransitions = PhaseTransitions[from];

      if (!validTransitions.includes(to)) {
        throw new InvalidTransitionError(from, to);
      }

      // Validate metadata for specific transitions
      try {
        validateTransitionMetadata(to, metadata);
      } catch (error) {
        if (error instanceof MetadataValidationError) {
          // Log the actual metadata validation error for debugging
          this.logger.log(
            `Metadata validation failed for ${from} → ${to}: ${error.message}`,
            "error",
          );
          // Re-throw the original error so we know what's missing
          throw error;
        }
        throw error;
      }
    }

    // Add more validation as needed
  }

  private applyTransition(state: ST.TadpoleState, event: ST.StateTransition): ST.TadpoleState {
    // Deep clone state to ensure immutability
    const newState = JSON.parse(JSON.stringify(state)) as ST.TadpoleState;

    switch (event.type) {
      case "RunStarted": {
        const newRun: ST.Run = {
          runId: event.data.runId,
          runFolder: event.data.runFolder,
          gitBranch: event.data.gitBranch,
          startingConditions: event.data.startingConditions,
          phases: [],
          status: "running",
          startTime: new Date().toISOString(),
          serverPid: event.data.serverPid,
        };

        newState.runs.unshift(newRun); // Add to beginning
        newState.currentRunId = event.data.runId;
        break;
      }

      case "InitialCheckpointSet": {
        newState.initialCheckpoint = event.data.sha;
        break;
      }

      case "RunCompleted": {
        const run = newState.runs.find((r) => r.runId === event.data.runId);
        if (run) {
          run.status = "completed";
          run.endTime = new Date().toISOString();
        }
        newState.currentRunId = null;
        break;
      }

      case "RunFailed": {
        const run = newState.runs.find((r) => r.runId === event.data.runId);
        if (run) {
          run.status = "failed";
          run.endTime = new Date().toISOString();
        }
        newState.currentRunId = null;
        break;
      }

      case "RunCrashed": {
        const run = newState.runs.find((r) => r.runId === event.data.runId);
        if (run) {
          run.status = "crashed";
          run.endTime = event.data.detectedAt;

          // Mark any running phase as failed
          const runningPhase = run.phases.find((p) => !isTerminalPhaseStatus(p.status));
          if (runningPhase) {
            const failedPhase: ST.FailedPhase = {
              ...runningPhase,
              status: "failed",
              endTime: event.data.detectedAt,
              failedDuring: runningPhase.status as
                | "preparing"
                | "starting"
                | "initializing"
                | "running",
              exitCode: -1,
              failureReason: {
                type: "unknown",
                retriable: false,
                message: "Server crashed",
              },
              partialCost: "currentCost" in runningPhase ? runningPhase.currentCost : 0,
              partialTokens:
                "currentTokens" in runningPhase
                  ? runningPhase.currentTokens
                  : {
                      inputTokens: 0,
                      outputTokens: 0,
                      cacheCreationTokens: 0,
                      cacheReadTokens: 0,
                    },
            };

            // Replace the phase
            const phaseIndex = run.phases.indexOf(runningPhase);
            run.phases[phaseIndex] = failedPhase;
          }
        }
        break;
      }

      case "PhaseStarted": {
        const run = newState.runs.find((r) => r.runId === event.data.runId);
        if (run) {
          const newPhase: ST.PreparingPhase = {
            phaseId: event.data.phaseId,
            startTime: new Date().toISOString(),
            status: "preparing",
          };
          run.phases.push(newPhase);
        }
        break;
      }

      case "PhaseTransitioned": {
        const run = newState.runs.find((r) => r.runId === event.data.runId);
        if (!run) break;

        // Find the phase by ID, preferring non-terminal phases
        let phaseIndex = -1;

        // First, try to find a non-terminal phase with this ID
        for (let i = run.phases.length - 1; i >= 0; i--) {
          const phase = run.phases[i];
          if (phase.phaseId === event.data.phaseId && !isTerminalPhaseStatus(phase.status)) {
            phaseIndex = i;
            break;
          }
        }

        // If no non-terminal phase found, look for any phase with this ID and matching status
        if (phaseIndex === -1) {
          phaseIndex = run.phases.findIndex(
            (p) => p.phaseId === event.data.phaseId && p.status === event.data.from,
          );
        }

        if (phaseIndex === -1) break;

        // Validate the transition is valid from current state
        const currentPhase = run.phases[phaseIndex];
        if (currentPhase.status !== event.data.from) {
          throw new InvalidTransitionError(currentPhase.status, event.data.to);
        }

        const { to, metadata } = event.data;

        // Apply transition based on target status
        switch (to) {
          case "starting": {
            const startingPhase: ST.StartingPhase = {
              ...currentPhase,
              status: "starting",
              workspaceSetupCheckpoint: metadata?.checkpointSha,
            };
            run.phases[phaseIndex] = startingPhase;
            break;
          }

          case "initializing": {
            // TypeScript knows metadata is valid from validateTransition
            if (
              !metadata ||
              typeof metadata !== "object" ||
              !("claudePid" in metadata) ||
              !("claudeLogPath" in metadata)
            ) {
              throw new Error("Invalid metadata for initializing transition");
            }
            const initializingPhase: ST.InitializingPhase = {
              ...(currentPhase as ST.StartingPhase),
              status: "initializing",
              claudePid: metadata.claudePid as number,
              claudeLogPath: metadata.claudeLogPath as string,
              previousSessionId:
                metadata.previousSessionId ||
                ("previousSessionId" in currentPhase ? currentPhase.previousSessionId : undefined),
            };
            run.phases[phaseIndex] = initializingPhase;
            break;
          }

          case "running": {
            // TypeScript knows metadata is valid from validateTransition
            if (!metadata || typeof metadata !== "object" || !("claudeSessionId" in metadata)) {
              throw new Error("Invalid metadata for running transition");
            }
            const runningPhase: ST.RunningPhase = {
              ...(currentPhase as ST.InitializingPhase),
              status: "running",
              claudeSessionId: metadata.claudeSessionId as ST.SessionId,
              currentCost: 0,
              currentTokens: {
                inputTokens: 0,
                outputTokens: 0,
                cacheCreationTokens: 0,
                cacheReadTokens: 0,
              },
              assistantMessageCount: 0,
            };
            run.phases[phaseIndex] = runningPhase;
            break;
          }

          case "completed": {
            const completedPhase: ST.CompletedPhase = {
              ...(currentPhase as ST.RunningPhase),
              status: "completed",
              endTime: new Date().toISOString(),
              exitCode: 0,
              finalCost: "currentCost" in currentPhase ? currentPhase.currentCost : 0,
              finalTokens:
                "currentTokens" in currentPhase
                  ? currentPhase.currentTokens
                  : {
                      inputTokens: 0,
                      outputTokens: 0,
                      cacheCreationTokens: 0,
                      cacheReadTokens: 0,
                    },
              resultMessageReceived: metadata?.resultMessageReceived || false,
              completionCheckpoint: metadata?.checkpointSha || "",
            };
            run.phases[phaseIndex] = completedPhase;
            break;
          }

          case "failed": {
            // TypeScript knows metadata is valid from validateTransition
            if (
              !metadata ||
              typeof metadata !== "object" ||
              !("failedDuring" in metadata) ||
              !("exitCode" in metadata) ||
              !("failureReason" in metadata)
            ) {
              throw new Error("Invalid metadata for failed transition");
            }
            const failedPhase: ST.FailedPhase = {
              phaseId: currentPhase.phaseId,
              startTime: currentPhase.startTime,
              status: "failed",
              endTime: new Date().toISOString(),
              failedDuring: metadata.failedDuring as
                | "preparing"
                | "starting"
                | "initializing"
                | "running",
              exitCode: metadata.exitCode as number,
              failureReason: metadata.failureReason as ST.FailureReason,
              partialCost: "currentCost" in currentPhase ? currentPhase.currentCost : 0,
              partialTokens:
                "currentTokens" in currentPhase
                  ? currentPhase.currentTokens
                  : {
                      inputTokens: 0,
                      outputTokens: 0,
                      cacheCreationTokens: 0,
                      cacheReadTokens: 0,
                    },
            };

            // Copy optional fields if they exist
            if ("workspaceSetupCheckpoint" in currentPhase) {
              failedPhase.workspaceSetupCheckpoint = currentPhase.workspaceSetupCheckpoint;
            }
            if ("claudePid" in currentPhase) {
              failedPhase.claudePid = currentPhase.claudePid;
            }
            if ("claudeSessionId" in currentPhase) {
              failedPhase.claudeSessionId = currentPhase.claudeSessionId;
            }
            if ("claudeLogPath" in currentPhase) {
              failedPhase.claudeLogPath = currentPhase.claudeLogPath;
            }
            if ("previousSessionId" in currentPhase) {
              failedPhase.previousSessionId = currentPhase.previousSessionId;
            }
            if (metadata?.checkpointSha) {
              failedPhase.errorCheckpoint = metadata.checkpointSha;
            }

            run.phases[phaseIndex] = failedPhase;
            break;
          }

          case "skipped": {
            // TypeScript knows metadata is valid from validateTransition
            if (!metadata || typeof metadata !== "object" || !("skippedDuring" in metadata)) {
              throw new Error("Invalid metadata for skipped transition");
            }
            const skippedPhase: ST.SkippedPhase = {
              phaseId: currentPhase.phaseId,
              startTime: currentPhase.startTime,
              status: "skipped",
              endTime: new Date().toISOString(),
              skippedDuring: metadata.skippedDuring as
                | "preparing"
                | "starting"
                | "initializing"
                | "running",
              // Preserve any accumulated costs and tokens from when the phase was running
              partialCost: "currentCost" in currentPhase ? currentPhase.currentCost : 0,
              partialTokens:
                "currentTokens" in currentPhase
                  ? currentPhase.currentTokens
                  : {
                      inputTokens: 0,
                      outputTokens: 0,
                      cacheCreationTokens: 0,
                      cacheReadTokens: 0,
                    },
            };

            // Copy optional fields if they exist
            if ("workspaceSetupCheckpoint" in currentPhase) {
              skippedPhase.workspaceSetupCheckpoint = currentPhase.workspaceSetupCheckpoint;
            }
            if ("claudePid" in currentPhase) {
              skippedPhase.claudePid = currentPhase.claudePid;
            }
            if ("claudeSessionId" in currentPhase) {
              skippedPhase.claudeSessionId = currentPhase.claudeSessionId;
            }
            if ("claudeLogPath" in currentPhase) {
              skippedPhase.claudeLogPath = currentPhase.claudeLogPath;
            }
            if ("previousSessionId" in currentPhase) {
              skippedPhase.previousSessionId = currentPhase.previousSessionId;
            }
            if ("assistantMessageCount" in currentPhase) {
              skippedPhase.assistantMessageCount = currentPhase.assistantMessageCount;
            }
            if (metadata?.checkpointSha) {
              skippedPhase.skipCheckpoint = metadata.checkpointSha;
            }

            run.phases[phaseIndex] = skippedPhase;
            break;
          }
        }
        break;
      }

      case "CostsUpdated": {
        const run = newState.runs.find((r) => r.runId === event.data.runId);
        if (!run) break;

        const phase = run.phases.find((p) => p.phaseId === event.data.phaseId);
        if (!phase) break;

        if (phase.status === "running") {
          phase.currentCost = event.data.cost;
          phase.currentTokens = event.data.tokens;
        }
        break;
      }

      case "CostsIncremented": {
        const run = newState.runs.find((r) => r.runId === event.data.runId);
        if (!run) break;

        // Find the most recent running phase with this ID
        const phase = run.phases
          .slice()
          .reverse()
          .find((p) => p.phaseId === event.data.phaseId && p.status === "running");

        if (phase && phase.status === "running") {
          phase.currentCost += event.data.costDelta;
          phase.currentTokens.inputTokens += event.data.tokensDelta.inputTokens;
          phase.currentTokens.outputTokens += event.data.tokensDelta.outputTokens;
          phase.currentTokens.cacheCreationTokens += event.data.tokensDelta.cacheCreationTokens;
          phase.currentTokens.cacheReadTokens += event.data.tokensDelta.cacheReadTokens;
        }
        break;
      }

      case "AssistantMessageCountUpdated": {
        const run = newState.runs.find((r) => r.runId === event.data.runId);
        if (!run) break;

        const phase = run.phases.find((p) => p.phaseId === event.data.phaseId);
        if (!phase) break;

        if (phase.status === "running") {
          phase.assistantMessageCount = event.data.newCount;
        } else if (phase.status === "skipped" && "assistantMessageCount" in phase) {
          // Update count for skipped phases that were running before skip
          phase.assistantMessageCount = event.data.newCount;
        }
        break;
      }

      case "CheckpointCreated": {
        const run = newState.runs.find((r) => r.runId === event.data.runId);
        if (!run) break;

        const phase = run.phases.find((p) => p.phaseId === event.data.phaseId);
        if (!phase) break;

        switch (event.data.checkpointType) {
          case "workspace-setup":
            if (
              "workspaceSetupCheckpoint" in phase ||
              phase.status === "preparing" ||
              phase.status === "starting"
            ) {
              (
                phase as ST.PreparingPhase & {
                  workspaceSetupCheckpoint?: string;
                }
              ).workspaceSetupCheckpoint = event.data.sha;
            }
            break;
          case "completed":
            if (phase.status === "completed") {
              phase.completionCheckpoint = event.data.sha;
            }
            break;
          case "error":
            if (phase.status === "failed") {
              phase.errorCheckpoint = event.data.sha;
            }
            break;
          case "skipped":
            if (phase.status === "skipped") {
              phase.skipCheckpoint = event.data.sha;
            }
            break;
        }
        break;
      }

      case "PhaseFinalCostSet": {
        const run = newState.runs.find((r) => r.runId === event.data.runId);
        if (!run) break;

        const phase = run.phases
          .slice()
          .reverse()
          .find((p) => p.phaseId === event.data.phaseId && p.status === "running");

        if (phase && phase.status === "running") {
          phase.currentCost = event.data.finalCost;
          phase.currentTokens = event.data.finalTokens;
        }
        break;
      }
    }

    return newState;
  }

  async save(): Promise<void> {
    try {
      // Create backup of current state
      if (fs.existsSync(this.statePath)) {
        await fs.promises.copyFile(this.statePath, this.stateBackupPath);
      }

      // Write to temp file first
      const tempPath = `${this.statePath}.tmp`;
      await fs.promises.writeFile(tempPath, JSON.stringify(this.state, null, 2), "utf-8");

      // Atomic rename
      await fs.promises.rename(tempPath, this.statePath);
    } catch (error) {
      throw new PersistenceError("save", error as Error);
    }
  }

  async detectCrashedRuns(): Promise<void> {
    // Find any runs with status="running"
    for (const run of this.state.runs) {
      if (run.status === "running" && run.runId !== this.state.currentRunId) {
        // Check if the server is still running
        try {
          process.kill(run.serverPid, 0); // Signal 0 = check if process exists
        } catch {
          // Process doesn't exist - mark as crashed
          const lastPhase = run.phases[run.phases.length - 1];
          const lastPhaseStatus = lastPhase?.status || ("unknown" as ST.PhaseStatus);

          this.transition({
            type: "RunCrashed",
            data: {
              runId: run.runId,
              detectedAt: new Date().toISOString(),
              lastPhaseStatus,
            },
          });
        }
      }
    }
  }

  async recover(): Promise<ST.RecoveryResult> {
    // Simple recovery - just start fresh
    this.state = {
      runs: [],
      currentRunId: null,
    };

    await this.save();

    return {
      success: true,
      method: "fresh",
      dataLoss: true,
      message: "Started with fresh state",
    };
  }

  async waitForPendingTransitions(): Promise<void> {
    while (this.isProcessing || this.transitionQueue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

</server/state-manager.ts>

<server/state-transition-guards.ts>
import type { SessionId } from "./types/branded-types.js";
import type { PhaseStatus } from "./types/state-types.js";
import type { FailureReason } from "./types/types.js";

// Type guard functions to ensure metadata has required fields for specific transitions

// Metadata for transitioning to initializing
export interface InitializingMetadata {
  claudePid: number;
  claudeLogPath: string;
}

// Metadata for transitioning to running
export interface RunningMetadata {
  claudeSessionId: SessionId;
}

// Metadata for transitioning to completed
export interface CompletedMetadata {
  checkpointSha: string;
  resultMessageReceived?: boolean;
}

// Metadata for transitioning to failed
export interface FailedMetadata {
  exitCode: number;
  failureReason: FailureReason;
  failedDuring: PhaseStatus;
  checkpointSha?: string;
}

// Metadata for transitioning to skipped
export interface SkippedMetadata {
  skippedDuring: PhaseStatus;
  checkpointSha?: string;
}

// Type guards
export function hasInitializingMetadata(metadata: unknown): metadata is InitializingMetadata {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "claudePid" in metadata &&
    "claudeLogPath" in metadata &&
    typeof (metadata as Record<string, unknown>).claudePid === "number" &&
    typeof (metadata as Record<string, unknown>).claudeLogPath === "string"
  );
}

export function hasRunningMetadata(metadata: unknown): metadata is RunningMetadata {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "claudeSessionId" in metadata &&
    typeof (metadata as Record<string, unknown>).claudeSessionId === "string"
  );
}

export function hasCompletedMetadata(metadata: unknown): metadata is CompletedMetadata {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "checkpointSha" in metadata &&
    typeof (metadata as Record<string, unknown>).checkpointSha === "string"
  );
}

export function hasFailedMetadata(metadata: unknown): metadata is FailedMetadata {
  const meta = metadata as Record<string, unknown>;
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "exitCode" in metadata &&
    typeof meta.exitCode === "number" &&
    "failureReason" in metadata &&
    typeof meta.failureReason === "object" &&
    "failedDuring" in metadata &&
    typeof meta.failedDuring === "string"
  );
}

export function hasSkippedMetadata(metadata: unknown): metadata is SkippedMetadata {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "skippedDuring" in metadata &&
    typeof (metadata as Record<string, unknown>).skippedDuring === "string"
  );
}

// Validation error class
export class MetadataValidationError extends Error {
  constructor(
    public readonly transitionTo: PhaseStatus,
    public readonly missingFields: string[],
  ) {
    super(
      `Missing required metadata fields for transition to ${transitionTo}: ${missingFields.join(
        ", ",
      )}`,
    );
    this.name = "MetadataValidationError";
  }
}

// Validation function that throws descriptive errors
export function validateTransitionMetadata(to: PhaseStatus, metadata: unknown): void {
  switch (to) {
    case "initializing":
      if (!hasInitializingMetadata(metadata)) {
        const missing: string[] = [];
        if (!metadata || typeof metadata !== "object") {
          missing.push("metadata object");
        } else {
          if (!("claudePid" in metadata)) missing.push("claudePid");
          if (!("claudeLogPath" in metadata)) missing.push("claudeLogPath");
        }
        throw new MetadataValidationError(to, missing);
      }
      break;

    case "running":
      if (!hasRunningMetadata(metadata)) {
        const missing: string[] = [];
        if (!metadata || typeof metadata !== "object") {
          missing.push("metadata object");
        } else {
          if (!("claudeSessionId" in metadata)) missing.push("claudeSessionId");
        }
        throw new MetadataValidationError(to, missing);
      }
      break;

    case "completed":
      if (!hasCompletedMetadata(metadata)) {
        const missing: string[] = [];
        if (!metadata || typeof metadata !== "object") {
          missing.push("metadata object");
        } else {
          if (!("checkpointSha" in metadata)) missing.push("checkpointSha");
        }
        throw new MetadataValidationError(to, missing);
      }
      break;

    case "failed":
      if (!hasFailedMetadata(metadata)) {
        const missing: string[] = [];
        if (!metadata || typeof metadata !== "object") {
          missing.push("metadata object");
        } else {
          if (!("exitCode" in metadata)) missing.push("exitCode");
          if (!("failureReason" in metadata)) missing.push("failureReason");
          if (!("failedDuring" in metadata)) missing.push("failedDuring");
        }
        throw new MetadataValidationError(to, missing);
      }
      break;

    case "skipped":
      if (!hasSkippedMetadata(metadata)) {
        const missing: string[] = [];
        if (!metadata || typeof metadata !== "object") {
          missing.push("metadata object");
        } else {
          if (!("skippedDuring" in metadata)) missing.push("skippedDuring");
        }
        throw new MetadataValidationError(to, missing);
      }
      break;

    // Other transitions don't require metadata
    case "preparing":
    case "starting":
      break;
  }
}

</server/state-transition-guards.ts>

<server/tadpole-server.ts>
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { minimatch } from "minimatch";
import { CheckpointGit } from "./checkpoint-git.js";
import { ClaudeLogParser } from "./claude-log-parser.js";
import { ClaudeProcessManager } from "./claude-process-manager.js";
import { type ClientCommand, clientCommandSchema } from "./command-schemas.js";
import { calculateCost, DEFAULT_CONFIG, TIMEOUTS } from "./config.js";
import { analyzeExecutionThread, findContinuationSessionId } from "./execution-thread.js";
import { fileResolver } from "./file-resolver.js";
import { StateManager } from "./state-manager.js";
import { type ServerInternalEvents, TypedEventEmitter } from "./typed-event-emitter.js";
import { EventId, PhaseId, RunId, SessionId } from "./types/branded-types.js";
import type {
  AssistantMessage,
  ResultMessage,
  SystemMessage,
  TextContent,
  ThinkingContent,
  ToolResultContent,
  ToolUseContent,
  UserMessage,
} from "./types/claude-session-schema.js";
import { APITimeoutError, ErrorSeverity } from "./types/error-types.js";
import {
  isTerminalPhaseStatus,
  type PhaseExecution,
  type PhaseStatus,
} from "./types/state-types.js";
import type { ToolInputMap, ToolName } from "./types/tool-types.js";
import type {
  AssistantActionEvent,
  CheckpointInfo,
  ClaudeLogMessage,
  ErrorEvent,
  FailureReason,
  FileTreeUpdatedEvent,
  FileUpdatedEvent,
  InfoEvent,
  PhaseCompletedEvent,
  PhaseConfig,
  PhaseStartedEvent,
  ServerConfig,
  ServerEvent,
  ServerReadyEvent,
  StateSnapshotEvent,
  TokenUsage,
  TokenUsageEvent,
} from "./types/types.js";
import { isSyntheticTimeout } from "./types/types.js";
import {
  assertNever,
  buildFileTree,
  escapeShellArg,
  generateId,
  Logger,
  toError,
} from "./utils.js";

/**
 * This file is organized into logical sections for easier navigation.
 * Use `grep -A1 "// ====" tadpole-server.ts | grep "//"` to see all sections.
 */

/**
 * Client metadata stored with each WebSocket connection.
 * Provides connection tracking and activity monitoring.
 */
interface ClientData {
  connectionTime: Date;
  lastActivity: Date;
}

/**
 * Main server class that orchestrates Claude phases.
 *
 * Responsibilities:
 * - WebSocket server management (single client)
 * - Phase execution and lifecycle
 * - Claude process management
 * - File watching and change detection
 * - State persistence and recovery
 * - Cost tracking and reporting
 * - Event streaming to clients
 */
export class TadpoleServer extends TypedEventEmitter<ServerInternalEvents> {
  private server: Server | null = null;
  private client: ServerWebSocket<ClientData> | null = null;
  public readonly config: ServerConfig;
  private logger: Logger;

  // State management
  private stateManager: StateManager;
  private currentRunId: RunId | null = null;
  private heartbeatInterval?: NodeJS.Timeout;

  // Track pending tool uses for result matching
  private pendingToolUses: Map<
    string,
    {
      toolName: string;
      timestamp: number;
      phaseId: string;
    }
  > = new Map();

  // Temporary state during phase execution
  private watchedPatterns: string[] = [];
  private currentPhase:
    | {
        status: "initializing" | "running";
        phase: PhaseConfig;
        previousSessionId?: SessionId;
        sessionId?: SessionId;
        startTime: Date;
        phaseCost: number;
        phaseTokens: TokenUsage;
      }
    | undefined;
  private recentFileAccess:
    | {
        path: string;
        content: string;
        timestamp: Date;
      }
    | undefined;
  private processManager: ClaudeProcessManager | undefined;
  private serverStartTime: Date;
  private isShuttingDown = false;
  private isSkippingPhase = false;
  private logParser: ClaudeLogParser | null = null;

  // Checkpoint-related properties
  private checkpointGit: CheckpointGit | null = null;
  private checkpointingEnabled = true;

  // Failure tracking
  private phaseFailureReason?: FailureReason;
  private isForceStopping = false;
  private resultMessageReceived = false;

  // Rollback state
  private isRollingBack = false;
  private readonly READ_ONLY_COMMANDS = new Set([
    "checkpoint.list",
    "server.shutdown", // Special case - always allowed
  ]);

  constructor(
    config: Omit<ServerConfig, keyof typeof DEFAULT_CONFIG> &
      Partial<Pick<ServerConfig, keyof typeof DEFAULT_CONFIG>> & {
        phases: PhaseConfig[];
      },
  ) {
    super();
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    } as ServerConfig;

    // Update logger to use execution path
    this.logger = new Logger(path.join(this.config.executionPath, this.config.serverLogFile));
    this.serverStartTime = new Date();

    // Initialize state manager with execution path
    const tadpoleDir = path.join(this.config.executionPath, ".tadpole");
    this.stateManager = new StateManager(tadpoleDir, this.logger, this.config.phases);

    // Set up state manager listeners
    this.setupStateManagerListeners();
  }

  private setupStateManagerListeners(): void {
    this.stateManager.on("phaseRunning", (data) => {
      // State is already saved when we get here
      const phase = this.stateManager.getCurrentlyRunningPhase();
      if (phase && "claudeSessionId" in phase) {
        const phaseConfig = this.config.phases.find((p) => p.id === data.phaseId);
        if (phaseConfig) {
          this.sendEvent({
            id: EventId(generateId()),
            timestamp: new Date().toISOString(),
            type: "phase.started",
            data: {
              phaseId: data.phaseId,
              phaseName: phaseConfig.name,
              phaseDescription: phaseConfig.description,
              sessionId: phase.claudeSessionId,
              previousSessionId: "previousSessionId" in phase ? phase.previousSessionId : undefined,
              startTime: phase.startTime,
            },
          } as PhaseStartedEvent);
        }
      }
    });

    this.stateManager.on("transitionError", ({ event: _event, error }) => {
      if (error.name === "PersistenceError") {
        // Can't save state - this is fatal
        this.handleError(error, "state-persistence", ErrorSeverity.FATAL);
      }
    });
  }

  // -------------
  // Initialization & Server Management
  // -------------

  /**
   * Initialize and start the WebSocket server.
   *
   * Steps:
   * 1. Check for existing lock file (prevent multiple instances)
   * 2. Create lock file with current PID
   * 3. Initialize state manager
   * 4. Start WebSocket server on configured port
   * 5. Set up process termination handlers
   *
   * @throws Error if server is already running
   */
  async start(): Promise<void> {
    this.logger.log(
      `Starting Tadpole Server v${this.config.version} in ${this.config.executionPath}`,
    );

    // Initialize checkpoint system (checks for existing .tadpole)
    await this.initializeCheckpoints();

    // Initialize state manager
    await this.stateManager.initialize();

    // Check for existing lock file
    if (fs.existsSync(this.config.lockFile)) {
      const lockData = fs.readFileSync(this.config.lockFile, "utf-8");

      // Parse lock file for enhanced data
      try {
        const lockInfo = JSON.parse(lockData);
        const heartbeatAge = Date.now() - new Date(lockInfo.lastHeartbeat).getTime();

        if (heartbeatAge > 120000) {
          // 2 minutes
          this.logger.log(`Found stale lock file (heartbeat age: ${heartbeatAge}ms), removing...`);
          fs.unlinkSync(this.config.lockFile);

          // Mark the run as crashed
          if (lockInfo.runId) {
            this.stateManager.transition({
              type: "RunCrashed",
              data: {
                runId: RunId(lockInfo.runId),
                detectedAt: new Date().toISOString(),
                lastPhaseStatus: "unknown" as PhaseStatus,
              },
            });
          }
        } else {
          // Check if it's our current run
          const state = this.stateManager.getState();
          if (state.currentRunId && state.currentRunId === lockInfo.runId) {
            // We're recovering from a crash - continue the same run
            // TODO: This needs a lot more implementation to properly continue, but not implemented yet.
            this.currentRunId = RunId(lockInfo.runId);
            this.logger.log(`Recovering run ${this.currentRunId}`);
          } else {
            throw new Error(
              `Server already running (PID: ${lockInfo.pid}, Run: ${lockInfo.runId})`,
            );
          }
        }
      } catch (_e) {
        // Old format lock file - just PID
        throw new Error(
          `Server already running (PID: ${lockData}). Remove ${this.config.lockFile} if this is incorrect.`,
        );
      }
    }

    // Start a new run if needed
    if (!this.currentRunId) {
      await this.startNewRun();

      // Now switch to the new run's branch if we have checkpoints
      const currentRun = this.stateManager.getCurrentRun();
      if (currentRun?.gitBranch && this.checkpointGit) {
        // For fresh runs, the branch doesn't exist yet - it will be created on first checkpoint
        // Check if this is a fresh run to avoid unnecessary warnings
        const isFreshRun = currentRun.startingConditions?.type === "fresh";
        if (!isFreshRun) {
          try {
            await this.checkpointGit.switchToBranch(currentRun.gitBranch);
          } catch (error) {
            this.logger.log(`Failed to switch to run branch: ${error}`, "error");
          }
        } else {
          this.logger.log(
            `Fresh run ${currentRun.runId} - branch will be created on first checkpoint`,
          );
        }
      }
    }

    // Start Bun WebSocket server
    this.server = Bun.serve<ClientData, undefined>({
      port: this.config.port,
      websocket: {
        open: (ws) => this.handleConnection(ws),
        message: (ws, message) => this.handleMessage(ws, message),
        close: (ws) => this.handleClose(ws),
      },
      fetch(req, server) {
        // Upgrade to WebSocket
        if (server.upgrade(req)) {
          return;
        }
        return new Response("WebSocket server only", { status: 400 });
      },
    });

    this.logger.log(`WebSocket server listening on port ${this.config.port}`);

    // Handle process termination
    process.on("SIGINT", () => this.shutdown("SIGINT"));
    process.on("SIGTERM", () => this.shutdown("SIGTERM"));
    process.on("uncaughtException", (error) => {
      this.logger.log(`Uncaught exception: ${error.message}`, "error");
      this.shutdown("uncaughtException");
    });
    process.on("unhandledRejection", (reason, promise) => {
      this.logger.log(`Unhandled rejection at: ${promise}, reason: ${reason}`, "error");
      this.shutdown("unhandledRejection");
    });
  }

  // -------------
  // WebSocket Connection Management
  // -------------

  private handleConnection(ws: ServerWebSocket<ClientData>): void {
    if (this.client) {
      this.logger.log("Rejecting connection - already have a client");
      ws.close(1008, "Server already has a client");
      return;
    }

    this.logger.log("Client connected");
    const now = new Date();
    ws.data = {
      connectionTime: now,
      lastActivity: now,
    };
    this.client = ws;

    // Send initial state
    this.sendEvent({
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "server.ready",
      data: {
        serverVersion: this.config.version,
        executionPath: this.config.executionPath,
        dataPath: this.config.dataPathInExecutionDir,
      },
    } as ServerReadyEvent);

    this.sendStateSnapshot();

    // Only auto-start if enabled
    if (this.config.autostart) {
      this.autoStartNextPhase();
    } else {
      this.sendEvent({
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "server.idle",
        data: {
          reason: "startup",
          message: "Server ready. Waiting for commands (autostart disabled).",
        },
      } as import("./types/types.js").ServerIdleEvent);
    }
  }

  private handleMessage(ws: ServerWebSocket<ClientData>, message: string | Buffer): void {
    try {
      ws.data.lastActivity = new Date();

      const parsed = JSON.parse(message.toString());
      const result = clientCommandSchema.safeParse(parsed);

      if (!result.success) {
        this.logger.log(`Invalid client command: ${result.error.message}`, "error");
        this.sendEvent({
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "error",
          data: {
            message: "Invalid command format",
            fatal: false,
          },
        } as ErrorEvent);
        return;
      }

      this.logger.logSocketTraffic(this.config.socketLogFile, "in", result.data);
      this.handleCommand(result.data);
    } catch (error) {
      this.logger.log(`Error parsing command: ${toError(error).message}`, "error");
    }
  }

  private handleClose(_ws: ServerWebSocket<ClientData>): void {
    this.logger.log("Client disconnected - shutting down server");
    this.shutdown("client disconnect");
  }

  // -------------
  // Command Processing
  // -------------

  async handleCommand(command: ClientCommand): Promise<void> {
    this.logger.log(`Handling command: ${command.type}`);

    // Check if command is blocked during rollback
    if (this.isRollingBack && !this.READ_ONLY_COMMANDS.has(command.type)) {
      this.sendEvent({
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "error",
        data: {
          message: "Cannot execute state-modifying commands while rollback is in progress",
          context: `Attempted command: ${command.type}`,
          phase: this.currentPhase?.phase.id,
          fatal: false,
          severity: ErrorSeverity.OPERATION,
          code: "ROLLBACK_IN_PROGRESS",
        },
      } as ErrorEvent);
      return;
    }

    switch (command.type) {
      case "phase.start": {
        await this.startPhase(command.data.phaseId, command.data.skipPreCommands);
        break;
      }

      case "phase.next":
        await this.startNextPhase();
        break;

      case "phase.skip":
        await this.skipCurrentPhase();
        break;

      case "phase.redo":
        await this.redoCurrentPhase();
        break;

      case "server.shutdown":
        await this.shutdown("client request");
        break;

      case "checkpoint.list":
        await this.listCheckpoints(command.data?.runId);
        break;

      case "phase.forceStop":
        await this.forceStopPhase(command.data?.reason);
        break;

      case "rollback.toCheckpoint":
        await this.rollbackToCheckpoint(
          command.data.checkpointSha,
          command.data.autoRestart ?? false,
        );
        break;

      case "rollback.toPhase":
        await this.rollbackToPhase(
          command.data.phaseId,
          command.data.checkpointType,
          command.data.autoRestart ?? false,
        );
        break;

      case "rollback.toLastSuccess":
        await this.rollbackToLastSuccess(command.data?.autoRestart ?? false);
        break;

      default:
        // This should never happen due to Zod validation
        assertNever(command);
    }
  }

  // -------------
  // Event & State Management
  // -------------

  private sendEvent(event: ServerEvent): void {
    if (!this.client) return;

    this.logger.logSocketTraffic(this.config.socketLogFile, "out", event);
    this.client.send(JSON.stringify(event));

    // Emit for tests and basic TUI
    this.emit("event", event);
  }

  private async sendStateSnapshot(): Promise<void> {
    const totalCost = this.stateManager.getTotalCost();
    const totalTime = this.serverStartTime ? Date.now() - this.serverStartTime.getTime() : 0;

    // Get terminal phases using execution thread
    const terminalPhases = await this.getTerminalPhasesForSnapshot();

    // Get the currently executing phase
    const currentPhase = this.stateManager.getCurrentlyRunningPhase();

    this.sendEvent({
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "state.snapshot",
      data: {
        currentPhase,
        completedPhases: terminalPhases,
        fileTree: [],
        totalCost,
        totalTime,
        recentFileAccess: this.recentFileAccess,
        isRollingBack: this.isRollingBack,
      },
    } as StateSnapshotEvent);
  }

  // Get terminal phases for snapshot - returns all terminal phases (completed, failed, skipped)
  private async getTerminalPhasesForSnapshot(): Promise<PhaseExecution[]> {
    const thread = await this.stateManager.getExecutionThread();

    // Filter for terminal phases and extract just the phase execution objects
    return thread.phases
      .filter((threadPhase) => isTerminalPhaseStatus(threadPhase.phase.status))
      .map((threadPhase) => threadPhase.phase);
  }

  /**
   * Start a new run and create necessary infrastructure
   */
  private async startNewRun(
    startingConditions?: import("./types/state-types.js").StartingConditions,
  ): Promise<void> {
    const runId = RunId(`${Date.now()}-${Math.random().toString(36).substring(2, 7)}`);
    const runFolder = path.join(this.config.executionPath, ".tadpole", "runs", runId);

    // Create run folder
    await fs.promises.mkdir(runFolder, { recursive: true });

    // Create run in state
    this.stateManager.transition({
      type: "RunStarted",
      data: {
        runId,
        runFolder,
        gitBranch: `run-${runId}`,
        startingConditions: startingConditions || { type: "fresh" },
        serverPid: process.pid,
      },
    });

    this.currentRunId = runId;

    // Update lock file with runId and heartbeat
    interface LockFile {
      pid: number;
      runId: string;
      startTime: string;
      lastHeartbeat: string;
    }

    const lockData: LockFile = {
      pid: process.pid,
      runId,
      startTime: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
    };

    const lockDir = path.dirname(this.config.lockFile);
    if (!fs.existsSync(lockDir)) {
      fs.mkdirSync(lockDir, { recursive: true });
    }
    fs.writeFileSync(this.config.lockFile, JSON.stringify(lockData));

    // Start heartbeat
    this.heartbeatInterval = setInterval(() => {
      this.updateHeartbeat();
    }, 30000); // Every 30 seconds

    this.logger.log(`Started new run: ${runId}`);
  }

  /**
   * Update heartbeat in lock file
   */
  private updateHeartbeat(): void {
    try {
      if (fs.existsSync(this.config.lockFile)) {
        const lock = JSON.parse(fs.readFileSync(this.config.lockFile, "utf-8"));
        lock.lastHeartbeat = new Date().toISOString();
        fs.writeFileSync(this.config.lockFile, JSON.stringify(lock));
      }
    } catch (error) {
      this.logger.log(`Failed to update heartbeat: ${error}`, "error");
    }
  }

  // -------------
  // Phase Execution & Management
  // -------------

  /**
   * Start execution of a specific phase.
   *
   * @param phaseId - ID of the phase to start
   * @param skipPreCommands - Skip pre-start commands (useful for retries)
   *
   * Process:
   * 1. Validate phase exists and no phase is currently running
   * 2. Run pre-start command if specified
   * 3. Get previous session ID if continuing
   * 4. Initialize phase state
   * 5. Start file watching if configured
   * 6. Send phase.started event
   * 7. Spawn Claude process with prompt
   */
  private async startPhase(phaseId: PhaseId, skipPreCommands?: boolean): Promise<void> {
    const phase = this.config.phases.find((p) => p.id === phaseId);
    if (!phase) {
      await this.handleError(
        new Error(`Unknown phase: ${phaseId}`),
        "startPhase",
        ErrorSeverity.OPERATION,
      );
      return;
    }

    this.logger.log(`Starting phase: ${phase.name}`);

    // Check if phase already running via state manager (single source of truth)
    const currentPhase = this.stateManager.getCurrentlyRunningPhase();
    if (currentPhase && !isTerminalPhaseStatus(currentPhase.status)) {
      await this.handleError(
        new Error(`Phase already running: ${currentPhase.phaseId}`),
        "startPhase",
        ErrorSeverity.OPERATION,
      );
      return;
    }

    // Check if this phase was already attempted in current run
    const currentRun = this.stateManager.getCurrentRun();
    if (currentRun) {
      const previousAttempt = currentRun.phases.find((p) => p.phaseId === phaseId);
      if (previousAttempt && isTerminalPhaseStatus(previousAttempt.status)) {
        // Phase was already attempted and finished - start new run
        this.logger.log(`Phase ${phaseId} was already attempted in current run, starting new run`);

        // Complete current run
        this.stateManager.transition({
          type: "RunCompleted",
          data: { runId: currentRun.runId },
        });

        await this.stateManager.waitForPendingTransitions();

        // Start new run
        await this.startNewRun({
          type: "continuation",
          source: {
            runId: currentRun.runId,
            afterPhase: null, // Start from beginning of this phase
            checkpointSha: "", // Will use current state
          },
          reason: "retry", // Use 'retry' for phase restart
        });
      }
    }

    // Create phase started transition (fire-and-forget)

    if (!this.currentRunId) {
      await this.handleError(new Error("No active run"), "startPhase", ErrorSeverity.FATAL);
      return;
    }

    this.stateManager.transition({
      type: "PhaseStarted",
      data: {
        runId: this.currentRunId,
        phaseId: phase.id,
      },
    });

    // Always transition from preparing to starting
    if (!this.currentRunId) {
      await this.handleError(
        new Error("No active run during phase start"),
        "startPhase",
        ErrorSeverity.FATAL,
      );
      return;
    }

    // Run workspace setup operations if configured
    if (!skipPreCommands && phase.workspaceSetup) {
      this.logger.log(`Running workspace setup for phase: ${phase.name}`);
      let lastCopiedPath: string | null = null;

      for (const [index, item] of phase.workspaceSetup.entries()) {
        try {
          if (item.type === "copy" && item.copy) {
            const targetPath = path.join(this.config.executionPath, item.copy.to);
            await this.copyPath(item.copy.from, targetPath);
            lastCopiedPath = targetPath;
            this.logger.log(`Copied ${item.copy.from} to ${targetPath}`);
          } else if (item.type === "command" && item.command) {
            const workingDir =
              item.command.workingDirectory === "lastCopied" && lastCopiedPath
                ? lastCopiedPath
                : this.config.executionPath;
            await this.runCommand(item.command.run, workingDir);
            this.logger.log(`Ran command in ${workingDir}: ${item.command.run}`);
          }
        } catch (error) {
          const errorMessage = toError(error).message;
          this.logger.log(`Workspace setup failed at item ${index + 1}: ${errorMessage}`, "error");

          // Set failure reason with detailed information
          this.phaseFailureReason = {
            type: "unknown",
            retriable: true,
            message: `Workspace setup failed at ${item.type} operation: ${errorMessage}`,
          };

          // Transition phase to failed state
          if (this.currentRunId) {
            this.stateManager.transition({
              type: "PhaseTransitioned",
              data: {
                runId: this.currentRunId,
                phaseId: phase.id,
                from: "preparing",
                to: "failed",
                metadata: {
                  failedDuring: "preparing",
                  failureReason: this.phaseFailureReason,
                },
              },
            });
          }

          // Send error event with details
          this.sendEvent({
            id: EventId(generateId()),
            timestamp: new Date().toISOString(),
            type: "error",
            data: {
              message: `Workspace setup failed: ${errorMessage}`,
              context: `Phase ${phase.id} - ${item.type} operation (item ${index + 1})`,
              phase: phase.id,
              fatal: true,
              severity: ErrorSeverity.FATAL,
            },
          } as ErrorEvent);

          // Clean up and handle error
          this.cleanupCurrentPhase();
          await this.handleError(
            toError(error),
            `Workspace setup item ${index + 1}`,
            ErrorSeverity.FATAL,
          );
          return;
        }
      }
    }

    // Transition to starting after preparing (regardless of workspace setup)
    this.stateManager.transition({
      type: "PhaseTransitioned",
      data: {
        runId: this.currentRunId,
        phaseId: phase.id,
        from: "preparing",
        to: "starting",
      },
    });

    // Add checkpoint patterns - accumulate from all phases up to current
    // This ensures resume functionality works correctly
    const currentPhaseIndex = this.config.phases.findIndex((p) => p.id === phase.id);
    if (currentPhaseIndex >= 0) {
      // Accumulate patterns from all phases up to and including current
      for (let i = 0; i <= currentPhaseIndex; i++) {
        const phaseConfig = this.config.phases[i];
        if (phaseConfig.trackedFiles && phaseConfig.trackedFiles.length > 0) {
          await this.addCheckpointPatterns(phaseConfig.trackedFiles);
        }
      }

      // Create checkpoint after workspace setup if we have workspace setup
      if (!skipPreCommands && phase.workspaceSetup && this.checkpointingEnabled) {
        await this.createCheckpoint({
          status: "workspace-setup",
          phaseId: phase.id,
          phaseName: phase.name,
          runId: this.currentRunId || RunId("unknown"),
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Get previous session ID if needed
    let previousSessionId: string | null = null;

    if (phase.continuationMode === "continue-previous") {
      // Build execution thread to find continuation session
      const state = this.stateManager.getState();
      const thread = await analyzeExecutionThread(
        state,
        this.config.phases,
        undefined, // No checkpoint data needed for session lookup
        undefined, // Use latest run
        this.logger,
      );

      const sessionId = findContinuationSessionId(thread, phase.id, this.config.phases);
      previousSessionId = sessionId;

      if (previousSessionId) {
        this.logger.log(
          `Phase ${phase.id} will continue from previous session: ${previousSessionId}`,
        );

        // Send info event about continuation
        this.sendEvent({
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "info",
          data: {
            message: `Continuing from previous session: ${previousSessionId}`,
          },
        } as InfoEvent);
      } else {
        // Phase requires continuation but no valid session found - this is an error
        const errorMessage = `Phase ${phase.id} requires continuation from previous phase but no valid session found. Previous phase must complete successfully or be skipped with at least one assistant message.`;

        this.logger.log(errorMessage, "error");

        // Set failure reason
        this.phaseFailureReason = {
          type: "unknown",
          retriable: false,
          message: errorMessage,
        };

        // Transition to failed state
        if (this.currentRunId) {
          this.stateManager.transition({
            type: "PhaseTransitioned",
            data: {
              runId: this.currentRunId,
              phaseId: phase.id,
              from: "starting",
              to: "failed",
              metadata: {
                failedDuring: "starting",
                failureReason: this.phaseFailureReason,
              },
            },
          });
        }

        // Send error event
        this.sendEvent({
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "error",
          data: {
            message: errorMessage,
            phase: phase.id,
            fatal: true,
            severity: ErrorSeverity.PHASE,
          },
        } as ErrorEvent);

        // Clean up and return
        this.cleanupCurrentPhase();
        return;
      }
    }

    // Create phase state - start in initializing state
    this.currentPhase = {
      status: "initializing",
      phase,
      previousSessionId: previousSessionId ? SessionId(previousSessionId) : undefined, // Store for phase.started event
      startTime: new Date(),
      phaseCost: 0,
      phaseTokens: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    };

    // Store watch patterns for tool-based tracking
    if (phase.trackedFiles && phase.trackedFiles.length > 0) {
      this.watchedPatterns = phase.trackedFiles;
      this.logger.log(`Watching patterns: ${this.watchedPatterns.join(", ")}`);
    }

    // NOTE: phase.started event is now sent when Claude sends init message
    // This ensures we have the actual session ID before notifying clients

    // Send initial file states if any exist
    if (phase.trackedFiles && phase.trackedFiles.length > 0) {
      // Use the unified file resolver to get files respecting gitignore
      const resolvedFiles = await fileResolver.resolveFiles(
        this.config.executionPath,
        phase.trackedFiles,
      );

      // Get file contents for each resolved file
      const files = await Promise.all(
        resolvedFiles.map(async (filePath) => {
          const fullPath = path.join(this.config.executionPath, filePath);
          const stats = await fs.promises.stat(fullPath);
          const content = await fs.promises.readFile(fullPath, "utf-8");
          return {
            path: filePath,
            content,
            lastModified: stats.mtime.toISOString(),
          };
        }),
      );

      // Only send events if we have files
      if (files.length > 0) {
        for (const file of files) {
          this.sendEvent({
            id: EventId(generateId()),
            timestamp: new Date().toISOString(),
            type: "file.updated",
            data: {
              path: file.path,
              filename: path.basename(file.path),
              content: file.content,
              action: "created",
            },
          } as FileUpdatedEvent);
        }

        // Store most recent file
        const mostRecent = files.reduce((latest, file) =>
          new Date(file.lastModified) > new Date(latest.lastModified) ? file : latest,
        );
        this.recentFileAccess = {
          path: mostRecent.path,
          content: mostRecent.content,
          timestamp: new Date(mostRecent.lastModified),
        };

        // Send file tree update
        await this.sendFileTreeUpdate();
      }
    }

    // Start Claude process
    await this.startClaudeProcess(phase, previousSessionId);
  }

  // -------------
  // Claude Process Management
  // -------------

  /**
   * Spawn Claude CLI process for a phase using ClaudeProcessManager.
   *
   * @param phase - Phase configuration
   * @param previousSessionId - Session to continue from (if any)
   */
  private async startClaudeProcess(
    phase: PhaseConfig,
    previousSessionId: string | null,
  ): Promise<void> {
    try {
      // Get run folder from state
      const currentRun = this.stateManager.getCurrentRun();
      if (!currentRun || !currentRun.runFolder) {
        throw new Error("No active run or run folder not found");
      }
      const runFolder = currentRun.runFolder;

      // Ensure run folder exists
      await fs.promises.mkdir(runFolder, { recursive: true });

      // Modify log path to use run folder
      const logPath = path.join(runFolder, `${phase.id}-claude.log`);

      // Create log parser first
      this.logParser = new ClaudeLogParser({
        logPath,
        phaseId: phase.id,
        parsingInterval: this.config.logParsingInterval,
        onSystemMessage: (msg) => this.handleSystemMessage(msg, phase.id),
        onAssistantMessage: (msg) => this.handleAssistantMessage(msg, phase.id),
        onUserMessage: (msg) => this.handleUserMessage(msg, phase.id),
        onResultMessage: (msg) => this.handleResultMessage(msg, phase.id),
      });

      // Create process manager with the log parser
      this.processManager = new ClaudeProcessManager(
        this.config.executionPath,
        this.logger,
        this.logParser,
        this.config.anthropicBaseURL,
        this.config.modelOverride,
      );

      // Set up event handlers
      this.processManager.on("exit", (code: number) => {
        this.handlePhaseComplete(code);
      });

      this.processManager.on("error", (error: Error) => {
        this.handleError(error, `Claude process for phase ${phase.id}`, ErrorSeverity.FATAL);
      });

      // Spawn process with custom log path
      const _logPathResult = await this.processManager.spawn(phase, previousSessionId, logPath);

      // Transition to initializing (fire-and-forget)
      if (!this.currentRunId) {
        throw new Error("No active run while starting Claude process");
      }

      const pid = this.processManager.getPid();
      if (!pid) {
        throw new Error("Failed to get Claude process PID");
      }

      // Get the phase from current state to check for previousSessionId
      const _currentPhase = this.currentPhase;

      this.stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId: this.currentRunId,
          phaseId: phase.id,
          from: "starting",
          to: "initializing",
          metadata: {
            claudePid: pid,
            claudeLogPath: path.relative(this.config.executionPath, logPath),
            ...(previousSessionId && {
              previousSessionId: SessionId(previousSessionId),
            }),
          },
        },
      });

      // Start log parsing with delay
      setTimeout(() => {
        this.logParser?.start();
      }, TIMEOUTS.LOG_PARSER_DELAY_MS);
    } catch (error) {
      // Transition to failed (fire-and-forget) if we have a run
      if (this.currentRunId) {
        this.stateManager.transition({
          type: "PhaseTransitioned",
          data: {
            runId: this.currentRunId,
            phaseId: phase.id,
            from: "starting",
            to: "failed",
            metadata: {
              failedDuring: "starting",
              failureReason: {
                type: "unknown",
                retriable: false,
                message: toError(error).message,
              },
            },
          },
        });
      }
      this.cleanupCurrentPhase();
      throw error;
    }
  }

  private handleSystemMessage(msg: SystemMessage, phaseId: string): void {
    if (
      msg.subtype === "init" &&
      msg.session_id &&
      this.currentPhase &&
      this.currentPhase.status === "initializing"
    ) {
      // Transition to running (fire-and-forget)
      if (this.currentRunId) {
        this.stateManager.transition({
          type: "PhaseTransitioned",
          data: {
            runId: this.currentRunId,
            phaseId: PhaseId(phaseId),
            from: "initializing",
            to: "running",
            metadata: {
              claudeSessionId: SessionId(msg.session_id),
            },
          },
        });
      }

      // Update local state for backward compatibility
      this.currentPhase = {
        status: "running",
        phase: this.currentPhase.phase,
        sessionId: SessionId(msg.session_id),
        previousSessionId: this.currentPhase.previousSessionId,
        startTime: this.currentPhase.startTime,
        phaseCost: 0,
        phaseTokens: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
      };

      // Log the session ID update
      this.logger.log(`Claude started phase ${phaseId} with session ID: ${msg.session_id}`);

      // Send existing info event
      this.sendEvent({
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "info",
        data: {
          message: `Claude started with session ID: ${msg.session_id}`,
        },
      } as InfoEvent);
    }
  }

  private handleAssistantMessage(msg: AssistantMessage, phaseId: string): void {
    // Track that we've received an assistant message
    if (this.currentRunId) {
      const currentPhase = this.stateManager.getPhaseInCurrentRun(PhaseId(phaseId));
      const currentCount =
        currentPhase && "assistantMessageCount" in currentPhase
          ? (currentPhase.assistantMessageCount ?? 0)
          : 0;

      this.stateManager.transition({
        type: "AssistantMessageCountUpdated",
        data: {
          runId: this.currentRunId,
          phaseId: PhaseId(phaseId),
          newCount: currentCount + 1,
        },
      });
    }

    // Use type guard to check for synthetic timeout messages
    if (isSyntheticTimeout(msg as ClaudeLogMessage)) {
      this.logger.log(`API timeout detected in synthetic message for phase ${phaseId}`, "error");

      const timeoutError = new APITimeoutError(phaseId, {
        message: "API Error: Request timed out.",
        timestamp: new Date().toISOString(),
        synthetic: true,
      });

      // Set failure reason
      this.phaseFailureReason = {
        type: "timeout",
        retriable: true,
        message: "API Error: Request timed out.",
      };

      // Send error event
      this.sendEvent({
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "error",
        data: {
          message: timeoutError.message,
          phase: phaseId,
          fatal: false,
          severity: timeoutError.severity,
          context: JSON.stringify(timeoutError.context),
        },
      } as ErrorEvent);

      // Process manager will handle the cleanup
      if (this.processManager) {
        this.processManager.kill();
      }

      return; // Stop processing
    }

    if (msg.message.usage) {
      const usageDelta: TokenUsage = {
        inputTokens: msg.message.usage.input_tokens || 0,
        outputTokens: msg.message.usage.output_tokens || 0,
        cacheCreationTokens: msg.message.usage.cache_creation_input_tokens || 0,
        cacheReadTokens: msg.message.usage.cache_read_input_tokens || 0,
      };

      const costDelta = calculateCost(usageDelta, this.config.costsPerMTok);

      // This part is fine, it updates the transient in-memory state for now
      if (this.currentPhase && this.currentPhase.status === "running") {
        this.currentPhase.phaseCost += costDelta;
        this.currentPhase.phaseTokens.inputTokens += usageDelta.inputTokens;
        this.currentPhase.phaseTokens.outputTokens += usageDelta.outputTokens;
        this.currentPhase.phaseTokens.cacheCreationTokens += usageDelta.cacheCreationTokens;
        this.currentPhase.phaseTokens.cacheReadTokens += usageDelta.cacheReadTokens;
      }

      // Fire cost INCREMENT transition (fire-and-forget)
      if (this.currentRunId) {
        // Instead of calculating a new total from state, we just send the delta.
        this.stateManager.transition({
          type: "CostsIncremented", // Use the new incremental type
          data: {
            runId: this.currentRunId,
            phaseId: PhaseId(phaseId),
            costDelta: costDelta, // Send the delta
            tokensDelta: usageDelta, // Send the delta
          },
        });
      }

      this.logger.log(
        `Phase ${phaseId} token update - Call cost: $${costDelta.toFixed(
          4,
        )}, Running total: $${this.currentPhase?.phaseCost.toFixed(4) || 0} ` +
          `(${usageDelta.inputTokens} in, ${usageDelta.outputTokens} out, ` +
          `${usageDelta.cacheCreationTokens} cache create, ${usageDelta.cacheReadTokens} cache read)`,
      );

      // Send token.usage event with the delta cost
      this.sendEvent({
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "token.usage",
        data: {
          phaseId,
          ...usageDelta,
          totalCost: costDelta, // This event should report the delta cost
        },
      } as TokenUsageEvent);
    }

    const content = msg.message.content;
    const contentArray = Array.isArray(content)
      ? content
      : [{ type: "text" as const, text: content }];

    for (const item of contentArray) {
      if ("text" in item && item.type === "text") {
        const textItem = item as TextContent;

        // Check for API timeout error
        if (textItem.text === "API Error: Request timed out.") {
          this.logger.log(`API timeout detected in phase ${phaseId}`, "error");

          // Immediately handle the timeout error
          const timeoutError = new APITimeoutError(phaseId, {
            message: textItem.text,
            timestamp: new Date().toISOString(),
          });

          // Set failure reason
          this.phaseFailureReason = {
            type: "timeout",
            retriable: true,
            message: "API Error: Request timed out.",
          };

          // Send error event
          this.sendEvent({
            id: EventId(generateId()),
            timestamp: new Date().toISOString(),
            type: "error",
            data: {
              message: timeoutError.message,
              phase: phaseId,
              fatal: false,
              severity: timeoutError.severity,
              context: JSON.stringify(timeoutError.context),
            },
          } as ErrorEvent);

          // Process manager will handle the cleanup
          if (this.processManager) {
            this.processManager.kill();
          }

          return; // Stop processing further messages
        }

        this.sendEvent({
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "assistant.action",
          data: {
            phaseId,
            action: "message",
            content: textItem.text,
          },
        } as AssistantActionEvent);
      } else if ("thinking" in item && item.type === "thinking") {
        const thinkingItem = item as ThinkingContent;
        this.sendEvent({
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "assistant.action",
          data: {
            phaseId,
            action: "thinking",
            content: thinkingItem.thinking,
          },
        } as AssistantActionEvent);
      } else if (item.type === "tool_use") {
        const toolItem = item as ToolUseContent;

        // Track this tool use for result matching
        this.pendingToolUses.set(toolItem.id, {
          toolName: toolItem.name,
          timestamp: Date.now(),
          phaseId,
        });

        // Handle file-related tool calls
        const fileTools: ToolName[] = ["Read", "Write", "Edit", "MultiEdit"];
        if (fileTools.includes(toolItem.name as ToolName)) {
          // Call async function without awaiting to avoid blocking
          this.handleFileToolCall(toolItem.name as ToolName, toolItem.input).catch((err) => {
            this.handleError(
              toError(err),
              `handleFileToolCall(${toolItem.name})`,
              ErrorSeverity.OPERATION,
            );
          });
        }

        // Send event for all tools, including unknown ones
        // toolName is typed as string to allow unknown tools
        this.sendEvent({
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "assistant.action",
          data: {
            phaseId,
            action: "tool_use",
            content: "",
            toolName: toolItem.name,
            toolInput: toolItem.input,
          },
        } as AssistantActionEvent);
      }
    }
  }

  private handleResultMessage(msg: ResultMessage, phaseId: string): void {
    this.logger.log(`Phase ${phaseId} result message received: ${msg.subtype}`);

    // Mark that we received a result message
    this.resultMessageReceived = true;

    // Check for API timeout in result (can be error subtype OR success with is_error=true)
    if (msg.result === "API Error: Request timed out." && msg.is_error) {
      this.logger.log(`API timeout detected in result message for phase ${phaseId}`, "error");

      const timeoutError = new APITimeoutError(phaseId, {
        message: msg.result,
        timestamp: new Date().toISOString(),
        is_error: msg.is_error,
        duration_ms: msg.duration_ms,
        duration_api_ms: msg.duration_api_ms,
      });

      // Set failure reason
      this.phaseFailureReason = {
        type: "timeout",
        retriable: true,
        message: "API Error: Request timed out.",
      };

      // Send error event
      this.sendEvent({
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "error",
        data: {
          message: timeoutError.message,
          phase: phaseId,
          fatal: false,
          severity: timeoutError.severity,
          context: JSON.stringify(timeoutError.context),
        },
      } as ErrorEvent);
    }

    if (msg.subtype === "success") {
      this.logger.log(`Phase ${phaseId} completed successfully`);

      // Update final token usage and cost from result message
      if (msg.usage && this.currentRunId) {
        const finalUsage: TokenUsage = {
          inputTokens: msg.usage.input_tokens || 0,
          outputTokens: msg.usage.output_tokens || 0,
          cacheCreationTokens: msg.usage.cache_creation_input_tokens || 0,
          cacheReadTokens: msg.usage.cache_read_input_tokens || 0,
        };

        const finalCost = msg.total_cost_usd || calculateCost(finalUsage, this.config.costsPerMTok);

        const accumulatedCost = this.currentPhase?.phaseCost || 0; // Still useful for logging
        if (Math.abs(accumulatedCost - finalCost) > 0.0001) {
          this.logger.log(
            `Phase ${phaseId} cost discrepancy - Accumulated: $${accumulatedCost.toFixed(4)}, ` +
              `Final: $${finalCost.toFixed(4)} (using final from result message)`,
          );
        }

        // Fire a state transition with the authoritative final cost.
        this.stateManager.transition({
          type: "PhaseFinalCostSet",
          data: {
            runId: this.currentRunId,
            phaseId: PhaseId(phaseId),
            finalCost: finalCost,
            finalTokens: finalUsage,
          },
        });

        // Send a final token usage event with the correct values
        this.sendEvent({
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "token.usage",
          data: {
            phaseId,
            ...finalUsage,
            totalCost: finalCost,
          },
        } as TokenUsageEvent);
      }
    }
  }

  private handleUserMessage(msg: UserMessage, _phaseId: string): void {
    // Process tool results from user messages
    const content = msg.message.content;
    const contentArray = Array.isArray(content) ? content : [];

    for (const item of contentArray) {
      if (item.type === "tool_result") {
        const toolResult = item as ToolResultContent;

        // Find the corresponding tool use
        const toolUse = this.pendingToolUses.get(toolResult.tool_use_id);
        if (!toolUse) {
          this.logger.log(
            `Tool result without matching tool use: ${toolResult.tool_use_id}`,
            "info",
          );
          continue;
        }

        // Calculate execution time
        const executionTimeMs = Date.now() - toolUse.timestamp;

        // Extract result content
        let resultText = "";
        let isError = false;

        if (typeof toolResult.content === "string") {
          resultText = toolResult.content;
        } else if (Array.isArray(toolResult.content)) {
          resultText = toolResult.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");
        } else if (toolResult.content && typeof toolResult.content === "object") {
          // Check if it's an error result
          if ("is_error" in toolResult.content) {
            isError = toolResult.content.is_error === true;
          }
          resultText = JSON.stringify(toolResult.content, null, 2);
        }

        // Truncate result based on configuration
        const originalLength = resultText.length;
        const truncateLength = this.config.toolResultTruncateLength;
        const truncated = resultText.length > truncateLength;
        if (truncated) {
          resultText = `${resultText.substring(0, truncateLength)}...`;
        }

        // Send tool result event
        this.sendEvent({
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "tool.result",
          data: {
            phaseId: toolUse.phaseId,
            toolUseId: toolResult.tool_use_id,
            toolName: toolUse.toolName,
            result: resultText,
            truncated,
            originalLength,
            executionTimeMs,
            isError,
          },
        } as import("./types/types.js").ToolResultEvent);

        // Clean up tracked tool use
        this.pendingToolUses.delete(toolResult.tool_use_id);
      }
    }
  }

  private async handlePhaseComplete(exitCode: number): Promise<void> {
    // Get the current phase from the in-memory state first
    if (!this.currentPhase) return;

    const phaseId = this.currentPhase.phase.id;
    const wasSkipped = this.isSkippingPhase;

    // Now get the phase from state manager to ensure we have the latest status
    const currentPhase = this.stateManager.getPhaseInCurrentRun(PhaseId(phaseId));
    if (!currentPhase || isTerminalPhaseStatus(currentPhase.status)) return;

    // Get current status before any transitions
    const currentStatus = currentPhase.status;

    // Wait for 2x the log parsing interval to ensure log parser catches up with final messages
    await new Promise((resolve) => setTimeout(resolve, this.config.logParsingInterval * 2));

    // Re-fetch the specific phase after potential transition to completing
    const updatedPhase = this.stateManager.getPhaseInCurrentRun(PhaseId(phaseId));
    if (!updatedPhase) return;

    // Determine final status based on the actual phase outcome
    // Priority order: force stop > result message > skip request > exit code
    let finalStatus: PhaseStatus;
    if (this.isForceStopping) {
      finalStatus = "failed";
    } else if (exitCode === 0 && this.resultMessageReceived) {
      finalStatus = "completed"; // Result message with exit 0 = completed
    } else if (wasSkipped && !this.resultMessageReceived) {
      finalStatus = "skipped"; // Skip requested AND no result = skipped
    } else if (exitCode !== 0) {
      finalStatus = "failed"; // Non-zero exit = failed
    } else {
      // Exit 0 but no result message and not skipped = failed
      finalStatus = "failed";
    }

    // Create checkpoint BEFORE state transition
    let checkpointSha: string | undefined;
    if (this.checkpointingEnabled) {
      try {
        const checkpointType =
          finalStatus === "completed"
            ? "completed"
            : finalStatus === "skipped"
              ? "skipped"
              : "error";

        const commitInfo = await this.createCheckpoint({
          status: checkpointType,
          phaseId: phaseId,
          phaseName: this.currentPhase?.phase.name || phaseId,
          runId: this.currentRunId || RunId("unknown"),
          timestamp: new Date().toISOString(),
          duration: Date.now() - new Date(currentPhase.startTime).getTime(),
        });

        checkpointSha = commitInfo || undefined;
      } catch (error) {
        this.logger.log(`Checkpoint creation failed: ${error}`, "error");
        // Decide: fail the phase or continue without checkpoint?
        if (finalStatus === "completed") {
          // For completed phases, checkpoint failure is critical
          finalStatus = "failed";
          this.phaseFailureReason = {
            type: "unknown",
            retriable: false,
            message: `Checkpoint creation failed: ${toError(error).message}`,
          };
        }
      }
    }

    // Final transition (fire-and-forget)
    if (this.currentRunId) {
      this.stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId: this.currentRunId,
          phaseId,
          from: updatedPhase.status, // Use the updated status (might be "completing" now)
          to: finalStatus,
          metadata: {
            exitCode,
            resultMessageReceived: this.resultMessageReceived,
            checkpointSha: checkpointSha || "", // Ensure we always have a string
            ...(finalStatus === "failed" && {
              failedDuring: wasSkipped ? currentStatus : updatedPhase.status,
              failureReason: this.phaseFailureReason || {
                type: "unknown",
                retriable: false,
              },
            }),
            ...(finalStatus === "skipped" && {
              skippedDuring: currentStatus, // Use original status for skip
            }),
          },
        },
      });
    }

    // Wait for this critical state transition to complete before cleanup
    await this.stateManager.waitForPendingTransitions();

    // Get the final persisted state for the phase
    const finalPhaseState = this.stateManager.getPhaseInCurrentRun(PhaseId(phaseId));

    // Authoritatively get the cost from the final state object
    let finalCost = 0;
    if (finalPhaseState) {
      if (finalPhaseState.status === "completed") {
        finalCost = finalPhaseState.finalCost;
      } else if (finalPhaseState.status === "failed" || finalPhaseState.status === "skipped") {
        finalCost = finalPhaseState.partialCost;
      }
    }

    // The design decision to report 0 for skipped phases is handled here
    const reportedCost = finalStatus === "skipped" ? 0 : finalCost;

    this.sendEvent({
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "phase.completed",
      data: {
        phaseId,
        success: finalStatus === "completed",
        cost: reportedCost, // Use the authoritative, persisted cost
        duration: Date.now() - new Date(currentPhase.startTime).getTime(),
        exitStatus:
          finalStatus === "skipped"
            ? { type: "error", code: exitCode }
            : exitCode === 0
              ? { type: "success" }
              : { type: "error", code: exitCode },
        failureReason: finalStatus === "failed" ? this.phaseFailureReason : undefined,
      },
    } as PhaseCompletedEvent);

    // Send state snapshot
    await this.sendStateSnapshot();

    // Clean up - now happens after state is persisted
    this.cleanupCurrentPhase();

    // Handle next steps
    if ((finalStatus === "completed" || finalStatus === "skipped") && !this.isShuttingDown) {
      if (this.config.autostart) {
        await this.autoStartNextPhase();
      } else {
        // Emit idle event
        this.sendEvent({
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "server.idle",
          data: {
            reason: "phase-completed",
            message: `Phase ${phaseId} ${finalStatus}. Use 'phase.next' to continue.`,
          },
        } as import("./types/types.js").ServerIdleEvent);
      }
    } else if (finalStatus === "failed" && !this.isShuttingDown) {
      if (this.phaseFailureReason?.retriable) {
        this.logger.log(`Phase failed with retriable error. Server remains active.`);
      } else {
        // Non-retriable failure - shut down run
        if (this.currentRunId) {
          this.stateManager.transition({
            type: "RunFailed",
            data: { runId: this.currentRunId },
          });
          // Wait for this transition too
          await this.stateManager.waitForPendingTransitions();
        }
        await this.shutdown("phase failure");
      }
    }
  }

  // -------------
  // File Operations & Watching
  // -------------

  private async handleFileToolCall<T extends ToolName>(
    toolName: T,
    toolInput: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (this.watchedPatterns.length === 0) return;

    let filePath: string | null = null;
    let action: "created" | "modified" | "deleted" = "modified";
    let content = "";

    // Type-safe tool input handling
    switch (toolName) {
      case "Read": {
        const input = toolInput as ToolInputMap["Read"] | undefined;
        filePath = input?.file_path || null;
        action = "modified"; // Read doesn't change the file
        break;
      }
      case "Write": {
        const input = toolInput as ToolInputMap["Write"] | undefined;
        filePath = input?.file_path || null;
        content = input?.content || "";
        if (filePath) {
          action = fs.existsSync(path.join(this.config.executionPath, filePath))
            ? "modified"
            : "created";
        }
        break;
      }
      case "Edit": {
        const input = toolInput as ToolInputMap["Edit"] | undefined;
        filePath = input?.file_path || null;
        action = "modified";
        break;
      }
      case "MultiEdit": {
        const input = toolInput as ToolInputMap["MultiEdit"] | undefined;
        filePath = input?.file_path || null;
        action = "modified";
        break;
      }
    }

    if (!filePath) return;

    // Make path relative if it's absolute
    if (path.isAbsolute(filePath)) {
      filePath = path.relative(this.config.executionPath, filePath);
    }

    // Check if file matches any watch pattern
    const normalizedPath = filePath.replace(/^\.\//g, "");
    const matchesPattern = this.watchedPatterns.some((pattern) => {
      const normalizedPattern = pattern.replace(/^\.\//g, "");
      return minimatch(normalizedPath, normalizedPattern, { matchBase: true });
    });

    if (!matchesPattern) {
      return;
    }

    // Read current file content if not provided
    if (!content) {
      const fullPath = path.join(this.config.executionPath, filePath);
      if (fs.existsSync(fullPath)) {
        try {
          content = fs.readFileSync(fullPath, "utf-8");
        } catch (error) {
          this.logger.log(`Error reading file ${filePath}: ${toError(error).message}`, "error");
          return;
        }
      }
    }

    // Store recent file access
    this.recentFileAccess = {
      path: filePath,
      content,
      timestamp: new Date(),
    };

    // Send file update event
    this.sendEvent({
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "file.updated",
      data: {
        path: filePath,
        filename: path.basename(filePath),
        content,
        action,
      },
    } as FileUpdatedEvent);

    // Send file tree update
    await this.sendFileTreeUpdate();
  }

  private async sendFileTreeUpdate(): Promise<void> {
    if (this.watchedPatterns.length === 0) return;

    // Build file tree for all watched patterns
    const allTrees = await Promise.all(
      this.watchedPatterns.map((pattern) => buildFileTree(this.config.executionPath, pattern)),
    );

    // Merge all trees into one
    const mergedTree = allTrees.flat();

    this.sendEvent({
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "filetree.updated",
      data: { tree: mergedTree },
    } as FileTreeUpdatedEvent);
  }

  // -------------
  // Error Handling
  // -------------

  /**
   * Handle errors with appropriate severity and client notification.
   */
  private async handleError(
    error: Error,
    context: string,
    severity: ErrorSeverity = ErrorSeverity.OPERATION,
  ): Promise<void> {
    // Always log
    this.logger.log(
      `[${severity}] ${context}: ${error.message}`,
      severity === ErrorSeverity.FATAL ? "error" : "info",
    );

    // Always send to client
    this.sendEvent({
      id: EventId(generateId()),
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
        this.cleanupCurrentPhase();
        break;
      // OPERATION and WARNING just log and notify
    }
  }

  // -------------
  // Phase Status & Control
  // -------------

  /**
   * Automatically start the next available phase if none is running.
   * Called on connection and after phase completion.
   */
  private async autoStartNextPhase(): Promise<void> {
    const thread = await this.stateManager.getExecutionThread();

    this.logger.log(
      `[autoStartNextPhase] Called - hasRunningPhase: ${thread.hasRunningPhase}, isShuttingDown: ${this.isShuttingDown}`,
    );

    if (thread.hasRunningPhase || this.isShuttingDown) {
      this.logger.log(`[autoStartNextPhase] Returning early - phase running or shutting down`);
      return; // Phase already running or shutting down
    }

    const nextPhaseId = thread.nextPhaseId;
    this.logger.log(`[autoStartNextPhase] ExecutionThread returned nextPhaseId: ${nextPhaseId}`);

    if (!nextPhaseId) {
      this.logger.log("[autoStartNextPhase] No more phases to run");

      if (this.config.autostart) {
        // Current behavior - shut down
        this.sendEvent({
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "info",
          data: {
            message: "All phases completed successfully. Server shutting down.",
          },
        } as InfoEvent);

        setTimeout(() => {
          this.shutdown("all phases completed");
        }, 2000);
      } else {
        // New behavior - stay running and emit idle
        this.sendEvent({
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "server.idle",
          data: {
            reason: "all-phases-completed",
            message: "All phases completed. Server remains active.",
          },
        } as import("./types/types.js").ServerIdleEvent);
      }
      return;
    }

    this.logger.log(`[autoStartNextPhase] Auto-starting phase: ${nextPhaseId}`);
    await this.startPhase(nextPhaseId);
  }

  private async startNextPhase(): Promise<void> {
    const thread = await this.stateManager.getExecutionThread();

    if (thread.hasRunningPhase) {
      await this.handleError(
        new Error("Cannot start next phase while current phase is running"),
        "startNextPhase",
        ErrorSeverity.OPERATION,
      );
      return;
    }

    const nextPhaseId = thread.nextPhaseId;

    if (nextPhaseId) {
      this.logger.log(`[startNextPhase] Advancing to next phase: ${nextPhaseId}`);
      await this.startPhase(nextPhaseId);
    } else {
      await this.handleError(
        new Error("No more phases to run"),
        "startNextPhase",
        ErrorSeverity.OPERATION,
      );
    }
  }

  private async skipCurrentPhase(): Promise<void> {
    if (!this.currentPhase) {
      await this.handleError(
        new Error("No phase is currently running"),
        "skipCurrentPhase",
        ErrorSeverity.OPERATION,
      );
      return;
    }

    this.logger.log(`Skipping phase ${this.currentPhase.phase.id}`);
    this.isSkippingPhase = true;

    if (this.processManager) {
      await this.processManager.kill("SIGTERM");
    }
  }

  private async redoCurrentPhase(): Promise<void> {
    const thread = await this.stateManager.getExecutionThread();

    if (thread.hasRunningPhase) {
      await this.handleError(
        new Error("Cannot redo while phase is running"),
        "redoCurrentPhase",
        ErrorSeverity.OPERATION,
      );
      return;
    }

    if (thread.phases.length > 0) {
      // Redo the most recently executed phase, whatever its status
      const lastAttemptedPhase = thread.phases[0];
      this.logger.log(`[redoCurrentPhase] Redoing last phase: ${lastAttemptedPhase.phase.phaseId}`);
      await this.startPhase(lastAttemptedPhase.phase.phaseId);
    } else {
      await this.handleError(
        new Error("No phase has been run yet to redo."),
        "redoCurrentPhase",
        ErrorSeverity.OPERATION,
      );
    }
  }

  /**
   * List available checkpoints
   */
  private async listCheckpoints(runId?: string): Promise<void> {
    const targetRun = runId
      ? this.stateManager.getRun(RunId(runId))
      : this.stateManager.getCurrentRun();

    if (!targetRun) {
      this.sendEvent({
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "error",
        data: {
          message: runId ? `Run ${runId} not found` : "No active run",
          fatal: false,
        },
      } as ErrorEvent);
      return;
    }

    const checkpoints: import("./types/types.js").CheckpointQueryInfo[] = [];

    for (const phase of targetRun.phases) {
      const phaseConfig = this.config.phases.find((p) => p.id === phase.phaseId);
      const phaseName = phaseConfig?.name || phase.phaseId;

      // Workspace setup checkpoint
      if ("workspaceSetupCheckpoint" in phase && phase.workspaceSetupCheckpoint) {
        checkpoints.push({
          phaseId: phase.phaseId,
          phaseName,
          checkpointType: "workspace-setup",
          sha: phase.workspaceSetupCheckpoint,
          status: phase.status,
          timestamp: phase.startTime,
        });
      }

      // Completion checkpoint
      if (phase.status === "completed" && phase.completionCheckpoint) {
        checkpoints.push({
          phaseId: phase.phaseId,
          phaseName,
          checkpointType: "completed",
          sha: phase.completionCheckpoint,
          status: phase.status,
          timestamp: phase.endTime,
        });
      }

      // Error checkpoint
      if (phase.status === "failed" && "errorCheckpoint" in phase && phase.errorCheckpoint) {
        checkpoints.push({
          phaseId: phase.phaseId,
          phaseName,
          checkpointType: "error",
          sha: phase.errorCheckpoint,
          status: phase.status,
          timestamp: phase.endTime,
        });
      }

      // Skip checkpoint
      if (phase.status === "skipped" && "skipCheckpoint" in phase && phase.skipCheckpoint) {
        checkpoints.push({
          phaseId: phase.phaseId,
          phaseName,
          checkpointType: "skipped",
          sha: phase.skipCheckpoint,
          status: phase.status,
          timestamp: phase.endTime,
        });
      }
    }

    this.sendEvent({
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "checkpoint.list",
      data: {
        runId: targetRun.runId,
        checkpoints,
        currentBranch: targetRun.gitBranch,
      },
    } as import("./types/types.js").CheckpointListEvent);
  }

  /**
   * Force stop the current running phase
   */
  private async forceStopPhase(reason?: string): Promise<void> {
    const currentPhase = this.stateManager.getCurrentlyRunningPhase();
    if (!currentPhase || isTerminalPhaseStatus(currentPhase.status)) {
      this.sendEvent({
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "error",
        data: {
          message: "No running phase to stop",
          fatal: false,
        },
      } as ErrorEvent);
      return;
    }

    this.logger.log(`Force stopping phase ${currentPhase.phaseId}: ${reason || "user request"}`);

    // Set the force stopping flag
    this.isForceStopping = true;

    // Set failure reason
    this.phaseFailureReason = {
      type: "unknown",
      retriable: true,
      message: `Force stopped: ${reason || "user request"}`,
    };

    // Immediate state transition to failed
    if (this.currentRunId) {
      this.stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId: this.currentRunId,
          phaseId: currentPhase.phaseId,
          from: currentPhase.status,
          to: "failed",
          metadata: {
            exitCode: -1,
            failureReason: this.phaseFailureReason,
            failedDuring: currentPhase.status,
          },
        },
      });
    }

    // Kill the process (if exists)
    if (this.processManager) {
      await this.processManager.kill("SIGTERM");
    }

    // Clean up phase state
    this.cleanupCurrentPhase();

    // Send confirmation
    this.sendEvent({
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "info",
      data: {
        message: `Phase ${currentPhase.phaseId} force stopped`,
      },
    } as InfoEvent);
  }

  /**
   * Rollback to a specific checkpoint SHA (supports partial matching)
   */
  private async rollbackToCheckpoint(sha: string, autoRestart: boolean): Promise<void> {
    // Check if phase is running
    const currentPhase = this.stateManager.getCurrentlyRunningPhase();
    if (currentPhase && !isTerminalPhaseStatus(currentPhase.status)) {
      this.sendEvent({
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "error",
        data: {
          message: "Cannot rollback while phase is running. Use 'phase.forceStop' first.",
          phase: currentPhase.phaseId,
          fatal: false,
        },
      } as ErrorEvent);
      return;
    }

    // Build execution thread to search across all runs
    const thread = await analyzeExecutionThread(
      this.stateManager.getState(),
      this.config.phases,
      undefined, // No checkpoint validation needed for search
      undefined, // Use latest run
      this.logger,
    );

    // Find all matching checkpoints across the thread
    const matches: Array<{
      threadPhase: import("./execution-thread.js").ThreadPhase;
      checkpointType: string;
      fullSha: string;
      phaseIndex: number;
    }> = [];

    thread.phases.forEach((threadPhase, index) => {
      const phase = threadPhase.phase;

      // Check workspace setup checkpoint
      if ("workspaceSetupCheckpoint" in phase && phase.workspaceSetupCheckpoint) {
        if (phase.workspaceSetupCheckpoint.startsWith(sha)) {
          matches.push({
            threadPhase,
            checkpointType: "workspace-setup",
            fullSha: phase.workspaceSetupCheckpoint,
            phaseIndex: index,
          });
        }
      }

      // Check completion checkpoint
      if (phase.status === "completed" && phase.completionCheckpoint) {
        if (phase.completionCheckpoint.startsWith(sha)) {
          matches.push({
            threadPhase,
            checkpointType: "completed",
            fullSha: phase.completionCheckpoint,
            phaseIndex: index,
          });
        }
      }

      // Check error checkpoint
      if (phase.status === "failed" && "errorCheckpoint" in phase && phase.errorCheckpoint) {
        if (phase.errorCheckpoint.startsWith(sha)) {
          matches.push({
            threadPhase,
            checkpointType: "error",
            fullSha: phase.errorCheckpoint,
            phaseIndex: index,
          });
        }
      }

      // Check skip checkpoint
      if (phase.status === "skipped" && "skipCheckpoint" in phase && phase.skipCheckpoint) {
        if (phase.skipCheckpoint.startsWith(sha)) {
          matches.push({
            threadPhase,
            checkpointType: "skipped",
            fullSha: phase.skipCheckpoint,
            phaseIndex: index,
          });
        }
      }
    });

    // Handle matches
    if (matches.length === 0) {
      this.sendEvent({
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "error",
        data: {
          message: `Checkpoint ${sha} not found in execution history`,
          fatal: false,
        },
      } as ErrorEvent);
      return;
    }

    if (matches.length > 1) {
      // Ambiguous SHA - provide helpful error message
      const matchDetails = matches
        .map((m) => {
          const phaseConfig = this.config.phases.find((p) => p.id === m.threadPhase.phase.phaseId);
          const phaseName = phaseConfig?.name || m.threadPhase.phase.phaseId;
          return `  - ${m.fullSha.substring(0, 7)}... (${phaseName} - ${
            m.checkpointType
          }) in run ${m.threadPhase.runId}`;
        })
        .join("\n");

      this.sendEvent({
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "error",
        data: {
          message: `Ambiguous checkpoint SHA '${sha}'. Multiple checkpoints match:\n${matchDetails}\nPlease provide more characters to uniquely identify the checkpoint.`,
          fatal: false,
        },
      } as ErrorEvent);
      return;
    }

    // Single match found - proceed with rollback
    const match = matches[0];
    await this.executeRollback(
      thread,
      match.phaseIndex,
      match.fullSha,
      match.checkpointType,
      autoRestart,
    );
  }

  /**
   * Rollback to a phase + checkpoint type
   */
  private async rollbackToPhase(
    phaseId: PhaseId,
    checkpointType: "start" | "end" | "workspace-setup" | "completed" | "error" | "skipped",
    autoRestart: boolean,
  ): Promise<void> {
    // Check if phase is running
    const currentPhase = this.stateManager.getCurrentlyRunningPhase();
    if (currentPhase && !isTerminalPhaseStatus(currentPhase.status)) {
      this.sendEvent({
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "error",
        data: {
          message: "Cannot rollback while phase is running. Use 'phase.forceStop' first.",
          phase: currentPhase.phaseId,
          fatal: false,
        },
      } as ErrorEvent);
      return;
    }

    // Build execution thread to search across all runs
    const thread = await analyzeExecutionThread(
      this.stateManager.getState(),
      this.config.phases,
      undefined, // No checkpoint validation needed for search
      undefined, // Use latest run
      this.logger,
    );

    // Find the phase in the thread
    let targetThreadPhase: import("./execution-thread.js").ThreadPhase | null = null;
    let targetPhaseIndex = -1;

    for (let i = 0; i < thread.phases.length; i++) {
      if (thread.phases[i].phase.phaseId === phaseId) {
        targetThreadPhase = thread.phases[i];
        targetPhaseIndex = i;
        break;
      }
    }

    if (!targetThreadPhase) {
      this.sendEvent({
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "error",
        data: {
          message: `Phase ${phaseId} not found in execution history`,
          fatal: false,
        },
      } as ErrorEvent);
      return;
    }

    const targetPhase = targetThreadPhase.phase;

    // Resolve checkpoint type aliases
    let actualCheckpointType: "workspace-setup" | "completed" | "error" | "skipped" | undefined;
    let sha: string | null = null;

    if (checkpointType === "start") {
      // Find first checkpoint in phase
      if ("workspaceSetupCheckpoint" in targetPhase && targetPhase.workspaceSetupCheckpoint) {
        sha = targetPhase.workspaceSetupCheckpoint;
        actualCheckpointType = "workspace-setup";
      } else if (targetPhase.status === "completed" && targetPhase.completionCheckpoint) {
        sha = targetPhase.completionCheckpoint;
        actualCheckpointType = "completed";
      } else if (
        targetPhase.status === "failed" &&
        "errorCheckpoint" in targetPhase &&
        targetPhase.errorCheckpoint
      ) {
        sha = targetPhase.errorCheckpoint;
        actualCheckpointType = "error";
      } else if (
        targetPhase.status === "skipped" &&
        "skipCheckpoint" in targetPhase &&
        targetPhase.skipCheckpoint
      ) {
        sha = targetPhase.skipCheckpoint;
        actualCheckpointType = "skipped";
      }
    } else if (checkpointType === "end") {
      // Find last checkpoint in phase based on status
      if (targetPhase.status === "completed" && targetPhase.completionCheckpoint) {
        sha = targetPhase.completionCheckpoint;
        actualCheckpointType = "completed";
      } else if (
        targetPhase.status === "failed" &&
        "errorCheckpoint" in targetPhase &&
        targetPhase.errorCheckpoint
      ) {
        sha = targetPhase.errorCheckpoint;
        actualCheckpointType = "error";
      } else if (
        targetPhase.status === "skipped" &&
        "skipCheckpoint" in targetPhase &&
        targetPhase.skipCheckpoint
      ) {
        sha = targetPhase.skipCheckpoint;
        actualCheckpointType = "skipped";
      } else if (
        "workspaceSetupCheckpoint" in targetPhase &&
        targetPhase.workspaceSetupCheckpoint
      ) {
        // Fallback to workspace setup if no end checkpoint
        sha = targetPhase.workspaceSetupCheckpoint;
        actualCheckpointType = "workspace-setup";
      }
    } else {
      // Direct checkpoint type specified
      actualCheckpointType = checkpointType as
        | "workspace-setup"
        | "completed"
        | "error"
        | "skipped";

      switch (checkpointType) {
        case "workspace-setup":
          sha =
            "workspaceSetupCheckpoint" in targetPhase
              ? targetPhase.workspaceSetupCheckpoint || null
              : null;
          break;
        case "completed":
          sha = targetPhase.status === "completed" ? targetPhase.completionCheckpoint : null;
          break;
        case "error":
          sha =
            targetPhase.status === "failed" && "errorCheckpoint" in targetPhase
              ? targetPhase.errorCheckpoint || null
              : null;
          break;
        case "skipped":
          sha =
            targetPhase.status === "skipped" && "skipCheckpoint" in targetPhase
              ? targetPhase.skipCheckpoint || null
              : null;
          break;
      }
    }

    if (!sha || !actualCheckpointType) {
      this.sendEvent({
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "error",
        data: {
          message: `No ${checkpointType} checkpoint found for phase ${phaseId}`,
          fatal: false,
        },
      } as ErrorEvent);
      return;
    }

    await this.executeRollback(thread, targetPhaseIndex, sha, actualCheckpointType, autoRestart);
  }

  /**
   * Rollback to last successful phase
   */
  private async rollbackToLastSuccess(autoRestart: boolean): Promise<void> {
    // Check if phase is running
    const currentPhase = this.stateManager.getCurrentlyRunningPhase();
    if (currentPhase && !isTerminalPhaseStatus(currentPhase.status)) {
      this.sendEvent({
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "error",
        data: {
          message: "Cannot rollback while phase is running. Use 'phase.forceStop' first.",
          phase: currentPhase.phaseId,
          fatal: false,
        },
      } as ErrorEvent);
      return;
    }

    // Build execution thread to search across all runs
    const thread = await analyzeExecutionThread(
      this.stateManager.getState(),
      this.config.phases,
      undefined, // No checkpoint validation needed for search
      undefined, // Use latest run
      this.logger,
    );

    // Find last completed phase in the thread
    let lastCompletedIndex = -1;
    for (let i = 0; i < thread.phases.length; i++) {
      if (thread.phases[i].phase.status === "completed") {
        lastCompletedIndex = i;
        break;
      }
    }

    if (lastCompletedIndex >= 0) {
      const lastCompleted = thread.phases[lastCompletedIndex];
      if (lastCompleted.phase.status === "completed") {
        // Rollback to last successful phase
        await this.executeRollback(
          thread,
          lastCompletedIndex,
          lastCompleted.phase.completionCheckpoint,
          "completed",
          autoRestart,
        );
        return;
      }
    }

    // No successful phases - find the first checkpoint in the thread
    let firstCheckpointIndex = -1;
    let firstCheckpointSha: string | null = null;
    let firstCheckpointType: string | null = null;

    for (let i = thread.phases.length - 1; i >= 0; i--) {
      const threadPhase = thread.phases[i];
      const phase = threadPhase.phase;

      if ("workspaceSetupCheckpoint" in phase && phase.workspaceSetupCheckpoint) {
        firstCheckpointIndex = i;
        firstCheckpointSha = phase.workspaceSetupCheckpoint;
        firstCheckpointType = "workspace-setup";
      } else if (phase.status === "completed" && phase.completionCheckpoint) {
        firstCheckpointIndex = i;
        firstCheckpointSha = phase.completionCheckpoint;
        firstCheckpointType = "completed";
      } else if (phase.status === "failed" && "errorCheckpoint" in phase && phase.errorCheckpoint) {
        firstCheckpointIndex = i;
        firstCheckpointSha = phase.errorCheckpoint;
        firstCheckpointType = "error";
      } else if (phase.status === "skipped" && "skipCheckpoint" in phase && phase.skipCheckpoint) {
        firstCheckpointIndex = i;
        firstCheckpointSha = phase.skipCheckpoint;
        firstCheckpointType = "skipped";
      }
    }

    if (firstCheckpointIndex >= 0 && firstCheckpointSha && firstCheckpointType) {
      this.logger.log("No successful phases found, rolling back to start");
      await this.executeRollback(
        thread,
        firstCheckpointIndex,
        firstCheckpointSha,
        firstCheckpointType,
        autoRestart,
      );
    } else {
      this.sendEvent({
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "error",
        data: {
          message: "No checkpoints found in execution history",
          fatal: false,
        },
      } as ErrorEvent);
    }
  }

  /**
   * Execute the actual rollback
   */
  private async executeRollback(
    thread: import("./execution-thread.js").ExecutionThread,
    targetPhaseIndex: number,
    sha: string,
    checkpointType: string,
    autoRestart: boolean,
  ): Promise<void> {
    const targetThreadPhase = thread.phases[targetPhaseIndex];
    if (!targetThreadPhase) {
      throw new Error(`Invalid target phase index: ${targetPhaseIndex}`);
    }

    const phaseConfig = this.config.phases.find((p) => p.id === targetThreadPhase.phase.phaseId);
    const phaseName = phaseConfig?.name || targetThreadPhase.phase.phaseId;

    this.logger.log(
      `Starting phase-by-phase rollback to ${checkpointType} checkpoint ${sha} ` +
        `in phase ${targetThreadPhase.phase.phaseId} (${phaseName})`,
    );

    // Set the rollback flag
    this.isRollingBack = true;

    // Execute the new phase-by-phase rollback
    // The flag will be cleared inside executePhaseByPhaseRollback before sending events
    await this.executePhaseByPhaseRollback(
      thread,
      targetPhaseIndex,
      sha,
      checkpointType,
      phaseName,
      autoRestart,
    ).finally(() => {
      this.isRollingBack = false;
    });
  }

  /**
   * Execute phase-by-phase rollback with workspace cleanup
   */
  private async executePhaseByPhaseRollback(
    thread: import("./execution-thread.js").ExecutionThread,
    targetPhaseIndex: number,
    targetSha: string,
    checkpointType: string,
    targetPhaseName: string,
    autoRestart: boolean,
  ): Promise<void> {
    // 1. Clean up current phase state
    this.cleanupCurrentPhase();

    // 2. Get target phase and phases to process from thread
    const targetThreadPhase = thread.phases[targetPhaseIndex];
    if (!targetThreadPhase) {
      throw new Error(`Invalid target phase index: ${targetPhaseIndex}`);
    }

    // Get all phases before target (they're already in reverse order)
    const phasesToProcess = thread.phases.slice(0, targetPhaseIndex);

    // 3. Emit rollback started event
    const fromRun = thread.phases[0]?.runId || targetThreadPhase.runId;
    const fromPhase = thread.phases[0]?.phase.phaseId || targetThreadPhase.phase.phaseId;

    this.sendEvent({
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "rollback.started",
      data: {
        fromRun,
        fromPhase,
        toPhase: targetThreadPhase.phase.phaseId,
        toCheckpoint: targetSha,
        checkpointType,
        phasesToProcess: phasesToProcess.map((tp) => tp.phase.phaseId),
      },
    } as import("./types/types.js").RollbackStartedEvent);

    // 4. Process each phase (they're already in reverse order)
    let currentStep = 0;
    const totalSteps = phasesToProcess.length + 1; // +1 for final checkpoint

    for (const threadPhase of phasesToProcess) {
      currentStep++;

      // Emit progress
      this.sendEvent({
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "rollback.progress",
        data: {
          currentStep,
          totalSteps,
          message: `Rolling back through ${threadPhase.phase.phaseId}`,
        },
      } as import("./types/types.js").RollbackProgressEvent);

      // Get the last checkpoint for this phase
      const checkpoint = this.getLastCheckpointForPhase(threadPhase.phase);
      if (checkpoint && this.checkpointGit) {
        // Reset to this phase's checkpoint
        await this.checkpointGit.resetToCheckpoint(checkpoint.sha);

        // Emit checkpoint event
        const phaseConfig = this.config.phases.find((p) => p.id === threadPhase.phase.phaseId);
        this.sendEvent({
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "rollback.phaseCheckpoint",
          data: {
            phaseId: threadPhase.phase.phaseId,
            phaseName: phaseConfig?.name || threadPhase.phase.phaseId,
            checkpoint: checkpoint.sha,
            checkpointType: checkpoint.type,
            message: `Reset to ${threadPhase.phase.phaseId} ${checkpoint.type} checkpoint`,
          },
        } as import("./types/types.js").RollbackPhaseCheckpointEvent);
      }

      // Clean up workspace directories from this phase
      await this.cleanupPhaseWorkspaceDirectories(threadPhase.phase);
    }

    // 5. Final reset to target checkpoint
    currentStep++;
    this.sendEvent({
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "rollback.progress",
      data: {
        currentStep,
        totalSteps,
        message: `Applying final checkpoint`,
      },
    } as import("./types/types.js").RollbackProgressEvent);

    if (this.checkpointGit) {
      await this.checkpointGit.resetToCheckpoint(targetSha);
    }

    this.sendEvent({
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "rollback.phaseCheckpoint",
      data: {
        phaseId: targetThreadPhase.phase.phaseId,
        phaseName: targetPhaseName,
        checkpoint: targetSha,
        checkpointType,
        message: `Reset to target checkpoint ${targetThreadPhase.phase.phaseId} (${checkpointType})`,
      },
    } as import("./types/types.js").RollbackPhaseCheckpointEvent);

    // 6. Complete current run
    const currentRun = this.stateManager.getCurrentRun();
    if (currentRun) {
      this.stateManager.transition({
        type: "RunCompleted",
        data: { runId: currentRun.runId },
      });
    }

    // 7. Wait for state transition
    await this.stateManager.waitForPendingTransitions();

    // 8. Start new continuation run
    const afterPhase =
      checkpointType === "workspace-setup" ? null : targetThreadPhase.phase.phaseId;

    await this.startNewRun({
      type: "continuation",
      source: {
        runId: targetThreadPhase.runId,
        afterPhase: afterPhase ? PhaseId(afterPhase) : null,
        checkpointSha: targetSha,
      },
      reason: "rollback",
    });

    // 9. Restore checkpoint patterns
    const targetPhaseConfigIndex = this.config.phases.findIndex(
      (p) => p.id === targetThreadPhase.phase.phaseId,
    );
    if (targetPhaseConfigIndex >= 0) {
      const includeTarget = checkpointType === "workspace-setup";
      const maxIndex = includeTarget ? targetPhaseConfigIndex : targetPhaseConfigIndex - 1;

      for (let i = 0; i <= maxIndex; i++) {
        const phase = this.config.phases[i];
        if (phase.trackedFiles?.length) {
          await this.addCheckpointPatterns(phase.trackedFiles);
        }
      }
    }

    // 8.b. Wait for transitions

    await this.stateManager.waitForPendingTransitions();

    // 10. Clear rollback flag BEFORE sending events
    this.isRollingBack = false;

    // 11. Send completion event
    this.sendEvent({
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "rollback.completed",
      data: {
        fromRun,
        toRun: this.currentRunId || "",
        checkpoint: targetSha,
        phaseId: targetThreadPhase.phase.phaseId,
        phaseName: targetPhaseName,
        checkpointType,
        autoRestart,
      },
    } as import("./types/types.js").RollbackCompletedEvent);

    // 12. Send state snapshot
    await this.sendStateSnapshot();

    // 12. Auto-restart if requested
    if (autoRestart && this.config.autostart) {
      const nextPhase = await this.stateManager.getNextPhaseToExecute();
      if (nextPhase) {
        await this.startPhase(nextPhase);
      }
    }
  }

  /**
   * Get the last checkpoint for a phase
   */
  private getLastCheckpointForPhase(phase: PhaseExecution): { sha: string; type: string } | null {
    // Priority: completed > error > skipped > workspace-setup
    if (phase.status === "completed" && phase.completionCheckpoint) {
      return { sha: phase.completionCheckpoint, type: "completed" };
    }
    if (phase.status === "failed" && "errorCheckpoint" in phase && phase.errorCheckpoint) {
      return { sha: phase.errorCheckpoint, type: "error" };
    }
    if (phase.status === "skipped" && "skipCheckpoint" in phase && phase.skipCheckpoint) {
      return { sha: phase.skipCheckpoint, type: "skipped" };
    }
    if ("workspaceSetupCheckpoint" in phase && phase.workspaceSetupCheckpoint) {
      return { sha: phase.workspaceSetupCheckpoint, type: "workspace-setup" };
    }
    return null;
  }

  /**
   * Get workspace setup directories for a phase
   */
  private getWorkspaceSetupDirectories(phaseId: PhaseId): string[] {
    const phase = this.config.phases.find((p) => p.id === phaseId);
    if (!phase?.workspaceSetup) return [];

    const directories: string[] = [];
    for (const item of phase.workspaceSetup) {
      if (item.type === "copy" && item.copy) {
        directories.push(item.copy.to);
      }
    }
    return directories;
  }

  /**
   * Clean up workspace directories created by a phase
   */
  private async cleanupPhaseWorkspaceDirectories(phase: PhaseExecution): Promise<void> {
    const directories = this.getWorkspaceSetupDirectories(phase.phaseId);
    if (directories.length === 0) return;

    const phaseConfig = this.config.phases.find((p) => p.id === phase.phaseId);
    const phaseName = phaseConfig?.name || phase.phaseId;

    // Emit cleanup started
    this.sendEvent({
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "rollback.workspaceCleanup",
      data: {
        phaseId: phase.phaseId,
        phaseName,
        directories,
        status: "started",
      },
    } as import("./types/types.js").RollbackWorkspaceCleanupEvent);

    const successfulCleanups: string[] = [];
    const failedCleanups: { directory: string; error: string }[] = [];

    for (const dir of directories) {
      const fullPath = path.join(this.config.executionPath, dir);
      try {
        if (fs.existsSync(fullPath)) {
          await fs.promises.rm(fullPath, { recursive: true, force: true });
          this.logger.log(`Removed workspace setup directory: ${dir}`);
          successfulCleanups.push(dir);
        } else {
          // Directory doesn't exist, consider it a success
          this.logger.log(`Workspace setup directory already absent: ${dir}`);
          successfulCleanups.push(dir);
        }
      } catch (error) {
        const errorMessage = toError(error).message;
        this.logger.log(`Failed to remove workspace directory ${dir}: ${errorMessage}`, "error");
        failedCleanups.push({ directory: dir, error: errorMessage });
      }
    }

    // Emit cleanup result with detailed information
    if (failedCleanups.length > 0) {
      // Partial or complete failure
      const status = successfulCleanups.length > 0 ? "partial" : "failed";
      this.sendEvent({
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "rollback.workspaceCleanup",
        data: {
          phaseId: phase.phaseId,
          phaseName,
          directories,
          status,
          successfulCleanups,
          failedCleanups,
          error: failedCleanups.map((f) => `${f.directory}: ${f.error}`).join(", "),
        },
      } as import("./types/types.js").RollbackWorkspaceCleanupEvent);
    } else {
      // Complete success
      this.sendEvent({
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "rollback.workspaceCleanup",
        data: {
          phaseId: phase.phaseId,
          phaseName,
          directories,
          status: "completed",
          successfulCleanups,
          failedCleanups: [],
        },
      } as import("./types/types.js").RollbackWorkspaceCleanupEvent);
    }
  }

  // -------------
  // Utility & Helper Methods
  // -------------

  private cleanupCurrentPhase(): void {
    if (this.logParser) {
      this.logParser.stop();
      this.logParser = null;
    }

    if (this.processManager) {
      this.processManager.removeAllListeners();
      // Ensure log stream is closed
      this.processManager
        .closeLogStream()
        .catch((err) => this.logger.log(`Error closing log stream: ${err}`, "error"));
      this.processManager = undefined;
    }

    this.watchedPatterns = [];
    this.recentFileAccess = undefined;
    this.currentPhase = undefined;
    this.phaseFailureReason = undefined;
    this.isForceStopping = false;
    this.isSkippingPhase = false; // Reset skip flag after phase completion
    this.resultMessageReceived = false; // Reset result message flag

    // Clear any pending tool uses
    this.pendingToolUses.clear();
  }

  private async runCommand(command: string, workingDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, {
        shell: true,
        cwd: workingDir,
      });

      proc.on("exit", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Command failed with exit code ${code}`));
        }
      });

      proc.on("error", reject);
    });
  }

  private async copyPath(from: string, to: string): Promise<void> {
    // Check if source exists
    const sourceStats = await fs.promises.stat(from).catch(() => null);
    if (!sourceStats) {
      throw new Error(`Source path does not exist: ${from}`);
    }

    // Check if target parent directory exists
    const targetParent = path.dirname(to);
    const parentStats = await fs.promises.stat(targetParent).catch(() => null);
    if (!parentStats || !parentStats.isDirectory()) {
      throw new Error(`Target parent directory does not exist: ${targetParent}`);
    }

    // Check if target already exists
    const targetStats = await fs.promises.stat(to).catch(() => null);
    if (targetStats) {
      throw new Error(`Target path already exists: ${to}`);
    }

    // Copy using cp command with recursive flag
    const cpCommand = `cp -r ${escapeShellArg(from)} ${escapeShellArg(to)}`;
    await this.runCommand(cpCommand, this.config.executionPath);
  }

  // -------------
  // Checkpoint Methods
  // -------------

  /**
   * Initialize checkpoint system - check git availability and switch branch
   */
  private async initializeCheckpoints(): Promise<void> {
    // Check if git is available
    if (!(await this.isGitAvailable())) {
      this.logger.log("Git is not available. Checkpointing disabled.", "info");
      this.checkpointingEnabled = false;
      return;
    }

    // Initialize checkpoint git
    this.checkpointGit = new CheckpointGit(this.config.executionPath, this.logger);
    await this.checkpointGit.initialize();

    // Provide checkpoint git to state manager for git operations
    this.stateManager.setCheckpointGit(this.checkpointGit);

    this.logger.log("Checkpoint system initialized");
  }

  /**
   * Check if git command is available using spawn for consistency
   */
  private async isGitAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn("git", ["--version"], {
        stdio: "ignore",
      });

      proc.on("error", () => resolve(false));
      proc.on("exit", (code) => resolve(code === 0));
    });
  }

  /**
   * Add checkpoint patterns for a phase (cumulative)
   */
  private async addCheckpointPatterns(patterns: string[]): Promise<void> {
    if (!this.checkpointingEnabled || patterns.length === 0) return;

    // Initialize repository on first tracked patterns
    if (!this.checkpointGit) {
      this.checkpointGit = new CheckpointGit(this.config.executionPath, this.logger);
      await this.checkpointGit.initialize();
    }

    // Add new patterns
    await this.checkpointGit.addPatterns(patterns);
    this.logger.log(`Added checkpoint patterns: ${patterns.join(", ")}`);
  }

  /**
   * Create a checkpoint commit
   */
  private async createCheckpoint(info: CheckpointInfo): Promise<string | undefined> {
    if (!this.checkpointingEnabled || !this.checkpointGit) {
      this.logger.log(
        `[CHECKPOINT-DEBUG] Checkpoint creation skipped - enabled: ${
          this.checkpointingEnabled
        }, git: ${!!this.checkpointGit}`,
      );
      return;
    }

    this.logger.log(
      `[CHECKPOINT-DEBUG] Creating checkpoint for phase ${info.phaseId} with status ${info.status}`,
    );
    this.logger.log(`[CHECKPOINT-DEBUG] Checkpoint info: ${JSON.stringify(info)}`);

    try {
      // Format commit message
      const firstLine = `${info.status}:${info.phaseId} [run:${info.runId}] ${info.phaseName}`;
      const body = [
        "",
        `Phase: ${info.phaseName}`,
        `Status: ${info.status}`,
        `Timestamp: ${info.timestamp}`,
      ];

      if (info.duration !== undefined) {
        body.push(`Duration: ${info.duration}ms`);
      }

      const commitMessage = `${firstLine}\n${body.join("\n")}`;
      this.logger.log(`[CHECKPOINT-DEBUG] Commit message: ${commitMessage}`);

      // Get current run's branch
      const currentRun = this.stateManager.getCurrentRun();
      const branchName = currentRun?.gitBranch || `run-${this.currentRunId}`;
      this.logger.log(`[CHECKPOINT-DEBUG] Using branch: ${branchName}`);

      // Create checkpoint on run-specific branch
      const commitHash = await this.checkpointGit.commit(commitMessage, {
        branch: branchName,
      });

      this.logger.log(`[CHECKPOINT-DEBUG] Checkpoint commit returned: ${commitHash}`);

      if (commitHash) {
        this.logger.log(
          `[CHECKPOINT-DEBUG] Created checkpoint: ${commitHash} (${info.status}) on branch ${branchName}`,
        );

        // Fire checkpoint created transition to store SHA in state
        const checkpointType =
          info.status === "workspace-setup"
            ? "workspace-setup"
            : info.status === "completed"
              ? "completed"
              : info.status === "error"
                ? "error"
                : "skipped";

        this.logger.log(
          `[CHECKPOINT-DEBUG] Firing CheckpointCreated transition with type: ${checkpointType}`,
        );

        if (this.currentRunId) {
          this.stateManager.transition({
            type: "CheckpointCreated",
            data: {
              runId: this.currentRunId,
              phaseId: PhaseId(info.phaseId),
              checkpointType,
              sha: commitHash,
              branch: branchName,
            },
          });
        }

        return commitHash;
      } else {
        this.logger.log(`[CHECKPOINT-DEBUG] No commit hash returned from checkpoint.commit()`);
      }
    } catch (error) {
      // Handle disk full or other git errors
      this.logger.log(
        `[CHECKPOINT-DEBUG] Checkpoint failed: ${toError(error).message}. ` +
          "Disabling checkpointing for this session.",
        "error",
      );
      this.checkpointingEnabled = false;
    }
  }

  // -------------
  // Shutdown & Cleanup
  // -------------

  async shutdown(reason: string): Promise<void> {
    if (this.isShuttingDown) {
      this.logger.log(`Shutdown already in progress, ignoring: ${reason}`);
      return;
    }
    this.logger.log(`Shutting down server: ${reason}`);

    // Kill any running process immediately before setting shutdown flag
    if (this.processManager && this.currentPhase) {
      this.logger.log("Killing current Claude process for shutdown");
      await this.processManager.kill("SIGTERM");
    }

    this.isShuttingDown = true;

    // Create exit checkpoint if not shutting down normally (all phases completed)
    if (reason !== "all phases completed" && this.checkpointingEnabled && this.currentPhase) {
      await this.createCheckpoint({
        status: "exit",
        phaseId: this.currentPhase.phase.id,
        phaseName: this.currentPhase.phase.name,
        runId: this.currentRunId || RunId("unknown"),
        timestamp: new Date().toISOString(),
      });
    }

    this.cleanupCurrentPhase();

    // Mark run as completed or failed based on reason
    if (this.currentRunId && reason === "all phases completed") {
      this.stateManager.transition({
        type: "RunCompleted",
        data: { runId: this.currentRunId },
      });
    } else if (this.currentRunId && reason !== "phase failure") {
      // Phase failure already marked the run as failed
      this.stateManager.transition({
        type: "RunFailed",
        data: { runId: this.currentRunId },
      });
    }

    // Wait for any pending state transitions
    await this.stateManager.waitForPendingTransitions();

    // Clear heartbeat interval
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }

    if (this.client) {
      this.client.close();
      this.client = null;
    }

    if (this.server) {
      this.server.stop();
      this.server = null;
    }

    if (fs.existsSync(this.config.lockFile)) {
      try {
        fs.unlinkSync(this.config.lockFile);
        this.logger.log("Lock file removed");
      } catch (error) {
        this.logger.log(`Failed to remove lock file: ${error}`, "error");
      }
    }

    this.logger.log("Server shutdown complete");

    // Ensure lock file is really gone before delay
    try {
      if (fs.existsSync(this.config.lockFile)) {
        fs.unlinkSync(this.config.lockFile);
      }
    } catch {
      // Ignore errors on second attempt
    }

    // Small delay to ensure log is written
    setTimeout(() => {
      process.exit(0);
    }, TIMEOUTS.PHASE_CLEANUP_DELAY_MS);
  }
}

</server/tadpole-server.ts>

<server/typed-event-emitter.ts>
import { EventEmitter } from "node:events";
import type { PhaseId, RunId } from "./types/branded-types.js";
import type { PhaseStatus, StateTransition } from "./types/state-types.js";
import type { ServerEvent } from "./types/types.js";

/**
 * Type-safe wrapper around Node's EventEmitter.
 * Ensures event names and argument types are consistent at compile time.
 */
export class TypedEventEmitter<T extends Record<string, unknown[]>> {
  private emitter = new EventEmitter();

  on<K extends keyof T>(event: K, listener: (...args: T[K]) => void): this {
    this.emitter.on(event as string, listener as (...args: unknown[]) => void);
    return this;
  }

  off<K extends keyof T>(event: K, listener: (...args: T[K]) => void): this {
    this.emitter.off(event as string, listener as (...args: unknown[]) => void);
    return this;
  }

  emit<K extends keyof T>(event: K, ...args: T[K]): boolean {
    return this.emitter.emit(event as string, ...args);
  }

  once<K extends keyof T>(event: K, listener: (...args: T[K]) => void): this {
    this.emitter.once(event as string, listener as (...args: unknown[]) => void);
    return this;
  }

  removeAllListeners<K extends keyof T>(event?: K): this {
    if (event) {
      this.emitter.removeAllListeners(event as string);
    } else {
      this.emitter.removeAllListeners();
    }
    return this;
  }

  // Additional EventEmitter compatibility methods
  addListener<K extends keyof T>(event: K, listener: (...args: T[K]) => void): this {
    return this.on(event, listener);
  }

  removeListener<K extends keyof T>(event: K, listener: (...args: T[K]) => void): this {
    return this.off(event, listener);
  }

  setMaxListeners(n: number): this {
    this.emitter.setMaxListeners(n);
    return this;
  }

  getMaxListeners(): number {
    return this.emitter.getMaxListeners();
  }

  listeners(event: keyof T): Function[] {
    return this.emitter.listeners(event as string);
  }

  rawListeners(event: keyof T): Function[] {
    return this.emitter.rawListeners(event as string);
  }

  eventNames(): (string | symbol)[] {
    return this.emitter.eventNames();
  }

  listenerCount(event: keyof T): number {
    return this.emitter.listenerCount(event as string);
  }

  prependListener<K extends keyof T>(event: K, listener: (...args: T[K]) => void): this {
    this.emitter.prependListener(event as string, listener as (...args: unknown[]) => void);
    return this;
  }

  prependOnceListener<K extends keyof T>(event: K, listener: (...args: T[K]) => void): this {
    this.emitter.prependOnceListener(event as string, listener as (...args: unknown[]) => void);
    return this;
  }
}

// Define server event map
export interface ServerInternalEvents {
  event: [ServerEvent];
  exit: [code: number];
  error: [error: Error];
  stdout: [data: string];
  stderr: [data: string];
  [key: string]: unknown[]; // Index signature to satisfy constraint
}

// Define process manager event map
export interface ProcessEvents {
  exit: [code: number];
  error: [error: Error];
  stdout: [data: string];
  stderr: [data: string];
  [key: string]: unknown[]; // Index signature to satisfy constraint
}

// Define state manager event map
export interface StateManagerEvents {
  stateChanged: [StateTransition];
  phaseRunning: [
    {
      runId: RunId;
      phaseId: PhaseId;
      from: PhaseStatus;
      to: "running";
      metadata?: Record<string, unknown>;
    },
  ];
  transitionError: [{ event: StateTransition; error: Error }];
  [key: string]: unknown[]; // Index signature to satisfy constraint
}

</server/typed-event-emitter.ts>

<server/utils.ts>
import fs from "node:fs";
import path from "node:path";
import { fileResolver } from "./file-resolver.js";
import type { FileNode } from "./types/types.js";

// -------------
// ID Generation
// -------------

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// -------------
// Logger
// -------------

export class Logger {
  constructor(private logFile: string) {}

  log(message: string, level: "info" | "error" | "debug" = "info"): void {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;

    try {
      const logsDir = path.dirname(this.logFile);
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }

      fs.appendFileSync(this.logFile, logLine);
    } catch (error) {
      // If we can't write to file (e.g., during shutdown), just log to console
      console.error(`Failed to write to log file: ${error}`);
    }

    if (level === "error") {
      console.error(logLine.trim());
    }
  }

  logSocketTraffic(socketLogFile: string, direction: "in" | "out", data: unknown): void {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] [${direction.toUpperCase()}] ${JSON.stringify(data)}\n`;

    const logsDir = path.dirname(socketLogFile);
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    fs.appendFileSync(socketLogFile, logLine);
  }
}

// -------------
// File System Utilities
// -------------

/**
 * Build a hierarchical file tree from files matching a pattern.
 *
 * Creates a tree structure suitable for UI display, with directories
 * as nodes containing their children. Used for filetree.updated events.
 * Includes last modified times for files.
 *
 * @param projectPath - Base directory
 * @param pattern - Glob pattern to match files
 * @returns Root nodes of the file tree
 */
export async function buildFileTree(projectPath: string, pattern: string): Promise<FileNode[]> {
  const tree: FileNode[] = [];

  try {
    // Use unified file resolver to respect gitignore
    const resolvedFiles = await fileResolver.resolveFiles(projectPath, [pattern]);

    // Get file metadata for each resolved file
    const files = await Promise.all(
      resolvedFiles.map(async (filePath) => {
        const fullPath = path.join(projectPath, filePath);
        const stats = await fs.promises.stat(fullPath);
        const content = await fs.promises.readFile(fullPath, "utf-8");
        return {
          path: filePath,
          content,
          lastModified: stats.mtime.toISOString(),
        };
      }),
    );

    const dirMap = new Map<string, FileNode>();

    // Sort files to ensure directories are created before their children
    files.sort((a, b) => a.path.localeCompare(b.path));

    for (const file of files) {
      // Normalize path to remove leading "./"
      const normalizedPath = file.path.startsWith("./") ? file.path.slice(2) : file.path;
      const parts = normalizedPath.split(path.sep);
      let currentPath = "";
      let parent: FileNode | null = null;

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        currentPath = currentPath ? path.join(currentPath, part) : part;

        if (i === parts.length - 1) {
          // This is a file
          const fileNode: FileNode = {
            name: part,
            path: currentPath,
            isDirectory: false,
            lastModified: file.lastModified,
            children: [], // Empty array for files
          };

          if (parent) {
            if (!parent.children) parent.children = [];
            parent.children.push(fileNode);
          } else {
            tree.push(fileNode);
          }
        } else {
          // This is a directory
          if (!dirMap.has(currentPath)) {
            const dirNode: FileNode = {
              name: part,
              path: currentPath,
              isDirectory: true,
              children: [],
            };
            dirMap.set(currentPath, dirNode);

            if (parent) {
              if (!parent.children) parent.children = [];
              parent.children.push(dirNode);
            } else {
              tree.push(dirNode);
            }
          }
          parent = dirMap.get(currentPath) || null;
        }
      }
    }
  } catch (error) {
    // Error building file tree
    console.error("Error building file tree:", error);
  }

  return tree;
}

// -------------
// Shell Utilities
// -------------

/**
 * Escape a string for safe use in shell commands.
 * Replaces single quotes with '\'' and wraps in single quotes.
 */
export function escapeShellArg(arg: string): string {
  // Replace all single quotes with '\''
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

// -------------
// Error Utilities
// -------------

/**
 * Type guard to check if a value is an Error instance.
 */
export function isError(error: unknown): error is Error {
  return error instanceof Error;
}

/**
 * Convert any value to an Error instance.
 * If already an Error, returns it unchanged.
 * Otherwise creates a new Error with string representation.
 */
export function toError(error: unknown): Error {
  if (isError(error)) return error;
  if (typeof error === "string") return new Error(error);
  return new Error(String(error));
}

// -------------
// Exhaustive Checking
// -------------

/**
 * Exhaustive checking helper for switch statements.
 * Use this in the default case to ensure all union cases are handled.
 * TypeScript will error if a case is missing.
 */
export function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(x)}`);
}

// -------------
// Directory Utilities
// -------------

/**
 * Calculate the total size of a directory recursively.
 * Includes a timeout to prevent hanging on large directories.
 */
export async function getDirectorySize(
  dirPath: string,
  timeoutMs = 30000, // Preserve timeout feature from cleanup folder
): Promise<number> {
  let totalSize = 0;
  const startTime = Date.now();

  async function walkDir(currentPath: string): Promise<void> {
    // Check timeout
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`Directory size calculation timed out after ${timeoutMs}ms`);
    }

    const entries = await fs.promises.readdir(currentPath, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        await walkDir(fullPath);
      } else {
        try {
          const stats = await fs.promises.stat(fullPath);
          totalSize += stats.size;
        } catch {
          // Ignore files we can't stat
        }
      }
    }
  }

  await walkDir(dirPath);
  return totalSize;
}

/**
 * Format a byte size into a human-readable string.
 */
export function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";

  const units = ["B", "KB", "MB", "GB"];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${(bytes / k ** i).toFixed(1)} ${units[i]}`;
}

</server/utils.ts>

<server/types/branded-types.ts>
/**
 * Branded types for type safety and clarity
 */

// Helper type for branding
type Branded<T, Brand> = T & { __brand: Brand };

// Phase ID - references a phase configuration
export type PhaseId = Branded<string, "PhaseId">;
export const PhaseId = (id: string): PhaseId => id as PhaseId;

// Session ID - Claude's session UUID
export type SessionId = Branded<string, "SessionId">;
export const SessionId = (id: string): SessionId => id as SessionId;

// Run ID - Unique identifier for a server run
export type RunId = Branded<string, "RunId">;
export const RunId = (id: string): RunId => id as RunId;

// Event ID - Unique identifier for WebSocket events
export type EventId = Branded<string, "EventId">;
export const EventId = (id: string): EventId => id as EventId;

</server/types/branded-types.ts>

<server/types/claude-session-schema.ts>
import { z } from "zod";

/**
 * Claude Code Session Log Schema
 *
 * This schema defines the structure of Claude Code session logs captured from
 * data analysis experiments across different domains (healthcare, financial, technical).
 *
 * Each log file contains a complete conversation session with tool usage,
 * including system initialization, assistant responses, user inputs, and tool results.
 */

// Session ID validation - accept UUID v4 or any string for forward compatibility
const sessionIdSchema = z.string();

// UUID v4 format validation (kept for backward compatibility in metadata)
const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "Must be a valid UUID v4",
  );

// Tool names - accept any string for forward compatibility
export const toolNameSchema = z.string();

// Claude model identifier - accepting the full model name from logs
// Also accepts <synthetic> for timeout messages
const modelSchema = z
  .string()
  .regex(/^(claude-.*|<synthetic>)$/, "Must be a Claude model identifier or <synthetic>");

// Permission mode for Claude Code
const permissionModeSchema = z.enum(["bypassPermissions", "requestPermissions"]);

// API key source - accepts known values and "none" for cases where API key is configured differently
const apiKeySourceSchema = z.enum(["ANTHROPIC_API_KEY", "env", "none"]);

/**
 * System Message Schema
 *
 * Appears at the beginning of each session to initialize the Claude Code environment.
 * Contains session metadata, tool configuration, and working directory information.
 */
export const systemMessageSchema = z
  .object({
    type: z.literal("system"),
    subtype: z.literal("init"),

    // Working directory where Claude Code is operating
    cwd: z.string().min(1, "Working directory cannot be empty"),

    // Unique session identifier for this conversation
    session_id: sessionIdSchema,

    // Available tools for this session (standard Claude Code toolset)
    tools: z.array(toolNameSchema).min(1, "Must have at least one tool"),

    // MCP (Model Context Protocol) servers - typically empty array
    mcp_servers: z.array(z.unknown()).default([]),

    // Claude model being used
    model: modelSchema,

    // Permission mode for tool execution
    permissionMode: permissionModeSchema,

    // Source of API key configuration
    apiKeySource: apiKeySourceSchema,
  })
  .passthrough();

/**
 * Tool Use Content Schema
 *
 * Represents a tool invocation within an assistant message.
 * Contains the tool name, unique ID, and input parameters.
 */
export const toolUseContentSchema = z.object({
  type: z.literal("tool_use"),

  // Unique identifier for this tool use
  // - Claude format: toolu_[alphanumeric]
  // - Non-Claude models (e.g., Qwen): call_[hex string]
  id: z.string().regex(/^(toolu_[a-zA-Z0-9]+|call_[a-fA-F0-9]+)$/, "Invalid tool use ID format"),

  // Name of the tool being invoked
  name: toolNameSchema,

  // Input parameters for the tool (varies by tool type)
  input: z.record(z.unknown()).optional(),
});

/**
 * Text Content Schema
 *
 * Represents plain text content within a message.
 */
export const textContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

/**
 * Thinking Content Schema
 *
 * Represents Claude's internal thinking process (when enabled).
 */
export const thinkingContentSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
});

/**
 * Tool Result Content Schema
 *
 * Represents the result of a tool execution within a user message.
 */
export const toolResultContentSchema = z.object({
  type: z.literal("tool_result"),

  // ID of the tool use this result corresponds to
  // - Claude format: toolu_[alphanumeric]
  // - Non-Claude models (e.g., Qwen): call_[hex string]
  tool_use_id: z
    .string()
    .regex(/^(toolu_[a-zA-Z0-9]+|call_[a-fA-F0-9]+)$/, "Invalid tool use ID format"),

  // Result content from tool execution (can be string, object, or array of content items)
  content: z.union([
    z.string(),
    z.record(z.unknown()),
    z.array(
      z.object({
        type: z.literal("text"),
        text: z.string(),
      }),
    ),
  ]),
});

/**
 * Message Content Schema
 *
 * Union of all possible content types within a message.
 */
export const messageContentSchema = z.union([
  toolUseContentSchema,
  textContentSchema,
  thinkingContentSchema,
  toolResultContentSchema,
]);

/**
 * Assistant Message Schema
 *
 * Represents Claude's responses, including text and tool use requests.
 */
export const assistantMessageSchema = z.object({
  type: z.literal("assistant"),

  message: z.object({
    // Message identifier - normal messages use msg_ prefix, synthetic messages may use UUID
    id: z
      .string()
      .regex(
        /^(msg_[a-zA-Z0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
        "Invalid message ID format",
      ),

    type: z.literal("message"),
    role: z.literal("assistant"),

    // Claude model used for this response
    model: modelSchema,

    // Message content (can be text, tool use, or thinking)
    content: z.union([
      z.array(messageContentSchema),
      z.string(), // Sometimes content is just a string
    ]),

    // Token usage information (optional)
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
        cache_creation_input_tokens: z.number().int().nonnegative().optional(),
        cache_read_input_tokens: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),

    // Stop reason for the response (can be null)
    stop_reason: z
      .enum(["end_turn", "max_tokens", "stop_sequence", "tool_use"])
      .nullable()
      .optional(),

    // Stop sequence used (if applicable, can be null)
    stop_sequence: z.string().nullable().optional(),
  }),
});

/**
 * User Message Schema
 *
 * Represents user input or tool results being provided to Claude.
 */
export const userMessageSchema = z.object({
  type: z.literal("user"),

  message: z.object({
    role: z.literal("user"),

    // Message content (typically tool results or user input)
    content: z.union([
      z.array(messageContentSchema),
      z.string(), // Sometimes content is just a string
    ]),
  }),
});

/**
 * Result Message Schema
 *
 * Appears at the end of each session to summarize the conversation outcome.
 */
export const resultMessageSchema = z
  .object({
    type: z.literal("result"),
    subtype: z.enum(["success", "error"]),

    // Whether the session ended in error
    is_error: z.boolean(),

    // Total duration of the session in milliseconds
    duration_ms: z.number().int().nonnegative(),

    // Total API time in milliseconds
    duration_api_ms: z.number().int().nonnegative(),

    // Number of conversation turns
    num_turns: z.number().int().nonnegative(),

    // Final result or summary of the session
    result: z.string(),

    // Session ID
    session_id: z.string().optional(),

    // Total cost in USD
    total_cost_usd: z.number().optional(),

    // Token usage summary
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative().optional(),
        output_tokens: z.number().int().nonnegative().optional(),
        cache_creation_input_tokens: z.number().int().nonnegative().optional(),
        cache_read_input_tokens: z.number().int().nonnegative().optional(),
        server_tool_use: z
          .object({
            web_search_requests: z.number().int().nonnegative().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/**
 * Log Message Schema
 *
 * Union of all possible message types in a Claude Code session log.
 */
export const logMessageSchema = z.union([
  systemMessageSchema,
  assistantMessageSchema,
  userMessageSchema,
  resultMessageSchema,
]);

/**
 * Session Log Schema
 *
 * Represents a complete Claude Code session log file.
 * Each file contains an array of messages representing the full conversation.
 */
export const sessionLogSchema = z
  .array(logMessageSchema)
  .min(1, "Session must contain at least one message");

/**
 * Session Metadata Schema
 *
 * Extracted metadata from a session log for analysis purposes.
 */
export const sessionMetadataSchema = z.object({
  // File information
  filename: z.string(),
  session_id: uuidSchema,

  // Session characteristics
  total_messages: z.number().int().nonnegative(),
  message_type_counts: z.record(z.number().int().nonnegative()),

  // Tool usage
  tools_used: z.array(toolNameSchema),
  tool_use_count: z.number().int().nonnegative(),

  // Session outcome
  duration_ms: z.number().int().nonnegative().optional(),
  duration_api_ms: z.number().int().nonnegative().optional(),
  num_turns: z.number().int().nonnegative().optional(),
  success: z.boolean().optional(),

  // Working directory
  cwd: z.string(),

  // Model used
  model: modelSchema,
});

// Export type definitions for TypeScript usage
export type SystemMessage = z.infer<typeof systemMessageSchema>;
export type AssistantMessage = z.infer<typeof assistantMessageSchema>;
export type UserMessage = z.infer<typeof userMessageSchema>;
export type ResultMessage = z.infer<typeof resultMessageSchema>;
export type LogMessage = z.infer<typeof logMessageSchema>;
export type SessionLog = z.infer<typeof sessionLogSchema>;
export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;
export type ToolName = z.infer<typeof toolNameSchema>;
export type MessageContent = z.infer<typeof messageContentSchema>;
export type ToolUseContent = z.infer<typeof toolUseContentSchema>;
export type TextContent = z.infer<typeof textContentSchema>;
export type ThinkingContent = z.infer<typeof thinkingContentSchema>;
export type ToolResultContent = z.infer<typeof toolResultContentSchema>;

</server/types/claude-session-schema.ts>

<server/types/error-types.ts>
/**
 * Error severity levels for Tadpole server.
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
export class TadpoleError extends Error {
  constructor(
    message: string,
    public readonly severity: ErrorSeverity,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TadpoleError";
  }
}

export class FatalError extends TadpoleError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, ErrorSeverity.FATAL, "FATAL_ERROR", context);
    this.name = "FatalError";
  }
}

export class PhaseError extends TadpoleError {
  constructor(message: string, phaseId: string, context?: Record<string, unknown>) {
    super(message, ErrorSeverity.PHASE, "PHASE_ERROR", { ...context, phaseId });
    this.name = "PhaseError";
  }
}

export class OperationError extends TadpoleError {
  constructor(message: string, operation: string, context?: Record<string, unknown>) {
    super(message, ErrorSeverity.OPERATION, "OPERATION_ERROR", {
      ...context,
      operation,
    });
    this.name = "OperationError";
  }
}

export class APITimeoutError extends TadpoleError {
  constructor(phaseId: string, context?: Record<string, unknown>) {
    super("Claude API request timed out", ErrorSeverity.PHASE, "API_TIMEOUT_ERROR", {
      ...context,
      phaseId,
    });
    this.name = "APITimeoutError";
  }
}

</server/types/error-types.ts>

<server/types/state-types.ts>
// -------------
// Tadpole State Management Types
// -------------

import type { PhaseId, RunId, SessionId } from "./branded-types.js";
import type { FailureReason, TokenUsage } from "./types.js";

// Re-export types for use in other modules
export type { PhaseId, RunId, SessionId, FailureReason, TokenUsage };

// -------------
// Phase Execution States - Discriminated Union
// -------------

/**
 * Phase execution status progression.
 *
 * Normal flow: preparing → starting → initializing → running → completed
 * Can skip to "failed" or "skipped" from any non-terminal state.
 *
 * Intent: Track granular progress for better crash recovery and user feedback.
 */
export type PhaseStatus =
  | "preparing" // Workspace setup running (copy files, run commands)
  | "starting" // Spawning Claude process
  | "initializing" // Process started, waiting for session ID
  | "running" // Claude is working (have session ID)
  | "completed" // Success - terminal state
  | "failed" // Failed - terminal state
  | "skipped"; // User skipped - terminal state

/**
 * Base properties shared by all phase states.
 * These are set when the phase starts and never change.
 */
interface BasePhase {
  /**
   * Which phase configuration this execution is for.
   * References the phase in phases.json.
   *
   * Used by: UI to show phase name, state queries for phase history
   */
  phaseId: PhaseId;

  /**
   * When this phase execution started.
   * ISO 8601 timestamp.
   *
   * Used by: Duration calculations, UI timeline display
   */
  startTime: string;
}

/**
 * Phase is preparing workspace (running workspace setup operations).
 *
 * Next states:
 * - starting: Workspace setup succeeded
 * - failed: Copy failed, command failed, etc.
 * - skipped: User skipped during prep
 */
export interface PreparingPhase extends BasePhase {
  status: "preparing";
  // No Claude info yet - process not started
  // No costs yet - Claude not running
}

/**
 * Spawning Claude process.
 *
 * Next states:
 * - initializing: Process started successfully
 * - failed: Spawn failed (Claude not found, etc.)
 * - skipped: User skipped during startup
 */
export interface StartingPhase extends BasePhase {
  status: "starting";

  /**
   * Git commit SHA after workspace setup completed.
   * Only set if phase config has workspaceSetup operations.
   *
   * Used by: Rollback to know exact state after setup
   * Edge case: May be undefined if no workspace setup configured
   */
  workspaceSetupCheckpoint?: string;
}

/**
 * Claude process running but no session ID yet.
 * Waiting for init message from Claude.
 *
 * Next states:
 * - running: Got session ID from init message
 * - failed: Process crashed before init
 * - skipped: User skipped during init
 */
export interface InitializingPhase extends BasePhase {
  status: "initializing";
  workspaceSetupCheckpoint?: string;

  /**
   * Claude process ID for monitoring/cleanup.
   *
   * Used by: Process manager to kill on skip/shutdown
   * Edge case: Process might already be dead
   */
  claudePid: number;

  /**
   * Path to Claude's JSONL log file.
   * Relative to .tadpole directory.
   * Example: "runs/1234-abc/phase-research-claude.log"
   *
   * Used by: Log parser, debugging, cleanup
   */
  claudeLogPath: string;

  /**
   * Session ID from previous phase if continuing.
   * Only set if phase has continueFromPrevious: true.
   *
   * Used by: Claude CLI --resume flag
   */
  previousSessionId?: SessionId;
}

/**
 * Claude is actively working.
 * This is where most time is spent.
 *
 * Next states:
 * - completed: Claude process exited cleanly
 * - failed: Timeout, API error, crash
 * - skipped: User skipped
 */
export interface RunningPhase extends BasePhase {
  status: "running";
  workspaceSetupCheckpoint?: string;
  claudePid: number;

  /**
   * Claude's session UUID from init message.
   * Required for continuation in later phases.
   *
   * Used by: Continue functionality, logs correlation
   */
  claudeSessionId: SessionId;
  claudeLogPath: string;
  previousSessionId?: SessionId;

  /**
   * Accumulated cost so far in USD.
   * Updated on each token usage message.
   *
   * Used by: Cost display, cost limits (future)
   * Edge case: May be stale if messages delayed
   */
  currentCost: number;

  /**
   * Accumulated token counts.
   * Updated on each assistant message with usage.
   *
   * Used by: Token display, rate limit tracking
   */
  currentTokens: TokenUsage;

  /**
   * Number of assistant messages received.
   * Used to determine if Claude has established a conversation.
   * Initialized to 0 when phase enters running state.
   *
   * Used by: Continue functionality to check if session is valid
   */
  assistantMessageCount: number;
}

// -------------
// Terminal States - Immutable once reached
// -------------

/**
 * Phase completed successfully.
 * This is a terminal state - no further transitions possible.
 *
 * Immutability: All fields are final. To retry, start a new run.
 */
export interface CompletedPhase extends BasePhase {
  status: "completed";

  /**
   * When phase completed. Used for duration calculation.
   */
  endTime: string;

  // Claude integration details
  claudeSessionId: SessionId;
  claudeLogPath: string;
  previousSessionId?: SessionId;

  /**
   * Always 0 for successful completion.
   *
   * Used by: Success detection
   */
  exitCode: 0;

  /**
   * Final cost from result message or last token update.
   * This is the authoritative cost for this phase.
   *
   * Used by: Billing, cost reports
   * Edge case: May be from token updates if result message timed out
   */
  finalCost: number;

  /**
   * Final token counts.
   *
   * Used by: Usage analytics, model comparison
   */
  finalTokens: TokenUsage;

  /**
   * Whether we got Claude's result message before timeout.
   * False means costs might be slightly off.
   *
   * Used by: Cost accuracy warnings
   */
  resultMessageReceived: boolean;

  // Checkpoints
  workspaceSetupCheckpoint?: string;

  /**
   * Git commit after successful completion.
   * Always created for successful phases.
   *
   * Used by: Rollback target points
   */
  completionCheckpoint: string;
}

/**
 * Phase failed with error.
 * Terminal state - must start new run to retry.
 */
export interface FailedPhase extends BasePhase {
  status: "failed";
  endTime: string;

  /**
   * Which state we were in when failure occurred.
   * Helps understand how far we got.
   *
   * Used by: Error analysis, retry strategies
   * Example: "preparing" means workspace setup failed
   */
  failedDuring: "preparing" | "starting" | "initializing" | "running";

  // Claude info - only set if we got that far
  claudePid?: number;
  claudeSessionId?: SessionId;
  claudeLogPath?: string;
  previousSessionId?: SessionId;

  /**
   * Process exit code. 0 means clean exit (shouldn't happen for failed).
   * Common codes:
   * - 1: General error
   * - -1: Killed by signal
   * - 130: Ctrl+C
   *
   * Used by: Debugging, retry decisions
   */
  exitCode: number;

  /**
   * Structured failure information.
   *
   * Used by: UI error display, retry logic
   */
  failureReason: FailureReason;

  /**
   * Costs accumulated before failure.
   * Will be 0 if failed before Claude started.
   *
   * Used by: Partial cost tracking
   */
  partialCost: number;
  partialTokens: TokenUsage;

  // Checkpoints
  workspaceSetupCheckpoint?: string;

  /**
   * Error checkpoint if created.
   * On error branch in git.
   *
   * Edge case: Might not exist if git operations failed
   */
  errorCheckpoint?: string;
}

/**
 * Phase was skipped by user.
 * Terminal state - represents user choice to skip.
 */
export interface SkippedPhase extends BasePhase {
  status: "skipped";
  endTime: string;

  /**
   * Which state we were in when skipped.
   *
   * Used by: Understanding skip patterns
   */
  skippedDuring: "preparing" | "starting" | "initializing" | "running";

  // Claude info - only set if we got that far
  claudePid?: number;
  claudeSessionId?: SessionId;
  claudeLogPath?: string;
  previousSessionId?: SessionId;

  /**
   * Partial cost accumulated before skip.
   * Usually 0, but may have accumulated costs if skipped while running.
   *
   * Used by: Cost calculations, continuation logic
   */
  partialCost: number;

  /**
   * All zeros - no tokens used for skipped.
   */
  partialTokens: TokenUsage;

  /**
   * Number of assistant messages received before skip.
   * Used to determine if session can be continued.
   *
   * Used by: Continue functionality
   */
  assistantMessageCount?: number;

  // Checkpoints
  workspaceSetupCheckpoint?: string;

  /**
   * Skip checkpoint if any files were being tracked.
   * Even empty commits are created for skip markers.
   *
   * Used by: Skip history in git
   */
  skipCheckpoint?: string;
}

/**
 * Union of all possible phase states.
 * Use discriminated union on `status` field for type narrowing.
 */
export type PhaseExecution =
  | PreparingPhase
  | StartingPhase
  | InitializingPhase
  | RunningPhase
  | CompletedPhase
  | FailedPhase
  | SkippedPhase;

// -------------
// Run State
// -------------

/**
 * Represents one server lifecycle (start → shutdown).
 * Runs form a tree via parent relationships for rollback/retry.
 */
export interface Run {
  /**
   * Unique identifier for this run.
   * Also used as git branch name.
   *
   * Used by: State lookups, folder naming, git branches
   */
  runId: RunId;

  /**
   * Absolute path where run files are stored.
   * Example: "/project/.tadpole/runs/1234-abc"
   *
   * Used by: Log file storage, cleanup operations
   * Edge case: Folder might not exist if run failed early
   */
  runFolder: string;

  /**
   * Git branch name for this run.
   * Usually same as runId, but explicit for flexibility.
   *
   * Used by: Checkpoint system
   */
  gitBranch: string;

  /**
   * How this run started - fresh or continuation.
   * Immutable after run creation.
   *
   * Used by: UI to show run relationships, rollback tracking
   */
  startingConditions: StartingConditions;

  /**
   * Ordered list of phase executions in this run.
   * Append-only - new phases added as they start.
   *
   * Used by: Progress tracking, cost calculation
   * Invariant: Only one phase can be non-terminal at a time
   */
  phases: PhaseExecution[];

  /**
   * Overall run status.
   * - running: Currently executing
   * - completed: All phases done successfully
   * - failed: Stopped due to phase failure
   * - crashed: Detected on recovery
   *
   * Used by: Run selection, cleanup decisions
   */
  status: "running" | "completed" | "failed" | "crashed";

  /**
   * When server started. Never changes.
   */
  startTime: string;

  /**
   * When server stopped. Set when status becomes terminal.
   */
  endTime?: string;

  /**
   * Server process ID for lock file validation.
   *
   * Used by: Detecting stale lock files, crash recovery
   * Edge case: Process might not exist anymore
   */
  serverPid: number;
}

/**
 * How a run started - fresh project or continuation.
 */
export type StartingConditions =
  | {
      type: "fresh";
      initialCheckpointSha?: string; // SHA of the initial checkpoint commit
    }
  | {
      type: "continuation";
      source: {
        /**
         * Which run we're continuing from.
         *
         * Used by: Building run relationships tree
         */
        runId: RunId;

        /**
         * Which phase to continue after.
         * null means start from beginning of that run.
         *
         * Example: "phase-2" means start from phase-3
         * Used by: Determining next phase to execute
         */
        afterPhase: PhaseId | null;

        /**
         * Git commit SHA we restored to.
         * This is the exact state we're continuing from.
         *
         * Used by: Verifying correct restoration
         */
        checkpointSha: string;
      };

      /**
       * Human-readable reason for continuation.
       * Optional metadata for UI/analytics.
       *
       * Used by: Understanding user patterns
       */
      reason?: "retry" | "rollback" | "continue";
    };

// -------------
// Top-Level State
// -------------

/**
 * Root state object for Tadpole.
 * Stored in .tadpole/state.json.
 *
 * Design decisions:
 * - Single file instead of per-run for simplicity
 * - No version field per user request
 * - No denormalized costs - computed when needed
 */
export interface TadpoleState {
  /**
   * All runs, newest first.
   * Append-only - runs are never removed from history.
   *
   * Used by: History UI, cost calculations, rollback sources
   * Scaling: May need pagination/archival eventually
   */
  runs: Run[];

  /**
   * Currently active run ID.
   * null when server not running.
   *
   * Used by: State queries, preventing multiple servers
   * Invariant: Only one run can be "running" status
   */
  currentRunId: RunId | null;

  /**
   * Initial checkpoint SHA from git repository initialization.
   * This is the empty commit created when the checkpoint system starts.
   * Represents the project's clean state before any phases have executed.
   *
   * Used by: Rollback to clean state, project-level rollback commands
   */
  initialCheckpoint?: string;

  // No denormalized costs/tokens - computed from runs when needed
  // This avoids sync issues and keeps state minimal
}

// -------------
// State Transitions
// -------------

/**
 * Defines which status transitions are legal.
 * This is enforced at compile time by the state manager.
 *
 * Key rules:
 * - Can skip to "failed" or "skipped" from any non-terminal state
 * - Terminal states (completed/failed/skipped) have no valid transitions
 * - Must progress through states in order for normal execution
 */
export const PhaseTransitions: Record<PhaseStatus, PhaseStatus[]> = {
  preparing: ["starting", "failed", "skipped"],
  starting: ["initializing", "failed", "skipped"],
  initializing: ["running", "failed", "skipped"],
  running: ["completed", "failed", "skipped"],
  completed: [], // Terminal - no transitions
  failed: [], // Terminal - no transitions
  skipped: [], // Terminal - no transitions
};

/**
 * All possible state changes in the system.
 * These are the only way to modify state - ensures consistency.
 *
 * Design: Each event captures the minimal data needed for the transition.
 * The state manager computes derived state (like totals) as needed.
 */
export type StateTransition =
  // ===== Run Lifecycle =====

  /**
   * New run started (fresh or from continuation point).
   * Creates new Run entry with starting phase.
   *
   * Triggered by: Server startup
   * State changes:
   * - Adds new run to runs array
   * - Sets currentRunId
   * - Creates git branch
   */
  | {
      type: "RunStarted";
      data: {
        runId: RunId;
        runFolder: string;
        gitBranch: string;
        startingConditions: StartingConditions;
        serverPid: number;
      };
    }

  /**
   * Run completed successfully (all phases done).
   *
   * Triggered by: Last phase completing successfully
   * State changes:
   * - Sets run.status = "completed"
   * - Sets run.endTime
   * - Clears currentRunId
   */
  | {
      type: "RunCompleted";
      data: { runId: RunId };
    }

  /**
   * Run failed (phase failed and server shutting down).
   *
   * Triggered by: Phase failure, fatal error
   * State changes:
   * - Sets run.status = "failed"
   * - Sets run.endTime
   * - Clears currentRunId
   */
  | {
      type: "RunFailed";
      data: { runId: RunId };
    }

  /**
   * Run crashed (detected on recovery).
   *
   * Triggered by: Stale lock file detection
   * State changes:
   * - Sets run.status = "crashed"
   * - Sets run.endTime
   * - Marks running phases as failed
   */
  | {
      type: "RunCrashed";
      data: {
        runId: RunId;
        detectedAt: string;
        lastPhaseStatus: PhaseStatus;
      };
    }

  // ===== Phase Lifecycle =====

  /**
   * New phase starting in current run.
   *
   * Triggered by: User command or auto-advance
   * State changes:
   * - Adds new PreparingPhase to run.phases
   * Validation: No other phase currently running
   */
  | {
      type: "PhaseStarted";
      data: {
        runId: RunId;
        phaseId: PhaseId;
      };
    }

  /**
   * Phase status changed (main state machine).
   *
   * Triggered by: Various phase lifecycle events
   * State changes:
   * - Updates phase status
   * - Sets relevant fields based on transition
   * Validation: Transition must be in PhaseTransitions map
   */
  | {
      type: "PhaseTransitioned";
      data: {
        runId: RunId;
        phaseId: PhaseId;
        from: PhaseStatus;
        to: PhaseStatus;
        metadata?: {
          // For starting → initializing
          claudePid?: number;
          claudeLogPath?: string;
          previousSessionId?: SessionId;

          // For initializing → running
          claudeSessionId?: SessionId;

          // For any → failed
          exitCode?: number;
          failureReason?: FailureReason;
          failedDuring?: PhaseStatus;

          // For any → skipped
          skippedDuring?: PhaseStatus;

          // For completing → completed
          resultMessageReceived?: boolean;

          // Checkpoint info
          checkpointSha?: string;
          checkpointBranch?: string;
        };
      };
    }

  // ===== Cost Updates =====

  /**
   * Token usage update from Claude.
   * Can happen frequently during execution.
   *
   * Triggered by: Assistant messages with usage
   * State changes:
   * - Updates currentCost/currentTokens (if running)
   * - Updates finalCost/finalTokens (if completing)
   */
  | {
      type: "CostsUpdated";
      data: {
        runId: RunId;
        phaseId: PhaseId;
        cost: number; // New total cost
        tokens: TokenUsage; // New total tokens
      };
    }

  /**
   * Incremental token usage update from Claude.
   * More resilient to race conditions than CostsUpdated.
   *
   * Triggered by: Assistant messages with usage (incremental approach)
   * State changes:
   * - Adds costDelta to currentCost (if running)
   * - Adds tokensDelta to currentTokens (if running)
   */
  | {
      type: "CostsIncremented";
      data: {
        runId: RunId;
        phaseId: PhaseId;
        costDelta: number; // The amount to add to the cost
        tokensDelta: TokenUsage; // The tokens to add to the totals
      };
    }

  // ===== Assistant Message Tracking =====

  /**
   * Assistant message count update.
   * Incremented when Claude sends a message.
   *
   * Triggered by: Assistant messages in Claude logs
   * State changes:
   * - Increments assistantMessageCount (if running/completing)
   */
  | {
      type: "AssistantMessageCountUpdated";
      data: {
        runId: RunId;
        phaseId: PhaseId;
        newCount: number; // New total count
      };
    }

  // ===== Checkpoint Events =====

  /**
   * Git checkpoint created.
   *
   * Triggered by: Workspace setup, completion, error, skip
   * State changes:
   * - Sets relevant checkpoint field in phase
   */
  | {
      type: "CheckpointCreated";
      data: {
        runId: RunId;
        phaseId: PhaseId;
        checkpointType: "workspace-setup" | "completed" | "error" | "skipped";
        sha: string;
        branch: string;
      };
    }

  /**
   * Initial checkpoint set for the project.
   *
   * Triggered by: Git repository initialization
   * State changes:
   * - Sets state.initialCheckpoint
   */
  | {
      type: "InitialCheckpointSet";
      data: {
        sha: string;
      };
    }

  /**
   * Phase final cost set from Claude's result message.
   * This ensures the authoritative cost from Claude's result message
   * is stored before the phase completes.
   *
   * Triggered by: Claude result message with final cost
   * State changes:
   * - Updates currentCost and currentTokens in running phase
   */
  | {
      type: "PhaseFinalCostSet";
      data: {
        runId: RunId;
        phaseId: PhaseId;
        finalCost: number;
        finalTokens: TokenUsage;
      };
    };

// -------------
// State Manager Interface
// -------------

/**
 * Central state management for Tadpole.
 * All state modifications go through this interface.
 *
 * Implementation notes:
 * - Single instance per server
 * - Persists to disk after each transition
 * - Validates all transitions before applying
 * - Provides type-safe queries
 */
export interface StateManager {
  // ===== Initialization =====

  /**
   * Load state from disk or create new.
   * Called once on server startup.
   *
   * Recovery logic:
   * 1. Try to load state.json
   * 2. If corrupted, try state.json.bak
   * 3. If both fail, start fresh
   * 4. Detect any crashed runs
   */
  initialize(): Promise<void>;

  /**
   * Get current state snapshot (immutable).
   * This is the primary way to read state.
   *
   * Usage: const { runs, currentRunId } = stateManager.getState();
   */
  getState(): Readonly<TadpoleState>;

  // ===== State Modifications =====

  /**
   * Apply a state transition.
   * This is the ONLY way to modify state.
   *
   * Process:
   * 1. Validate transition is legal
   * 2. Apply transition (pure function)
   * 3. Persist to disk atomically
   * 4. Emit change event
   *
   * @throws {InvalidTransitionError} if transition is invalid
   * @throws {PersistenceError} if save fails
   */
  transition(event: StateTransition): void;

  // ===== Current Run Queries =====

  /**
   * Get the currently active run.
   * @returns null if no server running
   */
  getCurrentRun(): Run | null;

  /**
   * Get the currently executing phase.
   * @returns null if between phases or no run active
   */
  getCurrentlyRunningPhase(): PhaseExecution | null;

  /**
   * Get specific phase in current run.
   * Useful for checking if phase already executed.
   *
   * @param phaseId - Phase to look for
   * @returns null if phase not found or no current run
   */
  getPhaseInCurrentRun(phaseId: PhaseId): PhaseExecution | null;

  /**
   * Determine which phase should execute next.
   * Handles both fresh runs and continuations.
   *
   * Logic:
   * - For fresh runs: First phase in config
   * - For continuations: Phase after the continuation point
   * - If all phases complete: null
   *
   * @returns null if all phases completed
   */
  getNextPhaseToExecute(): Promise<PhaseId | null>;

  // ===== Historical Queries =====

  /**
   * Get any run by ID.
   * Useful for rollback sources, history display.
   *
   * @returns null if run not found
   */
  getRun(runId: RunId): Run | null;

  // ===== Cost Queries =====

  /**
   * Calculate total cost of current run.
   * Includes all phases (successful, failed, partial).
   *
   * @returns 0 if no current run
   */
  getCurrentRunCost(): number;

  /**
   * Calculate total cost across all runs.
   * This is the "all time" cost.
   *
   * Note: Computed on demand, not stored
   */
  getTotalCost(): number;

  /**
   * Calculate cost from a specific run onwards.
   * Useful for "cost since last success" queries.
   *
   * @param runId - Starting run (inclusive)
   * @returns Total cost from that run to now
   */
  getCostSince(runId: RunId): number;

  // ===== Rollback/Continue Support =====

  /**
   * Check if we can continue from a specific point.
   * Validates that the source run and phase exist.
   *
   * @param runId - Run to continue from
   * @param afterPhase - Phase to continue after (null = from beginning)
   * @returns true if valid continuation point
   */
  canContinueFrom(runId: RunId, afterPhase: PhaseId | null): boolean;

  /**
   * Get the checkpoint SHA for a continuation point.
   * This is what git should restore to.
   *
   * @returns null if invalid continuation point
   */
  getCheckpointForContinuation(runId: RunId, afterPhase: PhaseId | null): string | null;

  // ===== Persistence Operations =====

  /**
   * Force save current state to disk.
   * Normally automatic after transitions.
   *
   * Process:
   * 1. Copy current to .bak
   * 2. Write to .tmp
   * 3. Atomic rename to state.json
   *
   * Note: fs.renameSync is atomic on POSIX systems
   */
  save(): Promise<void>;

  /**
   * Validate state file integrity.
   * Checks for corruption, invalid references, etc.
   *
   * @returns Validation results with any issues found
   */
  validate(state: unknown): StateValidation;

  // ===== Recovery Operations =====

  /**
   * Detect and mark crashed runs on startup.
   * Finds runs with status="running" but server not running.
   *
   * Side effects:
   * - Transitions crashed runs to "crashed" status
   * - Marks running phases as failed
   *
   * Recovery strategy:
   * - Check for orphaned run folders not in state
   * - Validate PIDs in lock files
   * - Handle partial state writes (check for .tmp files)
   */
  detectCrashedRuns(): Promise<void>;

  /**
   * Attempt recovery from corrupted state.
   * Last resort if both state.json and backup fail.
   *
   * Options:
   * - Start fresh (data loss)
   * - Rebuild from Claude logs (deprecated)
   *
   * @returns Recovery results
   */
  recover(): Promise<RecoveryResult>;

  /**
   * Wait for all pending transitions during shutdown
   */
  waitForPendingTransitions(): Promise<void>;
}

// Supporting types for StateManager

export interface StateValidation {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  type: "missing_run" | "invalid_phase" | "corrupted_data";
  message: string;
  context?: unknown;
}

export interface ValidationWarning {
  type: "orphaned_folder" | "missing_checkpoint" | "cost_mismatch";
  message: string;
}

export interface RecoveryResult {
  success: boolean;
  method: "backup" | "fresh" | "logs";
  dataLoss: boolean;
  message: string;
}

// -------------
// Latest Phase Info
// -------------

/**
 * Information about the latest phase execution.
 * Used to determine the current position in the workflow.
 */
export interface LatestPhaseInfo {
  /**
   * The phase execution object containing all phase details
   */
  phase: PhaseExecution;

  /**
   * Which run this phase belongs to
   */
  runId: RunId;

  /**
   * Current status of the phase (convenience field)
   */
  status: PhaseStatus;

  /**
   * The next phase that should be executed (if any).
   * null means all phases are complete or a new run is needed.
   */
  nextPhaseId: PhaseId | null;

  /**
   * Whether to continue execution in the current run.
   * false means a new run needs to be started (e.g., after rollback).
   */
  continueInCurrentRun: boolean;
}

// -------------
// Helper Functions
// -------------

/**
 * Check if a phase status is terminal (no further transitions possible)
 */
export function isTerminalPhaseStatus(status: PhaseStatus): boolean {
  return status === "completed" || status === "failed" || status === "skipped";
}

/**
 * Calculate phase cost based on its status
 */
export function getPhaseCost(phase: PhaseExecution): number {
  switch (phase.status) {
    case "completed":
      return phase.finalCost;
    case "failed":
      return phase.partialCost;
    case "skipped":
      return 0;
    case "running":
      return phase.currentCost;
    default:
      return 0;
  }
}

/**
 * Calculate phase tokens based on its status
 */
export function getPhaseTokens(phase: PhaseExecution): TokenUsage {
  switch (phase.status) {
    case "completed":
      return phase.finalTokens;
    case "failed":
      return phase.partialTokens;
    case "skipped":
      return {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      };
    case "running":
      return phase.currentTokens;
    default:
      return {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      };
  }
}

</server/types/state-types.ts>

<server/types/tool-types.ts>
/**
 * Strongly typed tool input definitions for Claude tools.
 * These match the expected input schemas for each tool.
 *
 * NOTE: This is not an exhaustive list. Claude may use additional tools
 * that are not defined here. The server handles unknown tools gracefully
 * by passing them through in events without type validation.
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

export interface TodoWriteToolInput {
  content: string;
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
  TodoWrite: TodoWriteToolInput;
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
      TodoWrite: true,
      exit_plan_mode: true,
    } as Record<ToolName, true>)
  );
}

</server/types/tool-types.ts>

<server/types/types.ts>
import type { z } from "zod";
import type { EventId, PhaseId } from "./branded-types.js";
import type { logMessageSchema } from "./claude-session-schema.js";
import type { ErrorSeverity } from "./error-types.js";
import type { PhaseExecution } from "./state-types.js";

// -------------
// Model Types
// -------------

export type ModelName = "sonnet" | "opus";

export type ContinuationMode = "fresh" | "continue-previous";

// -------------
// Process Exit Types
// -------------

export type ProcessExit =
  | { type: "success" }
  | { type: "error"; code: number }
  | { type: "killed"; signal: NodeJS.Signals };

// -------------
// Failure Reason Types
// -------------

/**
 * Represents the reason for a phase failure with retry eligibility information.
 * Used to communicate to clients whether they should consider retrying a failed phase.
 */
export interface FailureReason {
  /** The type of failure that occurred */
  type: "timeout" | "rate-limit" | "api-error" | "unknown";
  /** Whether this failure is considered retriable */
  retriable: boolean;
  /** Optional human-readable message about the failure */
  message?: string;
}

// -------------
// Message ID Types
// -------------

export type ClaudeMessageId = `msg_${string}`;
export type UUIDMessageId = string; // Keep flexible for UUIDs
export type MessageId = ClaudeMessageId | UUIDMessageId;

// -------------
// Checkpoint Status Types
// -------------

export const CHECKPOINT_STATUS = {
  WORKSPACE_SETUP: "workspace-setup",
  COMPLETED: "completed",
  ERROR: "error",
  EXIT: "exit",
  SKIPPED: "skipped",
} as const;

export type CheckpointStatus = (typeof CHECKPOINT_STATUS)[keyof typeof CHECKPOINT_STATUS];

// -------------
// Server Configuration
// -------------

/**
 * Workspace setup operation - either copy files/directories or run commands.
 */
export type WorkspaceSetupItem =
  | {
      /** Type of setup operation */
      type: "copy";
      /** For copy operations */
      copy: {
        /** Source path (relative to config file or absolute) */
        from: string;
        /**
         * Target path relative to projectPath (parent directory must exist).
         * Always specifies the full target path including name.
         * Examples:
         * - from: "../templates/foo", to: "src/foo" → copies directory foo to src/foo
         * - from: "../templates/foo", to: "src/bar" → copies directory foo as src/bar
         * - from: "../config.json", to: "src/config.json" → copies file
         * - from: "../config.json", to: "src/settings.json" → copies file with rename
         */
        to: string;
      };
    }
  | {
      /** Type of setup operation */
      type: "command";
      /** For command operations */
      command: {
        /** Shell command to execute */
        run: string;
        /** Working directory for command execution (default: "project") */
        workingDirectory: "project" | "lastCopied";
      };
    };

/**
 * Configuration for a single phase in the Tadpole workflow.
 * A phase represents a discrete task for Claude to perform, with its own
 * prompt, model settings, and optional file watching.
 */
export interface PhaseConfig {
  /** Unique identifier for this phase (e.g., "phase-1", "data-analysis") */
  id: PhaseId;

  /** Human-readable name displayed in UI and logs */
  name: string;

  /** Path to a file containing the prompt (mutually exclusive with promptText) */
  promptFile?: string | string[];

  /** Inline prompt text (mutually exclusive with promptFile) */
  promptText?: string;

  /** Path to a file containing system prompt to append (mutually exclusive with appendSystemPromptText) */
  appendSystemPromptFile?: string | string[];

  /** Inline system prompt text to append (mutually exclusive with appendSystemPromptFile) */
  appendSystemPromptText?: string;

  /** Claude model to use (e.g., "claude-3-opus-20240229", "sonnet") */
  model: ModelName;

  /**
   * How this phase should handle continuation from previous phases.
   * - "fresh": Start a new session (default for most cases)
   * - "continue-previous": Continue from the previous phase's session,
   *   maintaining context and conversation history. The previous phase must
   *   have completed successfully.
   */
  continuationMode: ContinuationMode;

  /**
   * Workspace setup operations to run before phase starts.
   * Each operation must complete successfully for phase to start.
   */
  workspaceSetup?: WorkspaceSetupItem[];

  /** Optional description shown to users about what this phase does */
  description?: string;

  /**
   * Glob patterns for files to track during phase execution.
   * These files will be:
   * - Watched for changes and streamed to the client
   * - Tracked in the git-based checkpoint system
   * - Resolved using gitignore rules for consistency
   */
  trackedFiles?: string[];

  /** Optional environment variables to set for the Claude process */
  env?: Record<string, string>;
}

/**
 * Information for creating a checkpoint commit in the shadow git repository.
 *
 * The checkpoint system creates a shadow git repo in `.tadpole/checkpoints/` that tracks
 * files matching the `checkpointAndWatch` patterns. Each checkpoint creates a commit
 * with detailed metadata about the phase state.
 */
export interface CheckpointInfo {
  /** The type of checkpoint being created */
  status: CheckpointStatus;

  /** Unique identifier of the phase (e.g., "phase-1") */
  phaseId: PhaseId;

  /** Human-readable name of the phase */
  phaseName: string;

  /** Unique identifier for this Tadpole server run */
  runId: string;

  /** ISO timestamp when the checkpoint was created */
  timestamp: string;

  /** Duration in milliseconds (only for completed/error/skipped phases) */
  duration?: number;
}

/**
 * Main server configuration containing all runtime settings.
 * Most values have defaults in config.ts except execution paths and phases.
 */
export interface ServerConfig {
  /** WebSocket server port (default: 7777) */
  port: number;

  /** Server version for client compatibility checks */
  version: string;

  /** Path to lock file preventing multiple server instances */
  lockFile: string;

  /** Path to WebSocket traffic log file */
  socketLogFile: string;

  /** Path to general server log file */
  serverLogFile: string;

  // Execution paths (from ExecutionSetup)
  /** Original data location (for reference only) */
  readOnlySourceDataPath: string;
  /** Primary directory where everything runs */
  executionPath: string;
  /** executionPath + '/data' - ONLY for setup */
  dataPathInExecutionDir: string;
  /** Hash of the data directory structure */
  dataHash: string;
  /** Whether this is a new execution */
  isNewExecution: boolean;
  /** Whether we're resuming an existing execution */
  isResuming: boolean;
  /** How data is linked (symlink or copy) */
  linkType: "symlink" | "copy";

  /** Array of phase configurations to execute */
  phases: PhaseConfig[];

  /**
   * Token cost configuration per million tokens.
   * Used to calculate costs for each phase and total project cost.
   */
  costsPerMTok: {
    /** Cost per million input tokens */
    input: number;
    /** Cost per million tokens when creating cache */
    inputCache: number;
    /** Cost per million tokens when reading from cache */
    cacheRead: number;
    /** Cost per million output tokens */
    output: number;
  };

  /** Interval in milliseconds for parsing Claude log files (default: 1000) */
  logParsingInterval: number;

  /** Optional custom base URL for Anthropic API (e.g., for proxies or gateways) */
  anthropicBaseURL?: string;

  /** Whether to automatically start phases (default: true) */
  autostart: boolean;

  /** Time limit for hashing directories in milliseconds (default: 5000) */
  dataHashTimeLimit: number;

  /** Maximum length for tool result content before truncation (default: 2500) */
  toolResultTruncateLength: number;

  /** Optional model override for all phases (ignores per-phase model settings) */
  modelOverride?: ModelName;
}

// -------------
// Internal Types
// -------------

/**
 * Token usage tracking for Claude API calls.
 * Used to calculate costs and monitor usage across phases.
 */
export interface TokenUsage {
  /** Standard input tokens processed */
  inputTokens: number;
  /** Generated output tokens */
  outputTokens: number;
  /** Tokens used to create prompt cache */
  cacheCreationTokens: number;
  /** Tokens read from existing cache */
  cacheReadTokens: number;
}

/**
 * Runtime state of an active phase - discriminated union based on execution status.
 * Makes impossible states unrepresentable (e.g., having sessionId without being running).
 */

/**
 * Represents a file or directory in the watched file tree.
 * Used to send file structure updates to clients.
 */
export type FileNode =
  | {
      /** File or directory name */
      name: string;
      /** Relative path from project root */
      path: string;
      /** This is a directory */
      isDirectory: true;
      /** Child nodes (always present for directories) */
      children: FileNode[];
    }
  | {
      /** File or directory name */
      name: string;
      /** Relative path from project root */
      path: string;
      /** This is a file */
      isDirectory: false;
      /** Last modified time (ISO string) - always present for files */
      lastModified: string;
      /** Empty array for files */
      children: FileNode[];
    };

// -------------
// Server -> Client Events
// -------------

/**
 * Sent immediately after client connection to indicate server is ready.
 * Contains basic server information for client compatibility checks.
 */
export interface ServerReadyEvent {
  /** Unique ID for this event instance */
  id: EventId;
  /** ISO 8601 timestamp of when the event was created */
  timestamp: string;
  /** Event type identifier for client-side routing */
  type: "server.ready";
  data: {
    /** Server version for compatibility checking */
    serverVersion: string;
    /** Where server/git/logs operate */
    executionPath: string;
    /** Where user data is accessible (data/ subdirectory) */
    dataPath: string;
  };
}

/**
 * Comprehensive state snapshot sent after connection and on major state changes.
 * Allows clients to sync with server state after connection or reconnection.
 */
export interface StateSnapshotEvent {
  id: EventId;
  timestamp: string;
  type: "state.snapshot";
  data: {
    /** Currently executing phase, undefined if idle */
    currentPhase: PhaseExecution | undefined;
    /** List of all terminal phases (completed, failed, skipped) in this session */
    completedPhases: PhaseExecution[];
    /** Current file tree structure (if watching files) */
    fileTree: FileNode[];
    /** Total accumulated cost across all phases in dollars */
    totalCost: number;
    /** Total time since server start in milliseconds */
    totalTime: number;
    /** Most recently accessed file information */
    recentFileAccess?:
      | {
          path: string;
          content: string;
          timestamp: Date;
        }
      | undefined;
    /** Whether the server is currently performing a rollback */
    isRollingBack: boolean;
  };
}

/**
 * Emitted when a phase begins execution.
 * Indicates Claude process has been spawned and prompt has been sent.
 */
export interface PhaseStartedEvent {
  id: EventId;
  timestamp: string;
  type: "phase.started";
  data: {
    /** ID of the phase that started */
    phaseId: string;
    /** Human-readable phase name */
    phaseName: string;
    /** Optional phase description */
    phaseDescription?: string;
    /** Claude session ID for this execution */
    sessionId: string;
    /** Previous session ID if continuing from another phase */
    previousSessionId?: string;
    /** ISO 8601 timestamp of phase start */
    startTime: string;
  };
}

/**
 * Emitted when a phase finishes execution.
 * Includes success status, costs, and timing information.
 */
export interface PhaseCompletedEvent {
  id: EventId;
  timestamp: string;
  type: "phase.completed";
  data: {
    /** ID of the completed phase */
    phaseId: string;
    /** Whether the phase completed successfully */
    success: boolean;
    /** Total cost for this phase in dollars */
    cost: number;
    /** Execution time in milliseconds */
    duration: number;
    /** Process exit status */
    exitStatus: ProcessExit;
    /** Optional failure reason for unsuccessful phases */
    failureReason?: FailureReason;
  };
}

/**
 * Real-time stream of Claude's actions during phase execution.
 * Parsed from Claude's JSON log output.
 */
export interface AssistantActionEvent {
  id: EventId;
  timestamp: string;
  type: "assistant.action";
  data: {
    /** Phase this action belongs to */
    phaseId: string;
    /** Type of action Claude is performing */
    action: "thinking" | "message" | "tool_use";
    /** Content of the action (text for messages, empty for tool use) */
    content: string;
    /** Name of tool being used (only for tool_use actions) */
    toolName?: string; // Allow any tool name, not just known ones
    /** Tool parameters (only for tool_use actions) */
    toolInput?: Record<string, unknown>;
  };
}

/**
 * Token usage update for cost tracking.
 * Emitted after each Claude message with usage information.
 */
export interface TokenUsageEvent {
  id: EventId;
  timestamp: string;
  type: "token.usage";
  data: {
    /** Phase that consumed these tokens */
    phaseId: string;
    /** Number of input tokens processed */
    inputTokens: number;
    /** Number of output tokens generated */
    outputTokens: number;
    /** Tokens used to create cache */
    cacheCreationTokens: number;
    /** Tokens read from cache */
    cacheReadTokens: number;
    /** Cost for this specific message in dollars */
    totalCost: number;
  };
}

/**
 * Tool execution result notification.
 * Emitted when a tool completes execution with its result.
 */
export interface ToolResultEvent {
  id: EventId;
  timestamp: string;
  type: "tool.result";
  data: {
    /** Phase that executed this tool */
    phaseId: string;
    /** Tool use ID for correlation */
    toolUseId: string;
    /** Name of the tool that was executed */
    toolName: string;
    /** Truncated result content */
    result: string;
    /** Whether the result was truncated */
    truncated: boolean;
    /** Original result length before truncation */
    originalLength: number;
    /** Execution time in milliseconds */
    executionTimeMs: number;
    /** Whether the tool execution resulted in an error */
    isError: boolean;
  };
}

/**
 * File change notification for watched files.
 * Only emitted for files matching the phase's watch pattern.
 */
export interface FileUpdatedEvent {
  id: EventId;
  timestamp: string;
  type: "file.updated";
  data: {
    /** Relative path from project root */
    path: string;
    /** Just the filename */
    filename: string;
    /** File contents (empty for deletions) */
    content: string;
    /** Type of file system change */
    action: "created" | "modified" | "deleted";
  };
}

/**
 * Complete file tree structure update.
 * Sent after file changes to provide updated directory structure.
 */
export interface FileTreeUpdatedEvent {
  id: EventId;
  timestamp: string;
  type: "filetree.updated";
  data: {
    /** Root nodes of the file tree */
    tree: FileNode[];
  };
}

/**
 * Error notification for both fatal and non-fatal errors.
 * Fatal errors will trigger server shutdown.
 */
export interface ErrorEvent {
  id: EventId;
  timestamp: string;
  type: "error";
  data: {
    /** Human-readable error message */
    message: string;
    /** Phase ID where error occurred (if applicable) */
    phase?: string;
    /** If true, server will shutdown after this error */
    fatal: boolean;
    /** Error severity level */
    severity?: ErrorSeverity;
    /** Additional error context */
    context?: string;
    /** Optional error code for specific error types */
    code?: string;
  };
}

/**
 * Notification of incomplete phase from previous session.
 * Helps users recover from interrupted workflows.
 */
export interface IncompletePhaseEvent {
  id: EventId;
  timestamp: string;
  type: "incomplete.phase";
  data: {
    /** ID of the incomplete phase */
    phaseId: string;
    /** Human-readable phase name */
    phaseName: string;
    /** Suggested action message */
    message: string;
  };
}

/**
 * General informational messages.
 * Used for non-error status updates.
 */
export interface InfoEvent {
  id: EventId;
  timestamp: string;
  type: "info";
  data: {
    /** Informational message */
    message: string;
  };
}

/**
 * Server idle notification
 */
export interface ServerIdleEvent {
  id: EventId;
  timestamp: string;
  type: "server.idle";
  data: {
    reason: "startup" | "phase-completed" | "all-phases-completed";
    message: string;
  };
}

/**
 * Checkpoint information for query responses
 */
export interface CheckpointQueryInfo {
  phaseId: PhaseId;
  phaseName: string;
  checkpointType: "workspace-setup" | "completed" | "error" | "skipped";
  sha: string;
  status: import("./state-types.js").PhaseStatus;
  timestamp: string;
}

/**
 * Response to checkpoint.list command
 */
export interface CheckpointListEvent {
  id: EventId;
  timestamp: string;
  type: "checkpoint.list";
  data: {
    runId: string;
    checkpoints: CheckpointQueryInfo[];
    currentBranch: string;
  };
}

/**
 * Rollback started notification
 */
export interface RollbackStartedEvent {
  id: EventId;
  timestamp: string;
  type: "rollback.started";
  data: {
    fromRun: string;
    fromPhase: string;
    toPhase: string;
    toCheckpoint: string;
    checkpointType: string;
    phasesToProcess: string[]; // Phases we'll roll back through
  };
}

/**
 * Rollback phase checkpoint notification
 */
export interface RollbackPhaseCheckpointEvent {
  id: EventId;
  timestamp: string;
  type: "rollback.phaseCheckpoint";
  data: {
    phaseId: string;
    phaseName: string;
    checkpoint: string;
    checkpointType: string;
    message: string; // e.g., "Reset to phase-2 completion checkpoint"
  };
}

/**
 * Rollback workspace cleanup notification
 */
export interface RollbackWorkspaceCleanupEvent {
  id: EventId;
  timestamp: string;
  type: "rollback.workspaceCleanup";
  data: {
    phaseId: string;
    phaseName: string;
    directories: string[];
    status: "started" | "completed" | "failed" | "partial";
    successfulCleanups?: string[];
    failedCleanups?: { directory: string; error: string }[];
    error?: string; // Overall error message
  };
}

/**
 * Rollback progress notification
 */
export interface RollbackProgressEvent {
  id: EventId;
  timestamp: string;
  type: "rollback.progress";
  data: {
    currentStep: number;
    totalSteps: number;
    message: string; // Human-readable progress message
  };
}

/**
 * Rollback completed notification
 */
export interface RollbackCompletedEvent {
  id: EventId;
  timestamp: string;
  type: "rollback.completed";
  data: {
    fromRun: string;
    toRun: string;
    checkpoint: string;
    phaseId: string;
    phaseName: string;
    checkpointType: string;
    autoRestart: boolean;
  };
}

/**
 * Discriminated union of all server-to-client event types.
 * Use this instead of the generic ServerEvent interface for better type safety.
 * TypeScript will automatically narrow the type based on the `type` field.
 */
export type ServerEvent =
  | ServerReadyEvent
  | StateSnapshotEvent
  | PhaseStartedEvent
  | PhaseCompletedEvent
  | AssistantActionEvent
  | TokenUsageEvent
  | ToolResultEvent
  | FileUpdatedEvent
  | FileTreeUpdatedEvent
  | ErrorEvent
  | IncompletePhaseEvent
  | InfoEvent
  | ServerIdleEvent
  | CheckpointListEvent
  | RollbackStartedEvent
  | RollbackPhaseCheckpointEvent
  | RollbackWorkspaceCleanupEvent
  | RollbackProgressEvent
  | RollbackCompletedEvent;

// -------------
// Client -> Server Commands
// -------------

/**
 * Start a specific phase by ID.
 * Can optionally skip pre-start commands for retry scenarios.
 */
export interface StartPhaseCommand {
  /** Unique ID for this command (for request/response correlation) */
  id: string;
  type: "phase.start";
  data: {
    /** ID of the phase to start */
    phaseId: string;
    /** If true, skip the phase's preStart command */
    skipPreCommands?: boolean;
  };
}

/**
 * Start the next phase in sequence.
 * Determines next phase based on completion history.
 */
export interface NextPhaseCommand {
  id: string;
  type: "phase.next";
}

/**
 * Skip the currently running phase.
 * Terminates the Claude process and marks phase as skipped.
 */
export interface SkipPhaseCommand {
  id: string;
  type: "phase.skip";
}

/**
 * Re-run the last completed phase.
 * Useful for retrying failed phases or regenerating outputs.
 */
export interface RedoPhaseCommand {
  id: string;
  type: "phase.redo";
}

/**
 * Gracefully shutdown the server.
 * Cleans up all resources and removes lock file.
 */
export interface ShutdownCommand {
  id: string;
  type: "server.shutdown";
}

/**
 * Force stop the current running phase.
 */
export interface ForceStopCommand {
  id: string;
  type: "phase.forceStop";
  data?: {
    /** Optional reason for force stopping */
    reason?: string;
  };
}

/**
 * List available checkpoints.
 */
export interface ListCheckpointsCommand {
  id: string;
  type: "checkpoint.list";
  data?: {
    /** Optional run ID to list checkpoints for */
    runId?: string;
  };
}

/**
 * Rollback to a specific checkpoint.
 */
export interface RollbackToCheckpointCommand {
  id: string;
  type: "rollback.toCheckpoint";
  data: {
    /** Checkpoint SHA (can be partial) */
    checkpointSha: string;
    /** Whether to auto-restart after rollback */
    autoRestart?: boolean;
  };
}

/**
 * Rollback to a phase with specific checkpoint type.
 */
export interface RollbackToPhaseCommand {
  id: string;
  type: "rollback.toPhase";
  data: {
    /** Phase ID to rollback to */
    phaseId: string;
    /** Checkpoint type within that phase */
    checkpointType: "start" | "end" | "workspace-setup" | "completed" | "error" | "skipped";
    /** Whether to auto-restart after rollback */
    autoRestart?: boolean;
  };
}

/**
 * Rollback to last successful phase.
 */
export interface RollbackToLastSuccessCommand {
  id: string;
  type: "rollback.toLastSuccess";
  data?: {
    /** Whether to auto-restart after rollback */
    autoRestart?: boolean;
  };
}

/**
 * Discriminated union of all client-to-server command types.
 * Use this instead of generic command interfaces for better type safety.
 * TypeScript will automatically narrow the type based on the `type` field.
 */
export type ClientCommand =
  | StartPhaseCommand
  | NextPhaseCommand
  | SkipPhaseCommand
  | RedoPhaseCommand
  | ShutdownCommand
  | ForceStopCommand
  | ListCheckpointsCommand
  | RollbackToCheckpointCommand
  | RollbackToPhaseCommand
  | RollbackToLastSuccessCommand;

// -------------
// Synthetic Message Types
// -------------

/**
 * Synthetic timeout message structure.
 * Claude sends these special messages when API requests time out.
 * They have a specific structure that needs special handling.
 */
export interface SyntheticTimeoutMessage {
  type: "assistant";
  message: {
    id: string;
    type: "message";
    role: "assistant";
    model: "<synthetic>";
    content: "API Error: Request timed out.";
    usage?: never;
    stop_reason: null;
    stop_sequence: null;
  };
}

/**
 * Type guard to check if an assistant message is a synthetic timeout.
 * These messages need special handling as they indicate API failures.
 */
export function isSyntheticTimeout(msg: ClaudeLogMessage): msg is SyntheticTimeoutMessage {
  return (
    msg.type === "assistant" &&
    msg.message.model === "<synthetic>" &&
    msg.message.content === "API Error: Request timed out."
  );
}

// -------------
// Claude Log Types (from claude-session-schema)
// -------------

export type ClaudeLogMessage = z.infer<typeof logMessageSchema>;

</server/types/types.ts>

<README.md>
# Tadpole Runner

Tadpole Runner is a powerful orchestration server designed to manage and execute complex, multi-step AI workflows using the Claude AI. It provides a robust, stateful environment that transforms large, ambiguous tasks into a structured sequence of manageable "phases". Through its WebSocket-based protocol, it offers real-time monitoring, interactive control, and a suite of advanced features that enable sophisticated AI-driven development and automation.

## What is Tadpole Runner?

At its core, Tadpole Runner is a bridge between your development environment and the Claude AI. It allows you to define a structured workflow in a simple JSON configuration file, and then it manages the entire lifecycle of executing that workflow. It goes far beyond simply running a series of prompts by providing a rich set of features that address the challenges of stateful, long-running AI tasks:

-   **Execution Isolation**: Tadpole runs in isolated execution directories, keeping your original project untouched. Your data is accessed via a symlink at `<execution-dir>/read_only_data_source/`, ensuring clean rollbacks and enabling multiple execution tracking.
-   **Flexible Data Sources**: You can provide either a file or a directory as your data source. Files are automatically placed in a `read_only_data_source` directory for consistent access.
-   **State Persistence**: The server meticulously records every action, decision, and outcome in the execution's `.tadpole` directory. This means you can stop the server and resume your workflow later, with all history and context perfectly preserved.
-   **Rollback System**: A shadow git repo automatically checkpoints your execution state at key moments. This allows you to instantly revert to any point in the execution history, making it easy to explore different approaches or recover from errors.
-   **Cost Tracking**: Get real-time feedback on token usage and associated costs for each phase, helping you manage your budget and optimize your prompts.
-   **Tool Result Tracking**: Monitor Claude's tool executions in real-time with detailed results, execution timing, and automatic truncation of large outputs.
-   **File Tracking**: Specify which files Claude should pay attention to. The server will monitor these files for changes, stream updates to you in real-time, and include them in checkpoints.
-   **Session Continuity**: Build complex, multi-turn conversations with Claude. A phase can be configured to "continue" from the previous one, inheriting the full conversational context.
-   **Workspace Setup**: Automate the preparation of your development environment. Before a phase starts, the server can copy template files or run shell commands (like `npm install`), ensuring Claude has everything it needs to get started.

## Installation

### Prerequisites

To use Tadpole Runner, you'll need a few things set up in your development environment:

1.  **[Bun](https://bun.sh)** (v1.0.0 or later): A fast, all-in-one JavaScript runtime and toolkit.
2.  **Git**: Required for the powerful checkpoint and rollback functionality.
3.  **[Claude CLI](https://github.com/anthropics/claude-cli)**: The underlying tool used to communicate with the Claude API. Ensure it's installed and configured with your API key.

### Setup

```bash
# 1. Clone the repository to your local machine
git clone <repository-url>
cd tadpole

# 2. Install all necessary dependencies using Bun
bun install

# 3. Test your system
bun test tests/e2e/happy-path.e2e.test.ts
```

## Quick Start

Let's walk through a simple two-phase workflow.

### 1. Create a Phase Configuration

Create a file named `phases.json` in your project root:

```json
[
  {
    "id": "phase-1-analysis",
    "name": "Phase 1: Initial Analysis",
    "promptFile": "prompts/1-analyze.md",
    "model": "sonnet",
    "continuationMode": "fresh",
    "trackedFiles": ["src/**/*.ts", "analysis.md"]
  },
  {
    "id": "phase-2-implementation",
    "name": "Phase 2: Implementation",
    "promptFile": "prompts/2-implement.md",
    "model": "sonnet",
    "continuationMode": "continue-previous",
    "trackedFiles": ["src/**/*.ts"]
  }
]
```

### 2. Create Prompt Files

Create a `prompts` directory and add the following files:

**`prompts/1-analyze.md`**:
```markdown
Please analyze the TypeScript files in the `src/` directory. Identify areas for improvement in terms of code structure, clarity, and potential bugs. Write your findings to a new file named `analysis.md`.
```

**`prompts/2-implement.md`**:
```markdown
Based on our previous discussion and the contents of `analysis.md`, please implement the suggested improvements directly into the source files.
```

### 3. Run the Server

You can run the server in two primary modes:

```bash
# For programmatic clients (e.g., a web UI)
bun run server

# For interactive use in your terminal
bun run server:basic
```

When you run in TUI mode, you'll see a live stream of events and can control the flow with keyboard shortcuts like `[n]` to advance to the next phase.

### 4. Using Different Data Sources

You can provide either a directory or a single file as your data source:

```bash
# Using a directory (default behavior)
bun run server --data=/path/to/project

# Using a single file
bun run server --data=/path/to/document.txt

# The data will be accessible at <%DATA_DIR%> in your prompts
```

## Key Concepts Explained

-   **Phases**: The building blocks of your workflow. Each phase is a self-contained task for Claude, defined by its prompt, model, and other settings.
-   **Runs**: A single, end-to-end execution of the server. A new run is created every time you start the server, and it contains the history of all phases attempted during that session.
-   **Execution Thread**: The logical, unified history of your workflow, even across multiple runs (e.g., after a rollback). It's how the server knows what the "next" step truly is.
-   **Checkpoints**: Automatic git commits in a hidden "shadow" repository that capture the state of your tracked files at critical moments, enabling the rollback feature.

## Novel Architectural Aspects

Tadpole Runner incorporates several advanced design patterns to provide its powerful feature set:

-   **Fire-and-Forget State Management**: The server uses an event-sourcing-inspired model where state changes are queued and processed asynchronously. This decouples components and ensures that state is always persisted atomically and safely.
-   **Shadow Git Repository**: By maintaining its own git repository in the `.tadpole` folder, the server can provide powerful versioning and rollback features without ever interfering with your project's own git history.
-   **Granular Phase States**: The server tracks each phase through a seven-stage lifecycle (`preparing`, `starting`, `initializing`, `running`, `completed`, `failed`, `skipped`). This provides extremely precise state tracking and error reporting.

## Documentation

Comprehensive documentation is available in the `documentation/` directory:

-   **[Architecture Overview](documentation/architecture.md)** - System design, modules, and key architectural decisions
-   **[Execution Model Guide](documentation/execution-model-guide.md)** - Deep dive into executions, data directories, symlinks, runs, and phases with formulas
-   **[Phase Configuration Guide](documentation/phase-configuration-guide.md)** - Complete guide to building phase configurations
-   **[Phase System](documentation/phase-system.md)** - Understanding phases, runs, and execution threads
-   **[Running the Server](documentation/running-the-server.md)** - Installation, setup, and command-line options
-   **[Server Protocol](documentation/server-protocol.md)** - WebSocket protocol reference for client developers
-   **[Tadpole Folder Structure](documentation/tadpole-folder-structure.md)** - Understanding the `.tadpole` directory

## Important Considerations

-   **Single Client Model**: The server is designed to be controlled by a single client at a time. When that client disconnects, the server gracefully shuts down.
-   **Atomic State Persistence**: Your workflow's history is precious. The server uses an atomic write process (write-to-temp, backup, then rename) to ensure that the `state.json` file is never corrupted, even if the server crashes mid-write.
-   **File Tracking**: Remember that only files matching the `trackedFiles` patterns in your phase configuration will be monitored for changes and included in checkpoints. This is a feature, not a limitation, as it allows you to be precise about what state you want to version.

## Troubleshooting

-   **Configuration Issues?** Run `bun run validate --config=<your-config>.json` to get a detailed analysis of your setup before you start a run.
-   **Need to Start Over?** If you want a completely clean slate, you can stop the server and safely delete the entire `.tadpole` directory. For a less destructive reset, consider the `bun server/index.ts --cleanup` command.
-   **How to Rollback?** In the Basic TUI, simply press `[r]` to open the interactive rollback menu. If you're using a programmatic client, send the `rollback.toLastSuccess` or `rollback.toCheckpoint` command.

</README.md>

<documentation/architecture.md>
# Tadpole Runner Architecture

## System Overview

Tadpole Runner is a sophisticated orchestration server designed to manage complex, multi-step AI workflows executed by the Claude AI. At its core, it is a stateful, WebSocket-based application that provides a structured environment for breaking down large tasks into discrete, manageable "phases". This architecture enables robust features such as persistent state, file tracking, cost monitoring, and a powerful git-based rollback system.

A key architectural feature is **execution isolation**: Tadpole runs in separate execution directories rather than directly in your project. This provides clean rollbacks, multiple execution tracking, and ensures your original data remains untouched. The user's data (file or directory) is accessed via a symlink or copy at `<execution-dir>/read_only_data_source/`.

### Core Design Principles

The architecture is guided by several key principles to ensure robustness, maintainability, and extensibility:

-   **Single Responsibility**: Each module and class is designed to have a clear and focused purpose, such as state management, process control, or configuration parsing. This separation of concerns makes the system easier to understand, test, and extend.

-   **Type Safety**: The entire codebase is written in TypeScript and leverages advanced features:
    - **Branded Types**: These are nominal types that prevent accidental type confusion. For example, `PhaseId` and `RunId` are both strings at runtime, but TypeScript ensures you can't accidentally pass a `RunId` where a `PhaseId` is expected:
      ```typescript
      type Branded<T, Brand> = T & { __brand: Brand };
      type PhaseId = Branded<string, "PhaseId">;
      type RunId = Branded<string, "RunId">;
      ```
    - **Discriminated Unions**: The `PhaseExecution` type uses the `status` field as a discriminator, allowing TypeScript to narrow the type and ensure type-safe access to status-specific fields:
      ```typescript
      type PhaseExecution =
        | { status: "running"; currentCost: number; /* ... */ }
        | { status: "completed"; finalCost: number; /* ... */ }
        | { status: "failed"; failureReason: FailureReason; /* ... */ }
      ```

-   **Event-Driven Communication**: Internal modules communicate through a type-safe event emitter. This decouples components and allows for flexible, asynchronous interactions. For example, the log parser emits events that the main server listens for, without the two being tightly coupled.

-   **State Immutability**: All state transitions are handled as pure functions that take the current state and an event, and return a new state object. This avoids side effects and makes state changes predictable and easy to reason about.

-   **Event Sourcing Pattern**: The state manager uses an event-sourcing-inspired approach where:
    - All state changes are represented as discrete events (`StateTransition` types)
    - Events are queued and processed sequentially
    - Each event is validated before application
    - The current state can be reconstructed by replaying events
    - All events are logged to `events.jsonl` for auditing

-   **Fail-Safe Operation**: The system is designed to be resilient. It includes mechanisms for graceful degradation (e.g., disabling checkpointing if Git is unavailable) and recovery from crashes, primarily through atomic state writes and a robust lock file mechanism.

-   **Append-Only History**: To ensure a complete and auditable trail, historical data (runs, phase executions, checkpoints) is never modified or deleted. New states are appended, preserving the full history of the workflow.

## Module Organization

The server is composed of several distinct, yet interconnected, modules.

### Entry Points & User Interfaces

-   **`server/index.ts`**: The main entry point of the application. It is responsible for parsing command-line arguments, validating the workflow configuration, instantiating the main server, and selecting the operational mode (WebSocket, TUI, etc.).
-   **`server/basic-tui.ts`**: A self-contained Terminal User Interface. It acts as a WebSocket client that connects to the server, providing a real-time, color-coded display of events and handling keyboard input for interactive control.

### The Core Orchestrator

-   **`server/tadpole-server.ts`**: This is the central nervous system of the application. The `TadpoleServer` class orchestrates all other components. Its key responsibilities include managing the WebSocket server and client connection, processing incoming commands, controlling the phase execution lifecycle, and routing events from various subsystems to the connected client.

### State Management Subsystem

-   **`server/state-manager.ts`**: This module implements a centralized, event-sourcing-inspired pattern for state management. It exposes a simple `transition()` method, which queues state change events. These events are processed sequentially, ensuring that all state modifications are validated, applied immutably, and persisted atomically to disk. It also features a cost cache for performance and crash recovery logic.
-   **`server/state-types.ts`**: This file is crucial for the system's type safety. It defines the TypeScript interfaces for the entire state tree, including the `TadpoleState`, `Run`, and the `PhaseExecution` discriminated union, which models the seven distinct states of a phase's lifecycle.
-   **`server/execution-thread.ts`**: This module contains the logic for analyzing the execution history. Its primary export, `analyzeExecutionThread`, is a powerful function that traverses the potentially branching history of runs to construct a single, logical "thread" of execution, which is used to determine the next phase to run.

### Process & Log Management

-   **`server/claude-process-manager.ts`**: This class is responsible for the entire lifecycle of the Claude CLI subprocess. It handles spawning the process with the correct arguments and environment variables, creating and managing log streams, and ensuring the process is properly monitored and cleaned up.
-   **`server/claude-log-parser.ts`**: A real-time parser for Claude's JSONL output. It reads new lines from the log file as they are written, validates them against a schema, and emits typed events for different message types (system, assistant, user, result), which the main server then processes. It now includes parsing of tool results from user messages, enabling detailed tracking of tool execution outcomes.

### Checkpoint & File System

-   **`server/checkpoint-git.ts`**: This module manages all interactions with the "shadow" git repository. It handles repository initialization, creating run-specific branches, committing changes with structured metadata, and performing hard resets for rollbacks.
-   **`server/file-resolver.ts`**: Provides a unified and consistent way to resolve file glob patterns while respecting `.gitignore` rules. This is used by both the file tracking and checkpointing systems to ensure they operate on the same set of files.

### Execution Isolation

-   **`server/execution-setup.ts`**: Manages the creation and detection of execution directories. It handles automatic execution directory creation in `~/.tadpole-executions/`, supports explicit execution paths, and manages data access via symlinks or copies. This module ensures clean separation between user data and execution artifacts. It supports both files and directories as data sources.
-   **`server/data-hasher.ts`**: Generates deterministic hashes of data sources (files or directories) to identify which executions belong to which data source. Uses time and depth limits to handle large projects efficiently while maintaining unique identification across different data sources. Files are hashed based on content and metadata.

## Data Flow and Interaction

### A Typical Phase Execution Flow

1.  **Command Reception**: A client sends a `phase.start` command over WebSocket. The `TadpoleServer` receives it and calls its internal `startPhase` method.
2.  **Phase Initialization**: `startPhase` orchestrates the setup, which includes running `workspaceSetup` commands, creating a `workspace-setup` checkpoint via `CheckpointGit`, and finally using `ClaudeProcessManager` to spawn the Claude CLI process.
3.  **Log Processing**: As the Claude process runs, it writes JSONL logs to a file. The `ClaudeLogParser` tails this file, parses new lines, and emits events (e.g., for an assistant message, tool use, or tool result).
4.  **Tool Result Tracking**: When Claude uses a tool, the server tracks the invocation. When the tool completes, Claude logs the result in a user message. The server correlates these results with their invocations, calculates execution time, and sends detailed `tool.result` events to the client.
5.  **State Updates**: The `TadpoleServer` listens for these parser events. Upon receiving one, it creates a corresponding `StateTransition` object (e.g., `CostsIncremented`) and sends it to the `StateManager`. The `StateManager` validates, applies, and persists the change.
6.  **Client Notification**: The `TadpoleServer` also transforms the parser event into a WebSocket protocol event (e.g., `assistant.action`, `tool.result`) and sends it to the client.

### The State Transition Flow

The state transition process is designed to be robust and atomic:
1.  A component calls `stateManager.transition({...})`. The transition is added to a queue.
2.  The `StateManager` processes the queue sequentially. For each transition, it first validates that the change is legal (e.g., a phase cannot transition from `running` to `initializing`).
3.  It then applies the transition by creating a deep clone of the current state and modifying it, ensuring immutability.
4.  The new state is persisted to disk using an atomic write operation (write to temp, backup old, rename).
5.  Finally, after the state is safely on disk, the `StateManager` emits a `stateChanged` event to notify other parts of the system.

## System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Client (WebSocket)                          │
└─────────────────────────────────┬───────────────────────────────────┘
                                  │
                    ┌─────────────▼─────────────┐
                    │    TadpoleServer          │
                    │  (Core Orchestrator)      │
                    └──┬──────┬──────┬──────┬──┘
                       │      │      │      │
           ┌───────────▼──┐ ┌─▼──────▼──┐ ┌─▼────────────┐ ┌─────────┐
           │StateManager  │ │ Claude    │ │CheckpointGit │ │ File    │
           │             │ │ Process   │ │              │ │Resolver │
           │ ┌─────────┐ │ │ Manager   │ │  ┌────────┐  │ └─────────┘
           │ │ State   │ │ │           │ │  │ Shadow │  │
           │ │Transition│ │ │ ┌───────┐│ │  │  Git   │  │
           │ │ Queue   │ │ │ │ Log   ││ │  │  Repo  │  │
           │ └─────────┘ │ │ │Parser ││ │  └────────┘  │
           └─────┬───────┘ │ └───────┘│ └──────────────┘
                 │         └───────────┘
         ┌───────▼────────┐
         │  state.json    │
         │ (Persistence)  │
         └────────────────┘
```

## Key Architectural Decisions

### Shadow Git Repository

Instead of interfering with the user's project git repository, the server maintains its own isolated repository in `.tadpole/checkpoints`. This provides several advantages:
-   **No Interference**: It doesn't create commits or branches in the user's repository.
-   **Complete History**: It can track files that might be in the user's `.gitignore` (e.g., build artifacts), providing a more complete snapshot of the workspace state.
-   **Clean Slate**: It starts from an empty commit, providing a reliable baseline to diff against.
-   **Branch Strategy**: Each run gets its own branch (`run-<runId>`), isolating different execution paths:
     ```
     main (initial empty commit)
       ├── run-1234-abc
       │     ├── workspace-setup: phase-1
       │     ├── completed: phase-1
       │     └── completed: phase-2
       └── run-5678-def (rollback from phase-1)
             ├── completed: phase-1 (different approach)
             └── completed: phase-2
     ```

### Fire-and-Forget State Transitions

The `StateManager.transition()` method is asynchronous in effect but synchronous in invocation ("fire-and-forget"). This decouples the components that generate state changes from the persistence logic, simplifying the codebase. A queue ensures that all transitions are processed in the correct order, preserving causality.

```
Component → transition() → Queue → Validate → Apply → Persist → Emit
                            ↑                                      │
                            └──────────────────────────────────────┘
                                     (Next transition)
```

### The Execution Thread

The concept of an Execution Thread is a solution to the complexity introduced by rollbacks. A simple linear history is not sufficient when a user can branch off from any point in the past. The thread algorithm reconstructs the *logical* sequence of events as the user perceives it, making it possible to correctly determine the "next" phase even in complex, non-linear histories.

#### Example: Rollback Scenario
```
Run 1: [Phase A] → [Phase B] → [Phase C failed]
                        ↓
                    (rollback)
                        ↓
Run 2:             [Phase B'] → [Phase C'] → [Phase D]

Execution Thread: [Phase A] → [Phase B'] → [Phase C'] → [Phase D]
                 (from Run 1)  (from Run 2 - newer versions)
```

### Execution Isolation

The server operates in isolated execution directories rather than directly in the user's project. This architectural decision provides significant benefits:

-   **Data Integrity**: The original project files remain untouched. All modifications occur in the execution directory.
-   **Clean Rollbacks**: Rollbacks affect only the execution environment, never the source data.
-   **Multiple Executions**: Track and compare different execution attempts for the same data source.
-   **Simplified Cleanup**: Remove execution artifacts without affecting the original project.

#### Directory Structure
```
~/.tadpole-executions/
├── 1737123456789-abc-d4f5e6/          # Execution directory
│   ├── read_only_data_source/         # Symlink to user's data or contains file
│   │   └── [filename.txt]             # (if data source is a file)
│   ├── generated-docs/                # Files created by Claude
│   └── .tadpole/                      # Tadpole state and metadata
│       ├── execution-meta.json
│       ├── state.json
│       └── checkpoints/
└── 1737234567890-def-d4f5e6/          # Another execution attempt
```

The system uses data hashing to identify which executions belong to which data source, enabling automatic resumption of the most recent execution or creation of new ones as needed.

</documentation/architecture.md>

<documentation/phase-system.md>
# The Tadpole Phase System: Runs, Phases, and Execution Threads

## Overview

The Tadpole phase system provides a robust framework for structuring complex AI workflows. Instead of a single, monolithic prompt, tasks are broken down into a sequence of discrete, manageable units called "phases". This modular approach enables greater control, better state management, and powerful features like context preservation and rollback. The system is built on three core concepts: Phases, Runs, and Execution Threads.

## Core Concepts

### Phase

A **Phase** is the fundamental unit of work in the Tadpole system. It represents a single, focused task for Claude to perform, defined by a configuration object in your `phases.json` file. Each phase encapsulates everything needed for its execution:

- **Identity**: A unique `id` for programmatic reference and a human-readable `name` for display.
- **Prompt**: The instructions for Claude, which can be provided as inline text (`promptText`) or loaded from one or more files (`promptFile`).
- **Model**: The specific Claude model to use:
  - `sonnet`: Claude 3.5 Sonnet - Faster and more cost-effective, ideal for most tasks
  - `opus`: Claude 3 Opus - More capable but slower and more expensive, use for complex reasoning
- **Continuation Mode**: Determines how the phase handles conversational context. It can either start a `fresh` session or `continue-previous` to maintain the dialogue from the preceding phase.
- **Workspace Setup**: An optional set of operations (copying files, running commands) that prepare the project environment before the phase begins.
- **File Tracking**: A list of glob patterns specifying which files the server should monitor for changes and include in version-control checkpoints during this phase.
- **Environment Variables**: Optional phase-specific environment variables that override system variables.

#### Complete Phase Configuration Schema

```json
{
  "id": "phase-1",                    // Required: Unique identifier
  "name": "Initial Analysis",         // Required: Human-readable name

  // Prompt (one of these required)
  "promptFile": "prompts/analyze.md", // Single file
  "promptFile": ["prompt1.md", "prompt2.md"], // Multiple files
  "promptText": "Analyze the codebase...",    // Inline text

  // Model selection
  "model": "sonnet",                  // Required: "sonnet" or "opus"

  // Conversation mode
  "continuationMode": "fresh",        // Required: "fresh" or "continue-previous"

  // Optional system prompt additions
  "appendSystemPromptFile": "system.md",       // Single file
  "appendSystemPromptFile": ["s1.md", "s2.md"], // Multiple files
  "appendSystemPromptText": "Always be concise", // Inline text

  // Optional workspace preparation
  "workspaceSetup": [
    {
      "type": "copy",
      "copy": {
        "from": "./templates/starter",  // Source path
        "to": "src"                     // Destination (relative to project)
      }
    },
    {
      "type": "command",
      "command": {
        "run": "npm install",
        "workingDirectory": "project"   // "project" or "lastCopied"
      }
    }
  ],

  // Optional file tracking
  "trackedFiles": [
    "src/**/*.ts",    // All TypeScript files in src
    "*.json",         // All JSON files in root
    "!node_modules"   // Exclude node_modules
  ],

  // Optional phase description
  "description": "Analyzes the codebase structure",

  // Optional environment variables
  "env": {
    "API_KEY": "phase-specific-key",
    "DEBUG": "true"
  }
}
```

### Run

A **Run** represents a single, complete lifecycle of the Tadpole server, from startup to shutdown. Each time you start the server, a new run is initiated. A run is not just a container for phase executions; it's a stateful entity with its own identity and history.

- **Unique Identifier**: Each run is assigned a unique ID (e.g., `1737288000000-abc12`) that is used for logging, state management, and as the basis for its dedicated git branch.
- **Git Branch**: To support the checkpoint and rollback system, each run is associated with its own branch in the shadow git repository, ensuring that the version history of different execution paths is kept isolated.
- **Parent Relationship**: Runs can be created as continuations of previous runs. This happens during a rollback or a retry, creating a parent-child relationship that allows the system to trace the complete execution history.
- **Phase Collection**: A run contains an ordered, append-only list of all the `PhaseExecution` objects that were attempted within its lifecycle.

### Execution Thread

An **Execution Thread** is a powerful, high-level abstraction that represents the logical, end-to-end sequence of phase executions, even when they span multiple runs. When you perform a rollback, you create a new run that continues from a point in a previous run. The execution thread is the mechanism that stitches these runs together to provide a coherent, unified view of the entire workflow history.

The thread is constructed by:
1.  Starting from the most recent run.
2.  Traversing its phases in reverse chronological order.
3.  When it encounters a continuation point, it jumps to the parent run and continues traversing from there.
4.  It intelligently excludes phases from the parent run that were superseded by the continuation, ensuring there are no duplicates in the logical history.
5.  Crucially, it calculates the `nextPhaseId`, which is the server's understanding of what the next logical step in the workflow should be.

## The Phase Lifecycle: A Granular State Machine

To provide maximum visibility and control, each phase execution progresses through a detailed, well-defined lifecycle. The state machine is designed to make impossible states unrepresentable and to pinpoint the exact stage of failure.

### Phase Status Progression

The normal flow of execution is a linear progression from `preparing` to `completed`. However, a phase can transition to a terminal state (`failed` or `skipped`) from any of the non-terminal states.

```
┌───────────┐     ┌──────────┐     ┌──────────────┐     ┌─────────┐     ┌───────────┐
│ preparing │ ──> │ starting │ ──> │ initializing │ ──> │ running │ ──> │ completed │
└─────┬─────┘     └────┬─────┘     └──────┬───────┘     └────┬────┘     └───────────┘
      │                 │                   │                  │
      │                 │                   │                  │           ┌─────────┐
      └─────────────────┴───────────────────┴──────────────────┴─────────> │ failed  │
      │                 │                   │                  │           └─────────┘
      │                 │                   │                  │
      └─────────────────┴───────────────────┴──────────────────┴─────────> ┌─────────┐
                                                                            │ skipped │
                                                                            └─────────┘
```

Each transition is triggered by specific events:
- `preparing → starting`: Workspace setup completed successfully
- `starting → initializing`: Claude process spawned successfully
- `initializing → running`: Received session ID from Claude
- `running → completed`: Claude process exited cleanly (code 0)
- `any → failed`: Error occurred (process crash, timeout, user force-stop)
- `any → skipped`: User requested skip

### Status Definitions

#### Non-Terminal States (The Journey)

- **`preparing`**: The server is executing the `workspaceSetup` operations for the phase, such as copying template files or running `npm install`. The Claude process has not yet been started.
- **`starting`**: The workspace is ready. The server is now spawning the Claude CLI subprocess and feeding it the prompt via stdin. A checkpoint may be created at this stage if workspace setup was performed.
- **`initializing`**: The Claude process is running, and the server is listening to its log output, waiting for the initial "init" message that contains the crucial `sessionId`.
- **`running`**: The server has received the `sessionId` and Claude is now actively working on the prompt. This is the state where most of the "thinking", tool use, and message generation occurs. Costs and file changes are actively tracked.

#### Terminal States (The Destination)

- **`completed`**: The phase finished successfully. The Claude process exited with code 0, and the server received a final "result" message. A `completion` checkpoint is created.
- **`failed`**: The phase terminated due to an error. This could be a process crash, an API timeout, a failed workspace command, or a user-initiated force stop. An `error` checkpoint may be created to capture the state at the time of failure.
- **`skipped`**: The user gracefully requested to skip the phase. The process is terminated, and a `skipped` checkpoint is created. The server can then proceed to the next phase.

## Phase Execution in Detail

### Workspace Setup
This powerful feature allows phases to configure their own environment. The server executes these steps in order:

1.  **Copy Operations**: Copies files or entire directories. A common use is to copy a starter template into the workspace.
    ```json
    {
      "type": "copy",
      "copy": {
        "from": "./templates/react-app",  // Absolute or relative to config file
        "to": "frontend"                  // Relative to project root
      }
    }
    ```

2.  **Command Execution**: Runs arbitrary shell commands. This is often used for installing dependencies (`npm install`) or running build scripts.
    - Commands are executed using the system's default shell
    - Working directory can be:
      - `"project"`: The project root directory
      - `"lastCopied"`: The destination of the most recent copy operation
    - Commands run sequentially - if one fails, subsequent commands are skipped
    - There's no timeout by default - ensure commands complete in reasonable time

    ```json
    {
      "type": "command",
      "command": {
        "run": "npm install && npm run build",
        "workingDirectory": "lastCopied"  // Run in the copied directory
      }
    }
    ```

3.  **Checkpoint Creation**: After a successful setup, a `workspace-setup` checkpoint is automatically created, capturing the exact state of the workspace before Claude begins its work.

#### Error Handling
- If a copy operation fails (source not found, permission denied), the phase transitions to `failed`
- If a command returns non-zero exit code, the phase transitions to `failed`
- The error details are captured in the `failureReason` field

### Continuation Modes

#### `fresh` Mode
This is the default mode. It starts a brand new conversation with Claude, with no memory of previous phases. Use this when:
- Starting a new logical task
- The phase doesn't depend on previous context
- You want to ensure a clean slate

#### `continue-previous` Mode
This is the key to building multi-turn, context-aware workflows. The server will find the `sessionId` from the most recent successful execution of the preceding phase and pass it to the Claude CLI. This makes Claude "remember" the entire conversation up to that point, allowing it to build upon previous work.

**Requirements for continuation:**
- The previous phase must have reached `running` state (received a session ID)
- The previous phase must have at least one assistant message
- The previous phase can be `completed` or `skipped` (if it has messages)

**Edge cases:**
- If the previous phase `failed` before receiving any messages, continuation is not possible
- If the previous phase was `skipped` immediately (no messages), continuation is not possible
- If this is the first phase in a workflow, `continue-previous` will be treated as `fresh`
- Sessions are tied to specific Claude model versions - continuation may fail if the model changes

**Example workflow using continuation:**
```json
[
  {
    "id": "analyze",
    "continuationMode": "fresh",
    "promptText": "Analyze this codebase and identify areas for improvement"
  },
  {
    "id": "implement",
    "continuationMode": "continue-previous",
    "promptText": "Now implement the improvements you suggested"
  }
]
```

### File Tracking & Checkpointing
When you specify `trackedFiles`, you are enabling two powerful features:

1.  **Live Monitoring**: The server will watch these files for any changes made by Claude's tool use and stream `file.updated` events to the client in real-time.
    - File watching uses efficient OS-level APIs
    - Changes are debounced to avoid excessive events
    - Binary files are detected but their content is not streamed

2.  **Versioning**: These are the only files that will be included in the automatic git checkpoints created by the server, ensuring that your rollbacks are precise and don't revert unrelated files.

#### Glob Pattern Support
File tracking uses standard glob patterns with some extensions:
- `*` - Matches any characters except path separators
- `**` - Matches any characters including path separators
- `?` - Matches single character
- `[abc]` - Matches any character in brackets
- `!(pattern)` - Excludes matches (e.g., `!node_modules`)
- `{a,b}` - Matches either pattern

**Examples:**
```json
"trackedFiles": [
  "src/**/*.ts",     // All TypeScript files in src (recursive)
  "*.json",          // JSON files in project root only
  "docs/**/*",       // Everything in docs directory
  "!**/*.test.ts",   // Exclude test files
  "config/*.{json,yaml}"  // JSON or YAML config files
]
```

#### .gitignore Integration
- The file tracking system respects your project's `.gitignore` file
- Files ignored by git won't be tracked even if they match your patterns
- The shadow git repository has its own independent ignore rules
- To track normally-ignored files (like build outputs), you'll need to adjust your patterns

#### Important Notes
- If no `trackedFiles` are specified, no checkpoints will be created
- Checkpoints only include files that exist and match the patterns
- Deleted files are tracked and will be restored on rollback
- Symlinks are resolved and the target files are tracked

## State Persistence and Relationships

All of this complex state is meticulously tracked and persisted in `state.json`. The `Run` objects form a tree-like structure through their `startingConditions`. A run with a `fresh` start is a root, while a run with a `continuation` start is a child of the run it continues from. This structure is what allows the **Execution Thread** to accurately reconstruct the complete, logical history of the project's development, providing the foundation for intelligent, context-aware automation.

</documentation/phase-system.md>

