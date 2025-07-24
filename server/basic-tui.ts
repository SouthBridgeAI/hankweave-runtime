import type { LangtonServer } from "./langton-server.js";
import type {
  CheckpointListEvent,
  ClientCommand,
  NextPhaseCommand,
  ServerEvent,
  SkipPhaseCommand,
} from "./types.js";
import { generateId } from "./utils.js";

/**
 * Basic Terminal UI for testing and debugging the server.
 *
 * Provides:
 * - WebSocket client that connects to the server
 * - Real-time event display in the terminal
 * - Keyboard shortcuts for common commands
 * - Colored output for different event types
 *
 * Usage: Run server with --basic flag
 * Controls: [n] next phase, [s] skip current, [q] quit
 */
export class BasicTUI {
  private ws: WebSocket | null = null;
  private isConnected = false;
  private checkpoints: CheckpointListEvent["data"]["checkpoints"] = [];
  private waitingForCheckpoints = false;

  constructor(private server: LangtonServer) {
    this.connectToServer();
    this.setupKeyboardInput();
  }

  private connectToServer(): void {
    const port = this.server.config?.port || 7777;
    const url = `ws://localhost:${port}`;

    console.log(`🔌 Connecting to ${url}...`);

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.isConnected = true;
      console.log("✅ Connected to server");
    };

    this.ws.onmessage = (event) => {
      try {
        const serverEvent = JSON.parse(event.data) as ServerEvent;
        this.handleServerEvent(serverEvent);
      } catch (error) {
        console.error("❌ Failed to parse server message:", error);
      }
    };

    this.ws.onerror = (error) => {
      console.error("❌ WebSocket error:", error);
    };

