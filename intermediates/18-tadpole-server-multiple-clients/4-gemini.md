# Plan for Multi-Client Support in Tadpole Server

Based on the analysis of the current architecture, here is a detailed plan to modify the `TadpoleServer` to support multiple clients, including read-only clients, while ensuring state consistency and resilience.

The current architecture is well-suited for this change due to its event-sourcing-inspired `StateManager`, which serializes all state-mutating operations, inherently preventing most race conditions.

## 1. Core Architectural Changes

The fundamental change is to move from a single-client model to managing a collection of clients.

### 1.1. Client Management

In `server/tadpole-server.ts`, we will replace the single client reference:

```typescript
// Current
private client: ServerWebSocket<ClientData> | null = null;

// Proposed
private clients: Map<string, ServerWebSocket<ClientData & { isReadOnly: boolean; id: string }>> = new Map();
```

-   The `Map` will use a unique connection ID as the key.
-   The `ClientData` interface will be augmented to include an `id` and an `isReadOnly` flag for each connection.

### 1.2. Event History for New Clients

To fulfill the requirement of providing a "dump of all the packets" to new clients, we will introduce an in-memory event history.

```typescript
// Add to TadpoleServer class properties
private eventHistory: ServerEvent[] = [];
private readonly MAX_HISTORY_LENGTH = 1000; // Cap history size to prevent memory leaks
```

-   Every event sent will be appended to this array.
-   If the array exceeds `MAX_HISTORY_LENGTH`, the oldest event will be removed.

## 2. Connection Lifecycle Management

### 2.1. Handling New Connections (`handleConnection`)

The `handleConnection` method will be updated to accept all incoming connections.

```typescript
// In handleConnection(ws)
// 1. Generate a unique ID for the connection
const connectionId = generateId(); 

// 2. Add the new client to the map with default read-only status
ws.data = {
  connectionTime: new Date(),
  lastActivity: new Date(),
  isReadOnly: true, // Default to read-only until handshake
  id: connectionId,
};
this.clients.set(connectionId, ws);

// 3. Log the new connection
this.logger.log(`Client ${connectionId} connected. Total clients: ${this.clients.size}`);

// 4. The server will now wait for a 'client.hello' command from the new client.
```

### 2.2. Client Handshake (New Command)

We will introduce a new `client.hello` command. This must be the first command a client sends after connecting.

**New Command Schema in `server/command-schemas.ts`:**

```typescript
export const clientHelloCommandSchema = z.object({
  type: z.literal("client.hello"),
  data: z.object({
    readOnly: z.boolean(),
  }),
});
```

**Handling the command in `handleCommand`:**

```typescript
// In handleCommand(command, ws)
case "client.hello": {
  // Update the client's read-only status
  ws.data.isReadOnly = command.data.readOnly;
  this.logger.log(`Client ${ws.data.id} identified as ${ws.data.isReadOnly ? 'read-only' : 'read-write'}.`);

  // 1. Send the server.ready event to the specific client
  this.sendEventToClient(ws, { /* server.ready event payload */ });

  // 2. Send the entire event history to the new client
  this.logger.log(`Sending ${this.eventHistory.length} historical events to client ${ws.data.id}.`);
  for (const event of this.eventHistory) {
    this.sendEventToClient(ws, event, { historical: true });
  }

  // 3. Send the latest state snapshot
  await this.sendStateSnapshot(ws);
  break;
}
```

### 2.3. Handling Disconnections (`handleClose`)

The `handleClose` method will be modified to no longer shut down the server unless it's the last client.

```typescript
// In handleClose(ws)
const clientId = ws.data.id;
this.clients.delete(clientId);
this.logger.log(`Client ${clientId} disconnected. Remaining clients: ${this.clients.size}`);

if (this.clients.size === 0) {
  this.logger.log("Last client disconnected - shutting down server.");
  this.shutdown("last client disconnected");
}
```

## 3. Event Broadcasting

The `sendEvent` method will be repurposed to broadcast events to all connected clients and record them in the history.

```typescript
// In TadpoleServer class

private sendEvent(event: ServerEvent): void {
  // Add to history
  this.eventHistory.push(event);
  if (this.eventHistory.length > this.MAX_HISTORY_LENGTH) {
    this.eventHistory.shift(); // Remove the oldest event
  }

  // Broadcast to all clients
  this.logger.logSocketTraffic(this.config.socketLogFile, "out", event);
  for (const client of this.clients.values()) {
    client.send(JSON.stringify(event));
  }

  // Emit for internal listeners (TUI, tests)
  this.emit("event", event);
}

// New helper for sending to a single client without recording to history
private sendEventToClient(ws: ServerWebSocket<any>, event: ServerEvent, options?: { historical: boolean }): void {
  if (!options?.historical) {
    this.logger.logSocketTraffic(this.config.socketLogFile, "out-one", event);
  }
  ws.send(JSON.stringify(event));
}
```

The `sendStateSnapshot` method will also be updated to allow sending to a single client during the handshake.

```typescript
// Modified signature
private async sendStateSnapshot(ws?: ServerWebSocket<any>): Promise<void> {
  // ... logic to build the snapshot event ...
  const snapshotEvent = { /* state.snapshot event */ };

  if (ws) {
    // Send to a specific client
    this.sendEventToClient(ws, snapshotEvent);
  } else {
    // Broadcast to all clients
    this.sendEvent(snapshotEvent);
  }
}
```

## 4. Command Handling and Concurrency

The `handleCommand` method will be modified to enforce read-only restrictions. The existing `StateManager` queue already provides the necessary mechanism to prevent race conditions from multiple write-enabled clients.

```typescript
// Modified signature for handleMessage and handleCommand
// handleMessage(ws, message) -> handleCommand(result.data, ws)

async handleCommand(command: ClientCommand, ws: ServerWebSocket<ClientData & { isReadOnly: boolean; id: string }>): Promise<void> {
  this.logger.log(`Handling command: ${command.type} from client ${ws.data.id}`);

  // Read-only check
  const isWriteCommand = !this.READ_ONLY_COMMANDS.has(command.type);
  if (ws.data.isReadOnly && isWriteCommand) {
    const errorEvent: ErrorEvent = {
      // ... error event payload ...
      message: `Client is read-only. Cannot execute write command: ${command.type}`,
      // ...
    };
    this.sendEventToClient(ws, errorEvent);
    return;
  }

  // ... existing switch statement for commands ...
}
```

This plan introduces multi-client capabilities in a way that is consistent with the existing robust, event-driven architecture of the Tadpole server. It addresses state synchronization for new clients, provides a clear distinction between read-only and read-write clients, and leverages the existing state management system to handle concurrency safely.
