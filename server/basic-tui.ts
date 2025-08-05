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
    return str.replace(/\x1b\[[0-9;]*m/g, "");
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
            `Failure: ${COLORS.red}${event.data.failureReason.type}${COLORS.reset} (retriable: ${event.data.failureReason.retriable ? COLORS.green + "yes" : COLORS.red + "no"}${COLORS.reset})`,
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
            `Fatal: ${event.data.fatal ? COLORS.red + "yes" : COLORS.green + "no"}${COLORS.reset}`,
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

      default:
        // Show all unknown events for debugging
        console.log(
          `\n${timestamp} ${COLORS.gray}Unknown Event: ${(event as any).type}${COLORS.reset}`,
        );
        console.log(
          `${COLORS.dim}${JSON.stringify("data" in event ? (event as any).data : {}, null, 2)}${COLORS.reset}`,
        );
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