    this.ws.onclose = () => {
      this.isConnected = false;
      console.log("🔌 Disconnected from server");
      // Server shutdown will handle process exit
    };
  }

  private async handleServerEvent(event: ServerEvent): Promise<void> {
    const timestamp = new Date(event.timestamp).toLocaleTimeString();

    switch (event.type) {
      case "server.ready":
        console.log(`\n🚀 [${timestamp}] Server ready!`);
        break;

      case "state.snapshot": {
        console.log(`\n📸 [${timestamp}] State snapshot received`);
        if (event.data.recentFileAccess) {
          console.log(`   Recent file: ${event.data.recentFileAccess.path}`);
        }
        console.log(`   Total cost: $${event.data.totalCost.toFixed(4)}`);
        break;
      }

      case "phase.started": {
        console.log(`\n📋 [${timestamp}] Started: ${event.data.phaseName}`);
        console.log(`   Session ID: ${event.data.sessionId}`);
        if (event.data.previousSessionId) {
          console.log(`   Continuing from: ${event.data.previousSessionId}`);
        }
        if (event.data.phaseDescription) {
          console.log(`   ${event.data.phaseDescription}`);
        }
        break;
      }

      case "phase.completed": {
        const status = event.data.success ? "✅" : "❌";
        console.log(`\n${status} [${timestamp}] Completed: Phase ${event.data.phaseId}`);
        console.log(
          `   Cost: $${event.data.cost.toFixed(4)}, Duration: ${(
            event.data.duration / 1000
          ).toFixed(1)}s`,
        );

        if (!event.data.success && event.data.failureReason) {
          console.log(
            `   Failure: ${event.data.failureReason.type} (retriable: ${event.data.failureReason.retriable})`,
          );
          if (event.data.failureReason.message) {
            console.log(`   Message: ${event.data.failureReason.message}`);
          }
        }
        break;
      }

      case "assistant.action": {
        if (event.data.action === "message") {
          console.log(`\n💬 [${timestamp}] ${event.data.content}`);
        } else if (event.data.action === "thinking") {
          console.log(`\n🤔 [${timestamp}] Thinking: ${event.data.content}`);
        } else if (event.data.action === "tool_use") {
          console.log(`\n🔧 [${timestamp}] Using tool: ${event.data.toolName}`);
        }
        break;
      }

      case "token.usage": {
        console.log(`\n📊 [${timestamp}] Tokens used - Cost: $${event.data.totalCost.toFixed(4)}`);
        break;
      }

      case "file.updated": {
        console.log(`\n📄 [${timestamp}] File ${event.data.action}: ${event.data.path}`);
        break;
      }

      case "filetree.updated": {
        console.log(`\n🌲 [${timestamp}] File tree updated (${event.data.tree.length} root items)`);
        break;
      }

      case "error": {
        console.error(`\n❌ [${timestamp}] Error: ${event.data.message}`);
        break;
      }

      case "incomplete.phase": {
        console.log(`\n⚠️  [${timestamp}] Incomplete phase detected: ${event.data.phaseName}`);
        console.log(`   ${event.data.message}`);
        break;
      }

      case "info": {
        console.log(`\nℹ️  [${timestamp}] ${event.data.message}`);
        break;
      }

      case "server.idle": {
        console.log(`\n⏸️  [${timestamp}] Server idle: ${event.data.reason}`);
        console.log(`   ${event.data.message}`);
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
          console.log(`\n📋 [${timestamp}] Checkpoints in run ${event.data.runId}:`);

          if (event.data.checkpoints.length === 0) {
            console.log("   No checkpoints found");
          } else {
            event.data.checkpoints.forEach((cp, index) => {
              console.log(
                `   [${index + 1}] ${cp.phaseName} - ${cp.checkpointType} ` +
                  `(${cp.sha.substring(0, 7)})`,
              );
            });
          }
        }
        break;
      }

      case "rollback.completed": {
        console.log(
          `\n✅ [${timestamp}] Rollback completed!\n` +
            `   From run: ${event.data.fromRun}\n` +
            `   To run: ${event.data.toRun}\n` +
            `   Phase: ${event.data.phaseName} (${event.data.checkpointType})\n` +
            `   Checkpoint: ${event.data.checkpoint.substring(0, 7)}`,
        );
        break;
      }

      default:
        // Show all unknown events for debugging
        console.log(
          `\n📨 [${timestamp}] ${event.type}:`,
          JSON.stringify("data" in event ? event.data : {}, null, 2),
        );
    }
  }

  private sendCommand(command: ClientCommand): void {
    if (!this.isConnected || !this.ws) {
      console.error("❌ Not connected to server");
      return;
    }

    this.ws.send(JSON.stringify(command));
  }

  private setupKeyboardInput(): void {
    console.log("\n📌 Commands:");
    console.log("  [n] next phase");
    console.log("  [s] skip current");
    console.log("  [f] force stop");
    console.log("  [l] list checkpoints");
    console.log("  [r] rollback menu");
    console.log("  [q] quit\n");

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    process.stdin.on("data", async (key: string) => {
      switch (key) {
        case "n":
          console.log("\n⏭️  Advancing to next phase...");
          this.sendCommand({
            id: generateId(),
            type: "phase.next",
          } as NextPhaseCommand);
          break;

        case "s":
          console.log("\n⏩ Skipping current phase...");
          this.sendCommand({
            id: generateId(),
            type: "phase.skip",
          } as SkipPhaseCommand);
          break;

        case "f":
          console.log("\n⛔ Force stopping current phase...");
          this.sendCommand({
            id: generateId(),
            type: "phase.forceStop",
            data: { reason: "User requested from TUI" },
          } as ClientCommand);
          break;

        case "l":
          console.log("\n📋 Requesting checkpoint list...");
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
          console.log("\n👋 Shutting down...");
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
    console.log("\n🔄 Rollback Options:");
    console.log("  [1] Rollback to last successful phase");
    console.log("  [2] List checkpoints and select");
    console.log("  [c] Cancel");

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
        console.log("\n⏳ Fetching checkpoints...");
        break;

      case "c":
        console.log("\n❌ Rollback cancelled");
        break;
    }
  }

  /**
   * Confirm rollback with effects
   */
  private async confirmAndRollback(target: string, action: () => Promise<void>): Promise<void> {
    console.log(`\n⚠️  Rollback to: ${target}`);
    console.log("\nThis will:");
    console.log("  - End the current run");
    console.log("  - Reset project files to checkpoint state");
    console.log("  - Start a new continuation run");
    console.log("  - Preserve all history in state.json");
    console.log("\nContinue? (y/N): ");

    const response = await this.waitForKey();

    if (response === "y" || response === "Y") {
      await action();
    } else {
      console.log("\n❌ Rollback cancelled");
    }
  }

  /**
   * Show interactive checkpoint selection menu
   */
  private async showCheckpointSelection(data: CheckpointListEvent["data"]): Promise<void> {
    if (data.checkpoints.length === 0) {
      console.log("\n❌ No checkpoints found in current run");
      return;
    }

    console.log(`\n📋 Select checkpoint to rollback to (run ${data.runId}):`);
    data.checkpoints.forEach((cp, index) => {
      const timestamp = new Date(cp.timestamp).toLocaleTimeString();
      console.log(`  [${index + 1}] ${cp.phaseName} - ${cp.checkpointType} (${timestamp})`);
      console.log(`      SHA: ${cp.sha.substring(0, 7)}...`);
    });
    console.log("  [c] Cancel");
    console.log("\nEnter your choice: ");

    const response = await this.waitForKey();

    if (response === "c" || response === "C") {
      console.log("\n❌ Rollback cancelled");
      return;
    }

    const choice = parseInt(response, 10);
    if (Number.isNaN(choice) || choice < 1 || choice > data.checkpoints.length) {
      console.log("\n❌ Invalid selection");
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
