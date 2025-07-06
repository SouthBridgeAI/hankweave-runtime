import type { EventEmitter } from "node:events";
import type {
  AssistantActionEvent,
  ClientCommand,
  ErrorEvent,
  NextPhaseCommand,
  PhaseCompletedEvent,
  PhaseStartedEvent,
  ServerEvent,
  SkipPhaseCommand,
  TokenUsageEvent,
} from "./types.js";
import { generateId } from "./utils.js";

/**
 * Basic Terminal UI for testing and debugging the server.
 * 
 * Provides:
 * - Real-time event display in the terminal
 * - Keyboard shortcuts for common commands
 * - Colored output for different event types
 * 
 * Usage: Run server with --basic flag
 * Controls: [n] next phase, [s] skip current, [q] quit
 */
export class BasicTUI {
  constructor(
    private server: EventEmitter & {
      handleCommand: (cmd: ClientCommand) => void;
      shutdown: (reason: string) => Promise<void>;
    },
  ) {
    this.setupEventHandlers();
    this.setupKeyboardInput();
  }

  private setupEventHandlers(): void {
    this.server.on("event", (event: ServerEvent) => {
      const timestamp = new Date(event.timestamp).toLocaleTimeString();

      switch (event.type) {
        case "server.ready":
          console.log(`\n🚀 [${timestamp}] Server ready!`);
          break;

        case "phase.started": {
          const startData = (event as PhaseStartedEvent).data;
          console.log(`\n📋 [${timestamp}] Started: ${startData.phaseName}`);
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
            console.log(`\n💬 [${timestamp}] ${actionData.content.slice(0, 80)}...`);
          } else if (actionData.action === "thinking") {
            console.log(`\n🤔 [${timestamp}] Thinking...`);
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

        case "error": {
          const errorData = (event as ErrorEvent).data;
          console.error(`\n❌ [${timestamp}] Error: ${errorData.message}`);
          break;
        }
      }
    });
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
          this.server.handleCommand({
            id: generateId(),
            type: "phase.next",
          } as NextPhaseCommand);
          break;

        case "s":
          console.log("\n⏩ Skipping current phase...");
          this.server.handleCommand({
            id: generateId(),
            type: "phase.skip",
          } as SkipPhaseCommand);
          break;

        case "q":
        case "\u0003": // Ctrl+C
          console.log("\n👋 Shutting down...");
          this.server.shutdown("user request");
          break;
      }
    });
  }
}
