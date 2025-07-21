import type { LangtonServer } from "./langton-server.js";
import type {
  AssistantActionEvent,
  CheckpointListEvent,
  ClientCommand,
  ErrorEvent,
  FileTreeUpdatedEvent,
  FileUpdatedEvent,
  IncompletePhaseEvent,
  InfoEvent,
  NextPhaseCommand,
  PhaseCompletedEvent,
  PhaseStartedEvent,
  RollbackCompletedEvent,
  ServerEvent,
  ServerIdleEvent,
  SkipPhaseCommand,
  StateSnapshotEvent,
  TokenUsageEvent,
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
        const snapshotData = (event as StateSnapshotEvent).data;
        console.log(`\n📸 [${timestamp}] State snapshot received`);
        if (snapshotData.recentFileAccess) {
          console.log(`   Recent file: ${snapshotData.recentFileAccess.path}`);
        }
        console.log(`   Total cost: $${snapshotData.totalCost.toFixed(4)}`);
        break;
      }

      case "phase.started": {
        const startData = (event as PhaseStartedEvent).data;
        console.log(`\n📋 [${timestamp}] Started: ${startData.phaseName}`);
        console.log(`   Session ID: ${startData.sessionId}`);
        if (startData.previousSessionId) {
          console.log(`   Continuing from: ${startData.previousSessionId}`);
        }
        if (startData.phaseDescription) {
          console.log(`   ${startData.phaseDescription}`);
        }
        break;
      }

      case "phase.completed": {
        const completeData = (event as PhaseCompletedEvent).data;
        const status = completeData.success ? "✅" : "❌";
        console.log(`\n${status} [${timestamp}] Completed: Phase ${completeData.phaseId}`);
        console.log(
          `   Cost: $${completeData.cost.toFixed(4)}, Duration: ${(
            completeData.duration / 1000
          ).toFixed(1)}s`,
        );

        if (!completeData.success && completeData.failureReason) {
          console.log(
            `   Failure: ${completeData.failureReason.type} (retriable: ${completeData.failureReason.retriable})`,
          );
          if (completeData.failureReason.message) {
            console.log(`   Message: ${completeData.failureReason.message}`);
          }
        }
        break;
      }

      case "assistant.action": {
        const actionData = (event as AssistantActionEvent).data;
        if (actionData.action === "message") {
          console.log(`\n💬 [${timestamp}] ${actionData.content}`);
        } else if (actionData.action === "thinking") {
          console.log(`\n🤔 [${timestamp}] Thinking: ${actionData.content}`);
        } else if (actionData.action === "tool_use") {
          console.log(`\n🔧 [${timestamp}] Using tool: ${actionData.toolName}`);
        }
        break;
      }

      case "token.usage": {
        const usageData = (event as TokenUsageEvent).data;
        console.log(`\n📊 [${timestamp}] Tokens used - Cost: $${usageData.totalCost.toFixed(4)}`);
        break;
      }

      case "file.updated": {
        const fileData = (event as FileUpdatedEvent).data;
        console.log(`\n📄 [${timestamp}] File ${fileData.action}: ${fileData.path}`);
        break;
      }

      case "filetree.updated": {
        const treeData = (event as FileTreeUpdatedEvent).data;
        console.log(`\n🌲 [${timestamp}] File tree updated (${treeData.tree.length} root items)`);
        break;
      }

      case "error": {
        const errorData = (event as ErrorEvent).data;
        console.error(`\n❌ [${timestamp}] Error: ${errorData.message}`);
        break;
      }

      case "incomplete.phase": {
        const incompleteData = (event as IncompletePhaseEvent).data;
        console.log(`\n⚠️  [${timestamp}] Incomplete phase detected: ${incompleteData.phaseName}`);
        console.log(`   ${incompleteData.message}`);
        break;
      }

      case "info": {
        console.log(`\nℹ️  [${timestamp}] ${(event as InfoEvent).data.message}`);
        break;
      }

      case "server.idle": {
        const data = (event as ServerIdleEvent).data;
        console.log(`\n⏸️  [${timestamp}] Server idle: ${data.reason}`);
        console.log(`   ${data.message}`);
        break;
      }

      case "checkpoint.list": {
        const data = (event as CheckpointListEvent).data;

        // Store checkpoints for interactive selection
        this.checkpoints = data.checkpoints;

        if (this.waitingForCheckpoints) {
          // We're in interactive mode - show selection menu
          this.waitingForCheckpoints = false;
          await this.showCheckpointSelection(data);
        } else {
          // Regular display mode
          console.log(`\n📋 [${timestamp}] Checkpoints in run ${data.runId}:`);

          if (data.checkpoints.length === 0) {
            console.log("   No checkpoints found");
          } else {
            data.checkpoints.forEach((cp, index) => {
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
        const data = (event as RollbackCompletedEvent).data;
        console.log(
          `\n✅ [${timestamp}] Rollback completed!\n` +
            `   From run: ${data.fromRun}\n` +
            `   To run: ${data.toRun}\n` +
            `   Phase: ${data.phaseName} (${data.checkpointType})\n` +
            `   Checkpoint: ${data.checkpoint.substring(0, 7)}`,
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
