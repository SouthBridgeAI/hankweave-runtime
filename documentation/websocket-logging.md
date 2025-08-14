# WebSocket Logging System

## Overview

The Tadpole Runner WebSocket logging system provides comprehensive logging of all WebSocket traffic between the server and clients. The logs are stored in JSONL (JSON Lines) format, where each line is a complete JSON object representing a single WebSocket message. This format enables easy parsing, filtering, and analysis of the communication flow.

## Log Format

### File Location

WebSocket logs are stored at:
```
.tadpole/logs/websocket.log
```

### JSONL Structure

Each line in the log file is a JSON object with the following structure:

```typescript
{
  "loggedAt": "2025-01-19T10:00:00.123Z",  // ISO timestamp when logged
  "direction": "in" | "out",                // Message direction
  "message": { ... },                       // The actual WebSocket message
  "metadata": {                             // Optional metadata
    "size": 1234,                          // Message size in bytes
    "error": "..."                         // Any error during processing
  }
}
```

### Key Design Principles

1. **Minimal Wrapping**: We only add fields that aren't already in the underlying message. For example, `ServerEvent` messages already have `timestamp` and `id` fields, so we don't duplicate them.

2. **Type Safety**: All log entries are fully typed using TypeScript interfaces, ensuring consistency and enabling type-safe log analysis.

3. **JSONL Compliance**: Each line is a valid, self-contained JSON object, making the logs compatible with standard JSONL tools.

## Message Types

### Client Commands (Incoming)

Commands sent from the client to the server (`direction: "in"`):

- `phase.start` - Start a specific phase
- `phase.next` - Advance to the next phase
- `phase.skip` - Skip the current phase
- `phase.redo` - Redo the last phase
- `phase.forceStop` - Force stop the current phase
- `server.shutdown` - Shutdown the server
- `checkpoint.list` - List available checkpoints
- `rollback.*` - Various rollback commands

### Server Events (Outgoing)

Events sent from the server to the client (`direction: "out"`):

- `server.ready` - Server initialization complete
- `state.snapshot` - Complete state update
- `phase.started` - Phase execution started
- `phase.completed` - Phase execution completed
- `assistant.action` - Claude's actions during execution
- `token.usage` - Token usage updates
- `tool.result` - Tool execution results
- `file.updated` - File change notifications
- `error` - Error notifications
- `info` - Informational messages

## Using the WebSocket Log Reader

### Basic Usage

```typescript
import { WebSocketLogReader } from "./server/websocket-log-reader.js";

// Create a reader instance
const reader = new WebSocketLogReader(".tadpole/logs/websocket.log");

// Read all log entries
const entries = await reader.readLog();

// Get statistics
const stats = reader.getStatistics();
console.log(`Total messages: ${stats.totalEntries}`);
console.log(`Incoming: ${stats.incomingCount}`);
console.log(`Outgoing: ${stats.outgoingCount}`);
```

### Filtering Messages

```typescript
// Filter by direction
const incomingMessages = reader.filterByDirection("in");
const outgoingMessages = reader.filterByDirection("out");

// Filter by message type
const phaseStartMessages = reader.filterByMessageType("phase.start");

// Filter by time range
const recentMessages = reader.filterByTimeRange(
  new Date(Date.now() - 3600000), // Last hour
  new Date()
);

// Get messages for a specific phase
const phaseMessages = reader.getPhaseMessages("phase-1");

// Get messages for a specific session
const sessionMessages = reader.getSessionMessages("session-uuid");
```

### Stream Processing (Memory Efficient)

For large log files, use streaming to process entries without loading everything into memory:

```typescript
await reader.streamRead(async (entry) => {
  // Process each entry
  if (entry.direction === "out" && entry.message.type === "error") {
    console.log("Error found:", entry.message);
  }
});
```

### Exporting Filtered Logs

```typescript
// Export specific messages to a new file
const errorMessages = reader.filterByMessageType("error");
reader.exportToFile(errorMessages, "error-messages.jsonl");
```

## Common Use Cases

### 1. Debugging Phase Failures

```typescript
// Find all messages related to a failed phase
const phaseId = "phase-1";
const phaseMessages = reader.getPhaseMessages(phaseId);

// Look for error events
const errors = phaseMessages.filter(entry =>
  entry.message.type === "error" ||
  (entry.message.type === "phase.completed" &&
   entry.message.data?.success === false)
);
```

### 2. Analyzing Token Usage

```typescript
// Get all token usage events
const tokenEvents = reader.filterByMessageType("token.usage");

// Calculate total cost
const totalCost = tokenEvents.reduce((sum, entry) => {
  const data = entry.message.data as any;
  return sum + (data?.totalCost || 0);
}, 0);

console.log(`Total cost: $${totalCost.toFixed(4)}`);
```

### 3. Replay Analysis

```typescript
// Get the complete message flow for a session
const sessionId = "session-123";
const sessionFlow = reader.getSessionMessages(sessionId);

// Analyze the flow
sessionFlow.forEach(entry => {
  const timestamp = entry.loggedAt;
  const type = entry.message.type;
  const direction = entry.direction === "in" ? "→" : "←";
  console.log(`${timestamp} ${direction} ${type}`);
});
```

