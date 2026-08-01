import type { HankweaveRuntime } from "./hankweave-runtime.js";
import { isFirstSuccess, markFirstSuccess } from "./telemetry/telemetry-identity.js";
import type { BudgetSummaryData } from "./types/budget-types.js";
import type {
  CheckpointListEvent,
  ClientCommand,
  HandshakeRequest,
  HandshakeResponse,
  NextCodonCommand,
  ServerEvent,
  SkipCodonCommand,
} from "./types/types.js";
import { ClientMode } from "./types/types.js";
import { generateId, WebSocket } from "./utils.js";
import { renderBudgetSummaryTable } from "./validate-budget.js";

// ANSI color codes for terminal formatting
const COLORS = {
  // Basic colours
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
 * Controls: [n] next codon, [s] skip current, [q] quit
 *
 * Attach mode:
 * - Connect to already-running server by port
 * - Read-only: commands are disabled
 * - [q] disconnects without stopping server
 */
export class BasicTUI {
  private ws: WebSocket | null = null;
  private isConnected = false;
  private handshakeComplete = false;
  private isShuttingDown = false;
  private checkpoints: CheckpointListEvent["data"]["checkpoints"] = [];
  private waitingForCheckpoints = false;
  private attachMode: boolean;
  private port: number;
  private server: HankweaveRuntime | null;

  // Run stats accumulated from events (for shutdown summary)
  private executionPath: string | null = null;
  private agentRootPath: string | null = null;
  private outputDirectory: string | null = null;
  private runStartTime: number = Date.now();
  private codonsStarted: number = 0;
  private codonsCompleted: number = 0;
  private codonsFailed: number = 0;
  private totalCost: number = 0;
  private lastCodonId: string | null = null;
  private lastCodonFailed: boolean = false;
  private lastFailureReason: string | null = null;
  private summaryShown: boolean = false;
  private showCosts: boolean;
  private budgetSummaryData: BudgetSummaryData | null = null;

  // Activity heartbeat — shows contextual status when TUI goes quiet
  private lastOutputTime: number = Date.now();
  private activityTimer: Timer | null = null;
  private activitySeconds: number = 0;
  private isShowingActivity: boolean = false;
  private activityPhase: "idle" | "rig" | "agent" | "sentinels" = "idle";
  private activityLastHint: string | null = null;

  /**
   * Create TUI.
   * @param serverOrPort - HankweaveRuntime instance OR { port: number } for attach mode
   */
  constructor(serverOrPort: HankweaveRuntime | { port: number }) {
    this.showCosts = !!process.env.HANKWEAVE_RUNTIME_SHOW_COSTS;

    if ("port" in serverOrPort) {
      // Attach mode - connect to existing server by port
      this.attachMode = true;
      this.port = serverOrPort.port;
      this.server = null;
      console.log(`${COLORS.bold}${COLORS.cyan}Hankweave TUI - Attach Mode${COLORS.reset}`);
      console.log(
        `${COLORS.yellow}${SYMBOLS.arrow} READ-ONLY: Commands are disabled${COLORS.reset}\n`,
      );
    } else {
      // Normal mode - connect to provided runtime
      this.attachMode = false;
      this.server = serverOrPort;
      this.port = this.server.config?.port ?? 7777; // Use ?? not || (port 0 is valid but falsy)
      const version = this.server.config?.version || "unknown";
      console.log(`${COLORS.bold}${COLORS.cyan}Hankweave v${version}${COLORS.reset}\n`);
    }

    this.connectToServer();
    this.setupKeyboardInput();
  }

  private connectToServer(): void {
    const url = `ws://localhost:${this.port}`;

    console.log(`${COLORS.dim}${SYMBOLS.pipe} Connecting to ${url}...${COLORS.reset}`);

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.isConnected = true;
      console.log(`${COLORS.green}${SYMBOLS.check} Connected to server${COLORS.reset}`);
      this.performHandshake();
    };

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);

        // Check if this is a handshake response
        if (message.type === "handshake.response") {
          this.handleHandshakeResponse(message as HandshakeResponse);
          return;
        }

        // Handle regular server events
        const serverEvent = message as ServerEvent;
        // handleServerEvent is async - catch any errors to prevent unhandled rejections
        this.handleServerEvent(serverEvent).catch((error) => {
          console.error(
            `${COLORS.red}[TUI ERROR] Error handling server event ${serverEvent.type}: ${error}${COLORS.reset}`,
          );
          if (error instanceof Error && error.stack) {
            console.error(`${COLORS.red}${error.stack}${COLORS.reset}`);
          }
        });
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
      this.handshakeComplete = false;
      this.stopActivityTimer();

      // Show shutdown summary on disconnect — this ensures it's always the last
      // substantial output, even after sentinel shutdown messages.
      if (!this.summaryShown && this.codonsStarted > 0) {
        if (this.codonsFailed > 0) {
          this.showShutdownSummary("failure");
        } else if (this.isShuttingDown) {
          this.showShutdownSummary("interrupted");
        } else if (this.codonsCompleted > 0) {
          this.showShutdownSummary("success");
        }
      }

      console.log(`${COLORS.dim}${SYMBOLS.pipe} Disconnected from server${COLORS.reset}`);
      // Server shutdown will handle process exit
    };
  }

  private performHandshake(): void {
    if (!this.ws) return;

    const handshakeRequest: HandshakeRequest = {
      type: "handshake",
      data: {
        mode: ClientMode.READANDWRITE, // TUI needs write access for commands
        sendPreviousEvents: true, // Request event history for context
      },
    };

    console.log(`${COLORS.dim}${SYMBOLS.pipe} Sending handshake...${COLORS.reset}`);
    this.ws.send(JSON.stringify(handshakeRequest));
  }

  private handleHandshakeResponse(response: HandshakeResponse): void {
    this.handshakeComplete = true;
    console.log(
      `${COLORS.green}${SYMBOLS.check} Handshake complete - Mode: ${response.data.mode}, Client ID: ${response.data.clientId}${COLORS.reset}`,
    );
  }

  private formatTimestamp(timestamp: string): string {
    return `${COLORS.dim}[${new Date(timestamp).toLocaleTimeString()}]${COLORS.reset}`;
  }

  private drawBox(title: string, content: string[], color: string = COLORS.white): void {
    // Cap box width at terminal width (or 100 if not available)
    const termWidth = process.stdout.columns || 100;
    const maxBoxWidth = Math.min(termWidth, 120);

    const contentWidth = Math.max(
      title.length,
      ...content.map((line) => this.stripAnsi(line).length),
    );
    const boxWidth = Math.min(contentWidth + 4, maxBoxWidth);
    const innerWidth = boxWidth - 2; // space inside the │ borders

    // Word-wrap a single line to fit within the inner width (accounting for 1 char left padding)
    const wrapLine = (line: string): string[] => {
      const stripped = this.stripAnsi(line);
      if (stripped.length <= innerWidth - 1) return [line];

      // For lines with ANSI codes, wrap on the stripped text then re-apply
      // Simple approach: wrap the visible text, splitting on word boundaries
      const words = stripped.split(/(\s+)/);
      const lines: string[] = [];
      let current = "";
      for (const word of words) {
        if (current.length + word.length > innerWidth - 2 && current.length > 0) {
          lines.push(current);
          current = word.trimStart();
        } else {
          current += word;
        }
      }
      if (current.length > 0) lines.push(current);
      return lines;
    };

    // Top border
    console.log(`${color}┌${"─".repeat(innerWidth)}┐${COLORS.reset}`);

    // Title (truncate if needed)
    const displayTitle =
      title.length > innerWidth - 2 ? `${title.slice(0, innerWidth - 5)}...` : title;
    const titlePadding = Math.floor((innerWidth - displayTitle.length) / 2);
    console.log(
      `${color}│${" ".repeat(titlePadding)}${COLORS.bold}${displayTitle}${
        COLORS.reset
      }${color}${" ".repeat(innerWidth - titlePadding - displayTitle.length)}│${COLORS.reset}`,
    );

    // Separator
    console.log(`${color}├${"─".repeat(innerWidth)}┤${COLORS.reset}`);

    // Content (with wrapping)
    for (const line of content) {
      const wrapped = wrapLine(line);
      for (const wl of wrapped) {
        const strippedLength = this.stripAnsi(wl).length;
        const padding = Math.max(0, innerWidth - 1 - strippedLength);
        console.log(`${color}│${COLORS.reset} ${wl}${" ".repeat(padding)}${color}│${COLORS.reset}`);
      }
    }

    // Bottom border
    console.log(`${color}└${"─".repeat(innerWidth)}┘${COLORS.reset}`);
  }

  private stripAnsi(str: string): string {
    // ANSI escape sequences need control characters - this is intentional
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Required for ANSI stripping
    return str.replace(/\u001b\[[0-9;]*m/g, "");
  }

  /**
   * Format a duration in milliseconds as a human-readable string.
   */
  private formatDuration(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes < 60) return `${minutes}m ${seconds}s`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }

  /**
   * Show a shutdown summary box with run stats, paths, and next steps.
   */
  private showShutdownSummary(outcome: "success" | "failure" | "interrupted"): void {
    if (this.summaryShown) return;
    this.summaryShown = true;
    this.stopActivityTimer();

    const elapsed = this.formatDuration(Date.now() - this.runStartTime);
    const totalCodons = this.codonsStarted;
    const lines: string[] = [];

    if (outcome === "success") {
      // Happy path
      lines.push(
        `All ${this.codonsCompleted} codon${this.codonsCompleted === 1 ? "" : "s"} completed successfully in ${elapsed}.`,
      );
      lines.push("");
      if (this.showCosts) {
        lines.push(`Total cost:  ${COLORS.yellow}$${this.totalCost.toFixed(4)}${COLORS.reset}`);
      }
      if (this.agentRootPath) {
        lines.push(`Workspace:   ${this.agentRootPath}`);
      }

      // Output path — always show where to look
      lines.push("");
      lines.push(`${COLORS.bold}Look here for output files:${COLORS.reset}`);
      if (this.outputDirectory) {
        lines.push(this.outputDirectory);
      } else if (this.agentRootPath) {
        lines.push(this.agentRootPath);
      }

      // First success star nudge
      if (isFirstSuccess()) {
        markFirstSuccess();
        lines.push("");
        lines.push(`${COLORS.dim}${"─ ".repeat(35)}${COLORS.reset}`);
        lines.push(
          `If Hankweave is useful, drop a star: ${COLORS.cyan}https://github.com/SouthBridgeAI/hankweave-runtime${COLORS.reset}`,
        );
      }
    } else if (outcome === "failure") {
      // Codon failure
      lines.push(
        `Codon ${this.codonsCompleted + 1} of ${totalCodons} failed: "${this.lastCodonId}" (after ${elapsed})`,
      );
      if (this.lastFailureReason) {
        lines.push(`Reason: ${COLORS.red}${this.lastFailureReason}${COLORS.reset}`);
      }
      lines.push("");
      lines.push(
        `Completed:   ${this.codonsCompleted} of ${totalCodons} codon${totalCodons === 1 ? "" : "s"}`,
      );
      if (this.showCosts) {
        lines.push(`Cost so far: ${COLORS.yellow}$${this.totalCost.toFixed(4)}${COLORS.reset}`);
      }
      if (this.agentRootPath) {
        lines.push(`Workspace:   ${this.agentRootPath}`);
      }
      if (this.executionPath) {
        lines.push("");
        lines.push(
          `Resume:      ${COLORS.dim}hankweave --execution ${this.executionPath}${COLORS.reset}`,
        );
      }
    } else {
      // User interrupted
      lines.push(
        `Stopped by user after ${this.codonsCompleted} of ${totalCodons} codon${totalCodons === 1 ? "" : "s"} (${elapsed} elapsed).`,
      );
      if (this.showCosts) {
        lines.push(`Cost so far: ${COLORS.yellow}$${this.totalCost.toFixed(4)}${COLORS.reset}`);
      }
      if (this.agentRootPath) {
        lines.push(`Workspace:   ${this.agentRootPath}`);
      }
      if (this.executionPath) {
        lines.push("");
        lines.push(
          `Resume:      ${COLORS.dim}hankweave --execution ${this.executionPath}${COLORS.reset}`,
        );
      }
    }

    // Determine box style
    const titleMap = {
      success: `${SYMBOLS.check} Run Complete`,
      failure: `${SYMBOLS.cross} Run Failed`,
      interrupted: `${SYMBOLS.dot} Run Interrupted`,
    };
    const colorMap = {
      success: COLORS.green,
      failure: COLORS.red,
      interrupted: COLORS.yellow,
    };

    console.log(""); // blank line before summary
    this.drawBox(titleMap[outcome], lines, colorMap[outcome]);
  }

  /**
   * Start the activity heartbeat timer.
   * After 10s of no TUI output, shows a "working..." counter that updates every second.
   */
  private startActivityTimer(): void {
    this.stopActivityTimer();
    this.lastOutputTime = Date.now();
    this.activitySeconds = 0;
    this.isShowingActivity = false;

    this.activityTimer = setInterval(() => {
      const silentMs = Date.now() - this.lastOutputTime;
      const silentSec = Math.floor(silentMs / 1000);

      if (silentSec >= 10) {
        // Print a newline before the first spinner line to separate from previous output
        if (!this.isShowingActivity) {
          process.stdout.write("\n");
        }
        this.activitySeconds = silentSec;
        this.isShowingActivity = true;

        // Build context-aware spinner text
        let label: string;
        let symbol: string;
        switch (this.activityPhase) {
          case "rig":
            symbol = "⚙";
            label = "Rig running";
            break;
          case "sentinels":
            symbol = "◈";
            label = "Completing sentinels";
            break;
          case "agent":
            symbol = "◐";
            label = "Model thinking";
            break;
          default:
            symbol = SYMBOLS.dot;
            label = "Working";
            break;
        }

        const hint = this.activityLastHint
          ? ` ${COLORS.reset}${COLORS.dim}(${this.activityLastHint})`
          : "";

        // \r overwrites the current line — no newline, so it stays compact
        process.stdout.write(
          `\r${COLORS.dim}${symbol} ${label}... ${this.activitySeconds}s${hint}${COLORS.reset}  `,
        );
      }
    }, 1000);
  }

  /**
   * Reset the activity timer — called whenever the TUI prints something.
   */
  private resetActivityTimer(): void {
    if (this.isShowingActivity) {
      // Clear the "working..." line before printing new content
      process.stdout.write("\r\x1b[K"); // \r + clear line
      this.isShowingActivity = false;
    }
    this.lastOutputTime = Date.now();
    this.activitySeconds = 0;
  }

  /**
   * Stop the activity timer entirely.
   */
  private stopActivityTimer(): void {
    if (this.activityTimer) {
      clearInterval(this.activityTimer);
      this.activityTimer = null;
    }
    if (this.isShowingActivity) {
      process.stdout.write("\r\x1b[K");
      this.isShowingActivity = false;
    }
  }

  private async handleServerEvent(event: ServerEvent): Promise<void> {
    // Reset the activity timer on every event that produces output
    this.resetActivityTimer();

    const timestamp = this.formatTimestamp(event.timestamp);

    switch (event.type) {
      case "server.ready":
        // Store paths for shutdown summary
        this.executionPath = event.data.executionPath;
        this.agentRootPath = event.data.agentRootPath;
        this.outputDirectory = event.data.outputDirectory ?? null;
        this.runStartTime = Date.now();

        // Start activity heartbeat now that the server is running
        this.startActivityTimer();

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
        // totalCost can be null on early snapshots (before any codon has
        // reported usage) — this line crashed the event handler with
        // "null is not an object" in every replay run that snapshots at boot.
        if (this.showCosts && typeof event.data.totalCost === "number") {
          console.log(
            `  ${SYMBOLS.arrow} Total cost: ${
              COLORS.yellow
            }$${event.data.totalCost.toFixed(4)}${COLORS.reset}`,
          );
        }
        break;
      }

      case "codon.started": {
        this.codonsStarted++;
        this.lastCodonId = event.data.codonId;
        this.activityPhase = "agent";
        this.activityLastHint = null;
        console.log(`\n${timestamp} ${COLORS.cyan}${COLORS.bold}Codon Started${COLORS.reset}`);

        // Build info lines for the box
        const infoLines: string[] = [
          `Session: ${COLORS.dim}${event.data.sessionId}${COLORS.reset}`,
        ];

        if (event.data.previousSessionId) {
          infoLines.push(
            `Continuing from: ${COLORS.dim}${event.data.previousSessionId}${COLORS.reset}`,
          );
        }

        // Display prompt metadata from frontmatter if present
        if (event.data.promptMetadata) {
          const meta = event.data.promptMetadata;
          if (meta.name) {
            infoLines.push(`📝 Prompt: ${meta.name}`);
          }
          if (meta.description) {
            infoLines.push(`   ${COLORS.dim}${meta.description}${COLORS.reset}`);
          }
          if (meta.author) {
            infoLines.push(`   Author: ${COLORS.dim}${meta.author}${COLORS.reset}`);
          }
          if (meta.version) {
            infoLines.push(`   Version: ${COLORS.dim}${meta.version}${COLORS.reset}`);
          }
          if (meta.tags && meta.tags.length > 0) {
            infoLines.push(`   Tags: ${COLORS.dim}${meta.tags.join(", ")}${COLORS.reset}`);
          }
        }

        if (event.data.codonDescription) {
          infoLines.push(event.data.codonDescription);
        }

        this.drawBox(event.data.codonName, infoLines, COLORS.cyan);
        break;
      }

      case "codon.completed": {
        this.activityPhase = "idle";
        this.activityLastHint = null;
        // Track run stats
        if (event.data.success || event.data.failureIgnored) {
          this.codonsCompleted++;
        } else {
          this.codonsFailed++;
          this.lastCodonFailed = true;
          this.lastFailureReason = event.data.failureReason?.type ?? null;
        }
        this.totalCost += event.data.cost;
        this.lastCodonId = event.data.codonId;

        const failureIgnored = event.data.failureIgnored;
        const budgetExceeded = event.data.budgetExceeded;

        // Determine status color and symbol based on success/failure/budget/ignored
        let status: string;
        let statusSymbol: string;
        let statusText: string;

        if (budgetExceeded && event.data.success) {
          status = COLORS.yellow;
          statusSymbol = "⚠";
          statusText = "Codon Completed (budget limit)";
        } else if (failureIgnored) {
          status = COLORS.yellow;
          statusSymbol = "⚠";
          statusText = "Codon Failed (Ignored)";
        } else if (event.data.success) {
          status = COLORS.green;
          statusSymbol = SYMBOLS.check;
          statusText = "Codon Completed";
        } else {
          status = COLORS.red;
          statusSymbol = SYMBOLS.cross;
          statusText = budgetExceeded ? "Codon Failed (budget exceeded)" : "Codon Failed";
        }

        console.log(
          `\n${timestamp} ${status}${COLORS.bold}${statusText}${COLORS.reset} ${status}${statusSymbol}${COLORS.reset}`,
        );

        const details = [
          ...(this.showCosts
            ? [`Cost: ${COLORS.yellow}$${event.data.cost.toFixed(4)}${COLORS.reset}`]
            : []),
          `Duration: ${COLORS.dim}${(event.data.duration / 1000).toFixed(1)}s${COLORS.reset}`,
        ];

        if (budgetExceeded) {
          const currencyLabel =
            budgetExceeded.currency === "cost"
              ? "cost"
              : budgetExceeded.currency === "duration"
                ? "time"
                : budgetExceeded.currency === "contextTokens"
                  ? "context tokens"
                  : "output tokens";
          details.push(
            `Budget: ${COLORS.yellow}${currencyLabel} exceeded (used: ${budgetExceeded.used.toFixed(4)}, limit: ${budgetExceeded.limit.toFixed(4)})${COLORS.reset}`,
          );
          if (!event.data.success) {
            details.push(
              `${COLORS.dim}Fix: increase budget or set onExceeded: "complete" for partial output${COLORS.reset}`,
            );
          }
        }

        if (!event.data.success && event.data.failureReason && !budgetExceeded) {
          details.push(
            `Failure: ${COLORS.red}${event.data.failureReason.type}${COLORS.reset} (retriable: ${
              event.data.failureReason.retriable ? `${COLORS.green}yes` : `${COLORS.red}no`
            }${COLORS.reset})`,
          );
          if (event.data.failureReason.message) {
            details.push(
              `Message: ${COLORS.dim}${event.data.failureReason.message}${COLORS.reset}`,
            );
          }
        }

        this.drawBox(`Codon ${event.data.codonId}`, details, status);
        break;
      }

      case "codon.extended": {
        console.log(`\n${timestamp} ${COLORS.yellow}${COLORS.bold}Codon Extended${COLORS.reset}`);
        const infoLines = [
          `Extension #: ${COLORS.bold}${event.data.extensionNumber}${COLORS.reset}`,
          ...(this.showCosts
            ? [
                `Cumulative Cost: ${COLORS.yellow}$${event.data.cumulativeCost.toFixed(4)}${COLORS.reset}`,
              ]
            : []),
        ];
        this.drawBox(`Codon ${event.data.codonId}`, infoLines, COLORS.yellow);
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
          this.activityLastHint = "writing response";
        } else if (event.data.action === "thinking") {
          console.log(`\n${timestamp} ${COLORS.gray}${COLORS.italic}Thinking${COLORS.reset}`);
          // Split thinking by newlines and indent with gray
          const lines = event.data.content.split("\n");
          for (const line of lines) {
            console.log(`${COLORS.gray}${COLORS.italic}  ${SYMBOLS.pipe} ${line}${COLORS.reset}`);
          }
          this.activityLastHint = "thinking";
        } else if (event.data.action === "tool_use") {
          const toolColor = this.getToolColor(event.data.toolName || "unknown");
          console.log(`\n${timestamp} ${toolColor}Tool Use: ${event.data.toolName}${COLORS.reset}`);
          if (event.data.toolInput) {
            console.log(
              `${COLORS.dim}  ${SYMBOLS.arrow} Input: ${JSON.stringify(
                event.data.toolInput,
                null,
                2,
              ).replace(/\n/g, "\n    ")}${COLORS.reset}`,
            );
          }
          this.activityLastHint = `after ${event.data.toolName}`;
        }
        this.activityPhase = "agent";
        break;
      }

      case "tool.result": {
        this.activityLastHint = `after ${event.data.toolName}`;
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
            `${COLORS.dim}  ${
              SYMBOLS.arrow
            } Result: ${event.data.result.substring(0, 200)}...${COLORS.reset}`,
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
        if (this.showCosts) {
          console.log(
            `  ${SYMBOLS.arrow} Cost: ${
              COLORS.yellow
            }$${event.data.totalCost.toFixed(4)}${COLORS.reset}`,
          );
        }
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
            ...(event.data.codon ? [`Codon: ${event.data.codon}`] : []),
            ...(event.data.code ? [`Code: ${event.data.code}`] : []),
            `Fatal: ${event.data.fatal ? `${COLORS.red}yes` : `${COLORS.green}no`}${COLORS.reset}`,
          ],
          COLORS.red,
        );
        break;
      }

      case "incomplete.codon": {
        console.log(
          `\n${timestamp} ${COLORS.yellow}${COLORS.bold}Incomplete Codon Detected${COLORS.reset}`,
        );
        console.log(`  ${SYMBOLS.arrow} Codon: ${event.data.codonName}`);
        console.log(`  ${SYMBOLS.arrow} ${event.data.message}`);
        break;
      }

      case "info": {
        const message = event.data.message;
        // Highlight rig setup events with specific styling
        // MESSAGE FORMAT CONTRACT: Uses string matching on specific phrases
        if (message.includes("All codons completed successfully")) {
          // Show a brief one-liner now; the full summary box prints on disconnect
          // (after sentinel shutdown output finishes, so it's always the last thing)
          const elapsed = this.formatDuration(Date.now() - this.runStartTime);
          const costSuffix = this.showCosts ? `$${this.totalCost.toFixed(4)}, ` : "";
          console.log(
            `\n${timestamp} ${COLORS.green}${COLORS.bold}${SYMBOLS.check} All ${this.codonsCompleted} codon${this.codonsCompleted === 1 ? "" : "s"} completed${COLORS.reset} ${COLORS.dim}(${costSuffix}${elapsed})${COLORS.reset}`,
          );
        } else if (message.includes("Rig setup started")) {
          this.activityPhase = "rig";
          this.activityLastHint = null;
          console.log(`\n${timestamp} ${COLORS.yellow}${SYMBOLS.arrow} ${message}${COLORS.reset}`);
        } else if (message.includes("Rig setup completed")) {
          const isSuccess = !message.includes("failed");
          const color = isSuccess ? COLORS.green : COLORS.yellow;
          const symbol = isSuccess ? SYMBOLS.check : SYMBOLS.dot;
          console.log(`${timestamp} ${color}${symbol} ${message}${COLORS.reset}`);
        } else if (message.includes("Rig operation")) {
          console.log(`${timestamp} ${COLORS.dim}  ${SYMBOLS.pipe} ${message}${COLORS.reset}`);
        } else if (message.includes("Completing work for") && message.includes("sentinel")) {
          this.activityPhase = "sentinels";
          this.activityLastHint = null;
          console.log(`\n${timestamp} ${COLORS.blue}Info${COLORS.reset}: ${message}`);
        } else {
          console.log(`\n${timestamp} ${COLORS.blue}Info${COLORS.reset}: ${message}`);
        }
        break;
      }

      case "budget.summary": {
        this.budgetSummaryData = event.data as BudgetSummaryData;
        // Render immediately — the shutdown summary in onclose may not fire
        // if the server stops before the close frame is processed.
        const useColor = process.stdout.isTTY ?? false;
        const terminalWidth = process.stdout.columns ?? 80;
        const table = renderBudgetSummaryTable({
          summary: this.budgetSummaryData,
          terminalWidth,
          useColor,
          showCosts: this.showCosts,
        });
        console.log(table);
        break;
      }

      case "server.idle": {
        const reason = event.data.reason as string;

        // Build contextual command hints based on why we're idle
        const hints: string[] = [];
        if (reason === "rollback-completed" || reason === "codon-completed") {
          hints.push(`${COLORS.cyan}[n]${COLORS.reset} start next codon`);
          hints.push(`${COLORS.cyan}[r]${COLORS.reset} rollback`);
          hints.push(`${COLORS.cyan}[q]${COLORS.reset} quit`);
        } else if (reason === "all-codons-completed") {
          hints.push(`${COLORS.cyan}[r]${COLORS.reset} rollback to re-run`);
          hints.push(`${COLORS.cyan}[q]${COLORS.reset} quit`);
        } else {
          // startup or unknown
          hints.push(`${COLORS.cyan}[n]${COLORS.reset} start next codon`);
          hints.push(`${COLORS.cyan}[l]${COLORS.reset} list checkpoints`);
          hints.push(`${COLORS.cyan}[q]${COLORS.reset} quit`);
        }

        this.drawBox(
          "Waiting for Input",
          [
            event.data.message,
            "",
            `${COLORS.bold}Available commands:${COLORS.reset}  ${hints.join("  ")}`,
          ],
          COLORS.yellow,
        );
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
                  `[${COLORS.bold}${index + 1}${COLORS.reset}] ${
                    cp.codonName
                  } ${COLORS.dim}(${cp.checkpointType})${COLORS.reset} ${
                    COLORS.gray
                  }${cp.sha.substring(0, 7)}${COLORS.reset}`,
              ),
              COLORS.magenta,
            );
          }
        }
        break;
      }

      case "rollback.started": {
        console.log(`\n${timestamp} ${COLORS.yellow}${COLORS.bold}Rollback Started${COLORS.reset}`);
        console.log(`  ${SYMBOLS.arrow} From: ${event.data.fromCodon} (run ${event.data.fromRun})`);
        console.log(`  ${SYMBOLS.arrow} To: ${event.data.toCodon} (${event.data.checkpointType})`);
        console.log(`  ${SYMBOLS.arrow} Processing ${event.data.codonsToProcess.length} codons`);
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

      case "rollback.codonCheckpoint": {
        console.log(`\n${timestamp} ${COLORS.cyan}Checkpoint Applied${COLORS.reset}`);
        console.log(`  ${SYMBOLS.arrow} ${event.data.message}`);
        break;
      }

      case "rollback.rigCleanup": {
        const statusColor =
          event.data.status === "completed"
            ? COLORS.green
            : event.data.status === "failed"
              ? COLORS.red
              : event.data.status === "partial"
                ? COLORS.yellow
                : COLORS.blue;
        console.log(
          `\n${timestamp} ${statusColor}Rig Cleanup: ${event.data.status}${COLORS.reset}`,
        );
        console.log(`  ${SYMBOLS.arrow} Codon: ${event.data.codonName}`);
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
            `Codon: ${event.data.codonName} (${event.data.checkpointType})`,
            `Checkpoint: ${COLORS.gray}${event.data.checkpoint.substring(0, 7)}${COLORS.reset}`,
          ],
          COLORS.green,
        );
        break;
      }

      // Sentinel Events
      case "sentinel.loaded": {
        console.log(`\n${timestamp} ${COLORS.magenta}${COLORS.bold}Sentinel Loaded${COLORS.reset}`);
        this.drawBox(
          `Sentinel: ${event.data.sentinelId}`,
          [
            `Codon: ${COLORS.dim}${event.data.codonId}${COLORS.reset}`,
            `Model: ${COLORS.dim}${event.data.model}${COLORS.reset}`,
            `Trigger: ${COLORS.cyan}${event.data.triggerType}${COLORS.reset}`,
            `Strategy: ${COLORS.cyan}${event.data.executionStrategy}${COLORS.reset}`,
            `Source: ${COLORS.dim}${event.data.source}${event.data.sourcePath ? ` (${event.data.sourcePath.split("/").pop()})` : ""}${COLORS.reset}`,
          ],
          COLORS.magenta,
        );
        break;
      }

      case "sentinel.unloaded": {
        const reasonColor =
          event.data.reason === "fatal-error" || event.data.reason === "consecutive-failures"
            ? COLORS.red
            : COLORS.dim;
        console.log(
          `\n${timestamp} ${reasonColor}Sentinel Unloaded${COLORS.reset}: ${COLORS.bold}${event.data.sentinelId}${COLORS.reset}`,
        );
        console.log(`  ${SYMBOLS.arrow} Reason: ${event.data.reason}`);
        if (this.showCosts) {
          console.log(
            `  ${SYMBOLS.arrow} Final Cost: ${COLORS.yellow}$${event.data.finalCost.toFixed(6)}${COLORS.reset}`,
          );
        }
        console.log(`  ${SYMBOLS.arrow} LLM Calls: ${event.data.llmCallCount}`);
        break;
      }

      case "sentinel.triggered": {
        console.log(
          `\n${timestamp} ${COLORS.dim}${COLORS.italic}Sentinel Triggered: ${event.data.sentinelId} (#${event.data.triggerNumber}, ${event.data.eventCount} events)${COLORS.reset}`,
        );
        break;
      }

      case "sentinel.output": {
        // Split text content on newlines so each line gets proper box borders.
        // Without this, embedded \n in LLM responses breaks the │ ... │ structure.
        const outputContent =
          event.data.outputType === "structured"
            ? JSON.stringify(event.data.content, null, 2).split("\n")
            : (event.data.content as string).split("\n");

        this.drawBox(
          `Sentinel Output: ${event.data.sentinelId}`,
          [
            ...outputContent,
            ...(this.showCosts
              ? [
                  `${COLORS.dim}${"─".repeat(20)}${COLORS.reset}`,
                  `Cost: ${COLORS.yellow}$${event.data.cost.toFixed(6)}${COLORS.reset}`,
                  `Tokens: ${COLORS.dim}(in: ${event.data.tokens.input}, out: ${event.data.tokens.output})${COLORS.reset}`,
                ]
              : []),
          ],
          COLORS.green,
        );
        break;
      }

      case "sentinel.error": {
        console.log(`\n${timestamp} ${COLORS.red}${COLORS.bold}Sentinel Error${COLORS.reset}`);
        this.drawBox(
          `Sentinel Error: ${event.data.sentinelId}`,
          [
            `Type: ${COLORS.yellow}${event.data.errorType}${COLORS.reset}`,
            `Message: ${event.data.message}`,
            `Retriable: ${event.data.retriable ? "yes" : "no"}`,
            `Consecutive Failures: ${event.data.consecutiveFailureCount}`,
          ],
          COLORS.red,
        );
        break;
      }

      // Silent handlers for internal/protocol events
      case "rig.setup.completed": {
        const durationSec = (event.data.durationMs / 1000).toFixed(1);
        console.log(
          `${timestamp} ${COLORS.green}${SYMBOLS.check} Rig setup completed${COLORS.reset} ${COLORS.dim}(${event.data.commandCount} command${event.data.commandCount === 1 ? "" : "s"}, ${durationSec}s)${COLORS.reset}`,
        );
        this.activityPhase = "agent";
        this.activityLastHint = null;
        break;
      }

      case "rig.setup.failed": {
        const ignored = event.data.ignored;
        const color = ignored ? COLORS.yellow : COLORS.red;
        const symbol = ignored ? SYMBOLS.dot : SYMBOLS.cross;
        const suffix = ignored ? " (ignored)" : "";
        console.log(
          `${timestamp} ${color}${symbol} Rig setup failed: ${event.data.failureType}${suffix}${COLORS.reset}`,
        );
        break;
      }

      case "rig.output": {
        const line = event.data.line;
        const streamColor = event.data.stream === "stderr" ? COLORS.yellow : COLORS.dim;
        console.log(`${timestamp} ${streamColor}  ${SYMBOLS.pipe} ${line}${COLORS.reset}`);
        this.activityLastHint = line.slice(0, 60);
        break;
      }

      case "state.transition":
        // Internal state event, too noisy for TUI
        break;

      case "history.batch":
        // Protocol-level event for client sync, not relevant for TUI display
        break;

      case "pong":
        // Response to a ping, not user-facing
        break;

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

    if (!this.handshakeComplete) {
      console.error(`${COLORS.red}${SYMBOLS.cross} Handshake not complete${COLORS.reset}`);
      return;
    }

    this.ws.send(JSON.stringify(command));
  }

  private setupKeyboardInput(): void {
    console.log(`\n${COLORS.bold}Commands:${COLORS.reset}`);
    console.log(`  ${COLORS.cyan}[n]${COLORS.reset} next codon`);
    console.log(`  ${COLORS.cyan}[s]${COLORS.reset} skip current`);
    console.log(`  ${COLORS.cyan}[f]${COLORS.reset} force stop`);
    console.log(`  ${COLORS.cyan}[l]${COLORS.reset} list checkpoints`);
    console.log(`  ${COLORS.cyan}[r]${COLORS.reset} rollback menu`);
    console.log(`  ${COLORS.cyan}[q]${COLORS.reset} quit\n`);

    const stdin = process.stdin;

    if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
      console.warn(
        `${COLORS.yellow}! Keyboard input disabled: interactive mode requires a TTY${COLORS.reset}`,
      );
      return;
    }

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    stdin.on("data", async (key: string) => {
      try {
        // Handle commands - some are blocked in attach mode
        switch (key) {
          case "n":
            if (this.attachMode) {
              console.log(
                `\n${COLORS.yellow}${SYMBOLS.cross} Read-only mode: command 'n' not available${COLORS.reset}`,
              );
              break;
            }
            console.log(
              `\n${COLORS.cyan}${SYMBOLS.arrow} Advancing to next codon...${COLORS.reset}`,
            );
            this.sendCommand({
              id: generateId(),
              type: "codon.next",
            } as NextCodonCommand);
            break;

          case "s":
            if (this.attachMode) {
              console.log(
                `\n${COLORS.yellow}${SYMBOLS.cross} Read-only mode: command 's' not available${COLORS.reset}`,
              );
              break;
            }
            console.log(
              `\n${COLORS.yellow}${SYMBOLS.arrow} Skipping current codon...${COLORS.reset}`,
            );
            this.sendCommand({
              id: generateId(),
              type: "codon.skip",
            } as SkipCodonCommand);
            break;

          case "f":
            if (this.attachMode) {
              console.log(
                `\n${COLORS.yellow}${SYMBOLS.cross} Read-only mode: command 'f' not available${COLORS.reset}`,
              );
              break;
            }
            console.log(
              `\n${COLORS.red}${SYMBOLS.arrow} Force stopping current codon...${COLORS.reset}`,
            );
            this.sendCommand({
              id: generateId(),
              type: "codon.forceStop",
              data: { reason: "User requested from TUI" },
            } as ClientCommand);
            break;

          case "l":
            // Read-only safe - just lists checkpoints
            console.log(
              `\n${COLORS.magenta}${SYMBOLS.arrow} Requesting checkpoint list...${COLORS.reset}`,
            );
            this.sendCommand({
              id: generateId(),
              type: "checkpoint.list",
            });
            break;

          case "r":
            if (this.attachMode) {
              console.log(
                `\n${COLORS.yellow}${SYMBOLS.cross} Read-only mode: command 'r' not available${COLORS.reset}`,
              );
              break;
            }
            await this.showRollbackMenu();
            break;

          case "q":
          case "\u0003": // Ctrl+C
            if (this.attachMode) {
              // Attach mode: just disconnect without stopping server
              console.log(`\n${COLORS.dim}${SYMBOLS.arrow} Disconnecting...${COLORS.reset}`);
              if (this.ws) {
                this.ws.close();
              }
              process.exit(0);
            } else if (this.isShuttingDown) {
              // Already shutting down — force quit immediately
              console.log(`\n${COLORS.red}${SYMBOLS.arrow} Force quitting...${COLORS.reset}`);
              this.server?.forceShutdown("user force request");
            } else {
              // Normal mode: initiate graceful shutdown
              this.isShuttingDown = true;
              console.log(
                `\n${COLORS.dim}${SYMBOLS.arrow} Shutting down... (press q again to force quit)${COLORS.reset}`,
              );
              if (this.executionPath) {
                console.log(
                  `${COLORS.dim}${SYMBOLS.arrow} Resume with: hankweave --execution ${this.executionPath}${COLORS.reset}`,
                );
              }
              if (this.ws) {
                this.ws.close();
              }
              this.server?.shutdown("user request");
            }
            break;
        }
      } catch (error) {
        console.error(`${COLORS.red}[TUI ERROR] Keyboard handler error: ${error}${COLORS.reset}`);
        if (error instanceof Error && error.stack) {
          console.error(`${COLORS.red}${error.stack}${COLORS.reset}`);
        }
      }
    });
  }

  /**
   * Show interactive rollback menu
   */
  private async showRollbackMenu(): Promise<void> {
    console.log(`\n${COLORS.yellow}${COLORS.bold}Rollback Options${COLORS.reset}`);
    console.log(`  ${COLORS.cyan}[1]${COLORS.reset} Rollback to last successful codon`);
    console.log(`  ${COLORS.cyan}[2]${COLORS.reset} List checkpoints and select`);
    console.log(`  ${COLORS.cyan}[c]${COLORS.reset} Cancel`);

    const response = await this.waitForKey();

    switch (response) {
      case "1":
        await this.confirmAndRollback("last successful codon", async () => {
          this.sendCommand({
            id: generateId(),
            type: "rollback.toLastSuccess",
            data: { autoRestart: true },
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
    try {
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
      const responseStr = typeof response === "string" ? response : String(response);

      if (responseStr === "y" || responseStr === "Y") {
        console.log(`\n${COLORS.dim}${SYMBOLS.arrow} Initiating rollback...${COLORS.reset}`);
        await action();
      } else {
        console.log(`\n${COLORS.red}${SYMBOLS.cross} Rollback cancelled${COLORS.reset}`);
      }
    } catch (error) {
      console.error(
        `${COLORS.red}[TUI ERROR] Rollback confirmation error: ${error}${COLORS.reset}`,
      );
      if (error instanceof Error && error.stack) {
        console.error(`${COLORS.red}${error.stack}${COLORS.reset}`);
      }
    }
  }

  /**
   * Show interactive checkpoint selection menu
   */
  private async showCheckpointSelection(data: CheckpointListEvent["data"]): Promise<void> {
    try {
      if (!data || !data.checkpoints || data.checkpoints.length === 0) {
        console.log(`\n${COLORS.red}${SYMBOLS.cross} No checkpoints found${COLORS.reset}`);
        return;
      }

      console.log(
        `\n${COLORS.magenta}${COLORS.bold}Select Checkpoint to Rollback To${COLORS.reset}`,
      );
      console.log(
        `${COLORS.dim}(${data.checkpoints.length} checkpoints, most recent first → oldest last)${COLORS.reset}`,
      );
      console.log(
        `${COLORS.yellow}${COLORS.bold}NOTE:${COLORS.reset} ${COLORS.yellow}Lower numbers = more recent, Higher numbers = older${COLORS.reset}\n`,
      );

      const checkpointLines = data.checkpoints.flatMap((cp, index) => {
        // Defensive checks for checkpoint data
        const codonName = cp?.codonName || "Unknown";
        const checkpointType = cp?.checkpointType || "unknown";
        const sha = cp?.sha || "????????";
        const timestamp = cp?.timestamp ? new Date(cp.timestamp).toLocaleTimeString() : "unknown";

        // Add visual indicator for position
        const positionLabel =
          index === 0
            ? `${COLORS.green}(most recent)${COLORS.reset}`
            : index === data.checkpoints.length - 1
              ? `${COLORS.yellow}(oldest)${COLORS.reset}`
              : "";

        return [
          `${COLORS.cyan}[${index + 1}]${COLORS.reset} ${COLORS.bold}${codonName}${COLORS.reset} - ${checkpointType} (${timestamp}) ${positionLabel}`,
          `    SHA: ${COLORS.gray}${sha.substring(0, 7)}...${COLORS.reset}`,
        ];
      });

      checkpointLines.push(`${COLORS.cyan}[c]${COLORS.reset} Cancel`);

      this.drawBox("Available Checkpoints", checkpointLines, COLORS.magenta);
      console.log(`\n${COLORS.bold}Enter checkpoint number to rollback to:${COLORS.reset} `);

      // Use line input for multi-digit checkpoint numbers
      const response = await this.waitForLine();

      if (response === "c" || response === "C") {
        console.log(`\n${COLORS.red}${SYMBOLS.cross} Rollback cancelled${COLORS.reset}`);
        return;
      }

      const choice = parseInt(response, 10);
      if (Number.isNaN(choice) || choice < 1 || choice > data.checkpoints.length) {
        console.log(
          `\n${COLORS.red}${SYMBOLS.cross} Invalid selection: "${response}"${COLORS.reset}`,
        );
        return;
      }

      const selectedCheckpoint = data.checkpoints[choice - 1];

      // Defensive check for selected checkpoint
      if (!selectedCheckpoint) {
        console.log(
          `\n${COLORS.red}${SYMBOLS.cross} Error: Could not find checkpoint at index ${choice - 1}${COLORS.reset}`,
        );
        return;
      }

      if (!selectedCheckpoint.sha) {
        console.log(
          `\n${COLORS.red}${SYMBOLS.cross} Error: Selected checkpoint has no SHA${COLORS.reset}`,
        );
        return;
      }

      const target = `${selectedCheckpoint.codonName || "Unknown"} (${selectedCheckpoint.checkpointType || "unknown"})`;

      await this.confirmAndRollback(target, async () => {
        this.sendCommand({
          id: generateId(),
          type: "rollback.toCheckpoint",
          data: {
            checkpointSha: selectedCheckpoint.sha,
            autoRestart: true,
          },
        } as ClientCommand);
      });
    } catch (error) {
      console.error(`${COLORS.red}[TUI ERROR] Checkpoint selection error: ${error}${COLORS.reset}`);
      if (error instanceof Error && error.stack) {
        console.error(`${COLORS.red}${error.stack}${COLORS.reset}`);
      }
    }
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

  /**
   * Wait for a line of input (until Enter is pressed)
   * Used for multi-digit checkpoint selection
   *
   * Note: Accumulates characters in raw mode instead of using readline
   * to avoid mode-switching issues in Bun runtime.
   */
  private waitForLine(): Promise<string> {
    return new Promise((resolve) => {
      let buffer = "";

      const handler = (key: string) => {
        // Handle Enter key (CR or LF)
        if (key === "\r" || key === "\n") {
          process.stdin.removeListener("data", handler);
          console.log(); // Move to next line
          resolve(buffer.trim());
          return;
        }

        // Handle backspace
        if (key === "\x7f" || key === "\b") {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            // Move cursor back, overwrite with space, move back again
            process.stdout.write("\b \b");
          }
          return;
        }

        // Handle Ctrl+C
        if (key === "\x03") {
          process.stdin.removeListener("data", handler);
          console.log();
          resolve("c"); // Treat as cancel
          return;
        }

        // Handle Escape
        if (key === "\x1b") {
          process.stdin.removeListener("data", handler);
          console.log();
          resolve("c"); // Treat as cancel
          return;
        }

        // Ignore other control characters
        if (key.charCodeAt(0) < 32) {
          return;
        }

        // Accumulate printable characters
        buffer += key;
        process.stdout.write(key);
      };

      process.stdin.on("data", handler);
    });
  }
}
