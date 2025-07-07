import type { EventEmitter } from "node:events";
import type {
  AssistantActionEvent,
  ClientCommand,
  ErrorEvent,
  FileTreeUpdatedEvent,
  FileUpdatedEvent,
  IncompletePhaseEvent,
  InfoEvent,
  NextPhaseCommand,
  PhaseCompletedEvent,
  PhaseStartedEvent,
  ServerEvent,
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

  constructor(
    private server: EventEmitter & {
      config?: { port?: number };
      shutdown: (reason: string) => Promise<void>;
    },
  ) {
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

  private handleServerEvent(event: ServerEvent): void {
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
        console.log(`\n✅ [${timestamp}] Completed: Phase ${completeData.phaseId}`);
        console.log(
          `   Cost: $${completeData.cost.toFixed(4)}, Duration: ${(
            completeData.duration / 1000
          ).toFixed(1)}s`,
        );
        break;
      }

      case "assistant.action": {
        const actionData = (event as AssistantActionEvent).data;
        if (actionData.action === "message") {
          console.log(`\n💬 [${timestamp}] ${actionData.content}...`);
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
    console.log("\n📌 Commands: [n] next phase | [s] skip | [q] quit\n");

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    process.stdin.on("data", (key: string) => {
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
}
