## 1. Add Configuration for Truncation

In `server/config.ts`, add to the `DEFAULT_CONFIG`:

```typescript
export const DEFAULT_CONFIG = {
  // ... existing config ...
  toolResultTruncateLength: 1000, // Default truncation length for tool results
};
```

## 2. Update ClaudeLogParser to Handle User Messages

In `server/claude-log-parser.ts`, add a callback for user messages:

```typescript
export interface ClaudeLogParserOptions {
  // ... existing options ...
  /** Callback for user messages (tool results) */
  onUserMessage?: (msg: UserMessage) => void;
}
```

And in the `parseLogLine` method, add handling for user messages:

```typescript
case "user":
  if (this.options.onUserMessage) {
    this.options.onUserMessage(message);
  }
  break;
```

## 3. Add Tool Result Event Type

In `server/types/types.ts`, add a new event type:

```typescript
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
```

Add it to the `ServerEvent` union type.

## 4. Track Tool Uses in TadpoleServer

In `server/tadpole-server.ts`, add tracking for pending tool uses:

```typescript
export class TadpoleServer {
  // ... existing properties ...

  // Track pending tool uses for result matching
  private pendingToolUses: Map<string, {
    toolName: string;
    timestamp: number;
    phaseId: string;
  }> = new Map();
```

## 5. Update Tool Use Handling

In `handleAssistantMessage`, when processing tool uses:

```typescript
if (item.type === "tool_use") {
  const toolItem = item as ToolUseContent;

  // Track this tool use for result matching
  this.pendingToolUses.set(toolItem.id, {
    toolName: toolItem.name,
    timestamp: Date.now(),
    phaseId,
  });

  // ... existing code ...
}
```

## 6. Add User Message Handler

In `startClaudeProcess`, add the user message callback:

```typescript
this.logParser = new ClaudeLogParser({
  // ... existing options ...
  onUserMessage: (msg) => this.handleUserMessage(msg, phase.id),
});
```

Then implement the handler:

```typescript
private handleUserMessage(msg: UserMessage, phaseId: string): void {
  // Process tool results from user messages
  const content = msg.message.content;
  const contentArray = Array.isArray(content) ? content : [];

  for (const item of contentArray) {
    if (item.type === "tool_result") {
      const toolResult = item as ToolResultContent;

      // Find the corresponding tool use
      const toolUse = this.pendingToolUses.get(toolResult.tool_use_id);
      if (!toolUse) {
        this.logger.log(`Tool result without matching tool use: ${toolResult.tool_use_id}`, "warning");
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
          .filter(c => c.type === "text")
          .map(c => c.text)
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
        resultText = resultText.substring(0, truncateLength) + "...";
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
      } as ToolResultEvent);

      // Clean up tracked tool use
      this.pendingToolUses.delete(toolResult.tool_use_id);
    }
  }
}
```

## 7. Clean Up on Phase Completion

In `cleanupCurrentPhase`, add:

```typescript
private cleanupCurrentPhase(): void {
  // ... existing cleanup ...

  // Clear any pending tool uses
  this.pendingToolUses.clear();
}
```

## Summary

This implementation:
1. Tracks tool uses when Claude invokes them
2. Captures tool results from user messages in the logs
3. Matches results to their invocations via `tool_use_id`
4. Calculates execution time from timestamps
5. Truncates results based on configuration
6. Sends structured events through the WebSocket
7. Handles both string and object results
8. Detects error results

The clients will receive `tool.result` events with all the execution details, allowing them to display tool performance metrics and results in their UI.