### 4. Performance Analysis

```typescript
// Analyze message sizes and frequency
const stats = reader.getStatistics();

console.log("Message Type Distribution:");
Object.entries(stats.messageTypes).forEach(([type, count]) => {
  console.log(`  ${type}: ${count}`);
});

console.log(`Average message size: ${stats.averageMessageSize} bytes`);

// Calculate message rate
if (stats.timeRange.start && stats.timeRange.end) {
  const duration = new Date(stats.timeRange.end).getTime() -
                   new Date(stats.timeRange.start).getTime();
  const messagesPerSecond = stats.totalEntries / (duration / 1000);
  console.log(`Message rate: ${messagesPerSecond.toFixed(2)} msg/s`);
}
```

## Command-Line Tools

### Quick Statistics

```bash
# Using the built-in helper function
bun -e "
import { getWebSocketLogStats } from './server/websocket-log-reader.js';
const stats = await getWebSocketLogStats('.tadpole/logs/websocket.log');
console.log(JSON.stringify(stats, null, 2));
"
```

### Extract Specific Messages

```bash
# Extract all error messages using jq
cat .tadpole/logs/websocket.log | jq 'select(.message.type == "error")'

# Count messages by type
cat .tadpole/logs/websocket.log | jq -r '.message.type' | sort | uniq -c
```

### Real-time Monitoring

```bash
# Watch the log file in real-time
tail -f .tadpole/logs/websocket.log | jq '.'
```

## Log Rotation and Management

### Size Considerations

WebSocket logs can grow large during long-running sessions. Consider implementing log rotation:

```typescript
import fs from "fs";

function rotateLogIfNeeded(logPath: string, maxSizeBytes: number = 10 * 1024 * 1024) {
  const stats = fs.statSync(logPath);
  if (stats.size > maxSizeBytes) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archivePath = logPath.replace('.log', `-${timestamp}.log`);
    fs.renameSync(logPath, archivePath);
    console.log(`Rotated log to ${archivePath}`);
  }
}
```

### Cleanup Old Logs

```typescript
import fs from "fs";
import path from "path";

function cleanupOldLogs(logsDir: string, daysToKeep: number = 7) {
  const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);

  fs.readdirSync(logsDir)
    .filter(file => file.startsWith('websocket-') && file.endsWith('.log'))
    .forEach(file => {
      const filePath = path.join(logsDir, file);
      const stats = fs.statSync(filePath);
      if (stats.mtime.getTime() < cutoffTime) {
        fs.unlinkSync(filePath);
        console.log(`Deleted old log: ${file}`);
      }
    });
}
```

## Migration from Old Format

If you have logs in the old format (`[timestamp] [IN/OUT] {json}`), you can migrate them:

```typescript
import fs from "fs";
import readline from "readline";

async function migrateOldLogs(oldPath: string, newPath: string) {
  const fileStream = fs.createReadStream(oldPath);
  const rl = readline.createInterface({ input: fileStream });
  const output = fs.createWriteStream(newPath);

  for await (const line of rl) {
    // Parse old format: [2025-01-19T10:00:00Z] [IN] {...}
    const match = line.match(/\[([^\]]+)\] \[([^\]]+)\] (.+)/);
    if (match) {
      const [, timestamp, direction, jsonStr] = match;
      const newEntry = {
        loggedAt: timestamp,
        direction: direction.toLowerCase() as "in" | "out",
        message: JSON.parse(jsonStr),
        metadata: { size: jsonStr.length }
      };
      output.write(JSON.stringify(newEntry) + '\n');
    }
  }

  output.end();
  console.log(`Migration complete: ${newPath}`);
}
```

## Best Practices

1. **Regular Cleanup**: Implement log rotation and cleanup to prevent disk space issues.

2. **Error Monitoring**: Set up alerts for error messages in the logs.

3. **Performance Tracking**: Regularly analyze message rates and sizes to identify performance issues.

4. **Security**: Be careful when sharing logs as they may contain sensitive information.

5. **Compression**: Consider compressing archived logs to save disk space:
   ```bash
   gzip .tadpole/logs/websocket-*.log
   ```

6. **Backup**: Include WebSocket logs in your backup strategy if you need them for auditing or debugging.

## Troubleshooting

### Common Issues

1. **Large Log Files**: If logs are growing too large, implement rotation or increase the cleanup frequency.

2. **Parse Errors**: If you see parse errors, check for corrupted lines in the log file. The reader will skip invalid lines and continue.

3. **Missing Messages**: Ensure the server has write permissions to the log directory.

4. **Performance Impact**: If logging impacts performance, consider using a separate thread or process for log writing.

### Debug Mode

Enable verbose logging for the WebSocket system:

```typescript
// In your server configuration
const config = {
  // ... other config
  debugWebSocketLogging: true  // Adds extra debug information
};
```

This will add additional metadata to each log entry for debugging purposes.
