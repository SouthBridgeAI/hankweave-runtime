# Multi-Client Support for Tadpole Server - Implementation Plan

## Executive Summary

This document provides a detailed implementation plan for modifying Tadpole Server to support multiple concurrent clients with both read-only and read-write capabilities. The design focuses on simplicity, resilience to conflicts, and maintaining the existing event-driven architecture.

## Current Architecture Analysis

### Key Components
1. **Single Client Model**: Currently enforces strict single-client connection via WebSocket
2. **Event Broadcasting**: `sendEvent()` method sends events to single client
3. **State Management**: StateManager provides centralized state with immutable transitions
4. **Command Processing**: Sequential command processing ensures consistency

### Current Limitations
- Rejects additional connections when client is connected (line 369-372 in `tadpole-server.ts`)
- No packet history for replay to new clients
- Server shuts down when client disconnects

## Proposed Architecture

### Core Design Principles
1. **Event Journal**: Maintain complete history of all events for new client synchronization
2. **Client Registry**: Track multiple clients with their access modes
3. **Command Arbitration**: Ensure only one client can send state-modifying commands
4. **Graceful Handoff**: Support transferring write control between clients

### Key Components

#### 1. Client Management System

```typescript
// New types for client management
interface ClientInfo extends ClientData {
  id: string;
  isReadOnly: boolean;
  connectedAt: Date;
  lastActivity: Date;
  eventCursor: number; // Track which events have been sent
}

interface HandshakeRequest {
  type: 'handshake';
  data: {
    readOnly: boolean;
    clientId?: string; // Optional for reconnection
    lastEventId?: string; // For resuming from specific point
  };
}

interface HandshakeResponse {
  type: 'handshake.response';
  data: {
    clientId: string;
    mode: 'read-only' | 'read-write';
    eventHistory: ServerEvent[];
    currentState: StateSnapshotEvent;
  };
}
```

#### 2. Event Journal System

```typescript
class EventJournal {
  private events: ServerEvent[] = [];
  private readonly maxEvents = 10000; // Configurable limit
  private readonly persistPath: string;

  constructor(tadpoleDir: string) {
    this.persistPath = path.join(tadpoleDir, 'event-journal.jsonl');
    this.loadPersistedEvents();
  }

  append(event: ServerEvent): void {
    this.events.push(event);

    // Persist to disk for recovery
    fs.appendFileSync(this.persistPath, JSON.stringify(event) + '\n');

    // Trim old events if needed
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }
  }

  getEventsSince(cursor: number): ServerEvent[] {
    return this.events.slice(cursor);
  }

  getEventsSinceId(eventId?: string): ServerEvent[] {
    if (!eventId) return [...this.events];

    const index = this.events.findIndex(e => e.id === eventId);
    return index >= 0 ? this.events.slice(index + 1) : [...this.events];
  }

  getAllEvents(): ServerEvent[] {
    return [...this.events];
  }

  private loadPersistedEvents(): void {
    if (fs.existsSync(this.persistPath)) {
      const lines = fs.readFileSync(this.persistPath, 'utf-8').split('\n');
      this.events = lines
        .filter(line => line.trim())
        .map(line => JSON.parse(line));
    }
  }
}
```

#### 3. Modified TadpoleServer Class

```typescript
export class TadpoleServer extends TypedEventEmitter<ServerInternalEvents> {
  // Replace single client with multiple clients
  private clients: Map<string, ServerWebSocket<ClientInfo>> = new Map();
  private writeClient: string | null = null; // ID of client with write access
  private eventJournal: EventJournal;

  constructor(config: ServerConfig) {
    // ... existing constructor code ...
    this.eventJournal = new EventJournal(tadpoleDir);
  }

  private handleConnection(ws: ServerWebSocket<ClientInfo>): void {
    // Don't reject connections anymore
    this.logger.log("New client connection initiated");

    // Set temporary data, wait for handshake
    const tempId = generateId();
    ws.data = {
      id: tempId,
      isReadOnly: true, // Default to read-only until handshake
      connectedAt: new Date(),
      lastActivity: new Date(),
      eventCursor: 0,
      connectionTime: new Date(),
    };
  }

  private async handleHandshake(
    ws: ServerWebSocket<ClientInfo>,
    request: HandshakeRequest
  ): Promise<void> {
    const { readOnly, clientId, lastEventId } = request.data;

    // Assign or validate client ID
    const finalClientId = clientId || ws.data.id;

    // Determine if this client can have write access
    let grantedMode: 'read-only' | 'read-write' = 'read-only';

    if (!readOnly) {
      // Client wants write access
      if (!this.writeClient || !this.clients.has(this.writeClient)) {
        // No current write client, grant write access
        this.writeClient = finalClientId;
        grantedMode = 'read-write';
        this.logger.log(`Client ${finalClientId} granted write access`);
      } else {
        // Already have a write client
        this.logger.log(`Client ${finalClientId} denied write access (${this.writeClient} has it)`);
      }
    }

    // Update client data
    ws.data = {
      ...ws.data,
      id: finalClientId,
      isReadOnly: grantedMode === 'read-only',
      eventCursor: 0,
    };

    // Register client
    this.clients.set(finalClientId, ws);

    // Get events to replay
    const eventHistory = lastEventId
      ? this.eventJournal.getEventsSinceId(lastEventId)
      : this.eventJournal.getAllEvents();

    // Send handshake response
    const response: HandshakeResponse = {
      type: 'handshake.response',
      data: {
        clientId: finalClientId,
        mode: grantedMode,
        eventHistory: eventHistory,
        currentState: await this.buildStateSnapshot(),
      },
    };

    ws.send(JSON.stringify(response));
    this.logger.log(`Handshake complete for client ${finalClientId} (${grantedMode})`);
  }

  private handleMessage(ws: ServerWebSocket<ClientInfo>, message: any): void {
    try {
      const parsed = JSON.parse(message.toString());

      // Check for handshake first
      if (parsed.type === 'handshake') {
        this.handleHandshake(ws, parsed as HandshakeRequest);
        return;
      }

      // Validate command
      const result = clientCommandSchema.safeParse(parsed);
      if (!result.success) {
        this.sendEventToClient(ws, {
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

      // Check write permissions for state-modifying commands
      const command = result.data;
      if (this.isStateModifyingCommand(command) && ws.data.isReadOnly) {
        this.sendEventToClient(ws, {
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "error",
          data: {
            message: "Read-only client cannot execute state-modifying commands",
            context: `Attempted command: ${command.type}`,
            fatal: false,
          },
        } as ErrorEvent);
        return;
      }

      // Process command
      this.handleCommand(command);

    } catch (error) {
      this.logger.log(`Error handling message: ${error}`, "error");
    }
  }

  private isStateModifyingCommand(command: ClientCommand): boolean {
    const readOnlyCommands = new Set([
      "checkpoint.list",
      "server.status", // New command for getting server status
    ]);

    return !readOnlyCommands.has(command.type);
  }

  // Modified sendEvent to broadcast to all clients
  private sendEvent(event: ServerEvent): void {
    // Store in journal
    this.eventJournal.append(event);

    // Broadcast to all connected clients
    for (const [clientId, client] of this.clients) {
      try {
        client.send(JSON.stringify(event));
        client.data.eventCursor++;
        this.logger.logSocketTraffic(
          this.config.socketLogFile,
          "out",
          { ...event, clientId }
        );
      } catch (error) {
        this.logger.log(`Failed to send event to client ${clientId}: ${error}`, "error");
        // Clean up disconnected client
        this.handleClientDisconnection(clientId);
      }
    }

    // Emit for tests and basic TUI
    this.emit("event", event);
  }

  private sendEventToClient(ws: ServerWebSocket<ClientInfo>, event: ServerEvent): void {
    try {
      ws.send(JSON.stringify(event));
      this.logger.logSocketTraffic(
        this.config.socketLogFile,
        "out",
        { ...event, clientId: ws.data.id }
      );
    } catch (error) {
      this.logger.log(`Failed to send event to client ${ws.data.id}: ${error}`, "error");
    }
  }

  private handleClose(ws: ServerWebSocket<ClientInfo>): void {
    const clientId = ws.data.id;
    this.logger.log(`Client ${clientId} disconnected`);

    this.handleClientDisconnection(clientId);

    // Check if we should shut down
    if (this.config.shutdownOnLastDisconnect && this.clients.size === 0) {
      this.logger.log("Last client disconnected, shutting down");
      setTimeout(() => this.shutdown("last client disconnected"), 2000);
    }
  }

  private handleClientDisconnection(clientId: string): void {
    // Remove from clients map
    this.clients.delete(clientId);

    // If this was the write client, reassign write access
    if (this.writeClient === clientId) {
      this.writeClient = null;

      // Optional: Auto-promote oldest read-only client to write
      if (this.config.autoPromoteToWrite) {
        const candidates = Array.from(this.clients.entries())
          .filter(([_, client]) => client.data.isReadOnly)
          .sort((a, b) => a[1].data.connectedAt.getTime() - b[1].data.connectedAt.getTime());

        if (candidates.length > 0) {
          const [newWriteId, newWriteClient] = candidates[0];
          this.promoteToWrite(newWriteId);
        }
      }
    }
  }

  private promoteToWrite(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    this.writeClient = clientId;
    client.data.isReadOnly = false;

    // Notify client of promotion
    this.sendEventToClient(client, {
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "access.changed",
      data: {
        mode: "read-write",
        message: "You have been granted write access",
      },
    } as any);

    // Notify other clients
    this.sendEvent({
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "info",
      data: {
        message: `Client ${clientId} now has write access`,
      },
    } as InfoEvent);
  }
}
```

#### 4. New Client Commands for Access Control

```typescript
// Add to command-schemas.ts
export const transferWriteCommandSchema = z.object({
  id: z.string(),
  type: z.literal("access.transfer"),
  data: z.object({
    targetClientId: z.string(),
  }),
});

export const requestWriteCommandSchema = z.object({
  id: z.string(),
  type: z.literal("access.request"),
});

export const listClientsCommandSchema = z.object({
  id: z.string(),
  type: z.literal("clients.list"),
});

// Handler in TadpoleServer
private async handleAccessTransfer(fromClientId: string, targetClientId: string): Promise<void> {
  // Verify requesting client has write access
  if (this.writeClient !== fromClientId) {
    this.sendEventToClient(this.clients.get(fromClientId)!, {
      type: "error",
      data: {
        message: "Only the write client can transfer write access",
        fatal: false,
      },
    } as any);
    return;
  }

  // Transfer write access
  const targetClient = this.clients.get(targetClientId);
  if (!targetClient) {
    this.sendEventToClient(this.clients.get(fromClientId)!, {
      type: "error",
      data: {
        message: `Target client ${targetClientId} not found`,
        fatal: false,
      },
    } as any);
    return;
  }

  // Update access
  const fromClient = this.clients.get(fromClientId)!;
  fromClient.data.isReadOnly = true;
  targetClient.data.isReadOnly = false;
  this.writeClient = targetClientId;

  // Notify all clients
  this.sendEvent({
    id: EventId(generateId()),
    timestamp: new Date().toISOString(),
    type: "info",
    data: {
      message: `Write access transferred from ${fromClientId} to ${targetClientId}`,
    },
  } as InfoEvent);
}
```

## Configuration Options

Add to `ServerConfig`:

```typescript
interface ServerConfig {
  // ... existing config ...

  // Multi-client options
  maxClients?: number; // Default: 10
  shutdownOnLastDisconnect?: boolean; // Default: false
  autoPromoteToWrite?: boolean; // Default: false
  eventJournalMaxSize?: number; // Default: 10000
  persistEventJournal?: boolean; // Default: true
}
```

## Race Condition Handling

### Command Serialization
- All commands are processed sequentially through existing queue system
- Only one client can have write access at a time
- State transitions remain atomic and immutable

### Event Ordering
- Events are assigned sequential IDs and timestamps
- Journal maintains strict ordering
- New clients receive events in exact order they occurred

### Conflict Resolution
1. **Write Access Conflicts**: First client requesting write gets it
2. **Simultaneous Commands**: Processed in order received
3. **Disconnection During Operation**: Operation completes, results broadcast to remaining clients

## Testing Strategy

### Unit Tests
1. Test EventJournal persistence and retrieval
2. Test client handshake scenarios
3. Test access transfer logic
4. Test disconnection handling

### Integration Tests
1. Multiple clients connecting simultaneously
2. Write access transfer during phase execution
3. Client reconnection with event replay
4. Server recovery after crash

### Example Test Case
```typescript
test("multiple clients receive same events", async () => {
  const server = new TadpoleServer(config);
  await server.start();

  // Connect two clients
  const client1 = new WebSocket(`ws://localhost:${config.port}`);
  const client2 = new WebSocket(`ws://localhost:${config.port}`);

  // Both perform handshake
  client1.send(JSON.stringify({
    type: "handshake",
    data: { readOnly: false }
  }));

  client2.send(JSON.stringify({
    type: "handshake",
    data: { readOnly: true }
  }));

  // Client1 starts a phase
  client1.send(JSON.stringify({
    id: "cmd-1",
    type: "phase.start",
    data: { phaseId: "phase-1" }
  }));

  // Both clients should receive phase.started event
  const event1 = await waitForEvent(client1, "phase.started");
  const event2 = await waitForEvent(client2, "phase.started");

  expect(event1.data.phaseId).toBe(event2.data.phaseId);
});
```

## Migration Path

### Phase 1: Core Implementation
1. Implement EventJournal class
2. Modify client tracking to use Map
3. Add handshake protocol
4. Update sendEvent for broadcasting

### Phase 2: Access Control
1. Implement write access management
2. Add transfer commands
3. Add client listing commands

### Phase 3: Persistence & Recovery
1. Persist event journal to disk
2. Implement client reconnection
3. Add event replay from checkpoint

### Phase 4: Advanced Features
1. Client authentication (optional)
2. Event filtering per client
3. Rate limiting per client

## Backward Compatibility

To maintain backward compatibility:
1. Support legacy connection without handshake (auto-assign write access)
2. Keep `server.shutdown` behavior when last client disconnects (configurable)
3. Maintain existing event format and protocol

## Summary

This implementation provides:
- **Simple**: Minimal changes to existing architecture
- **Powerful**: Full multi-client support with access control
- **Resilient**: Handles disconnections, crashes, and race conditions
- **Efficient**: Event journal with configurable limits
- **Compatible**: Maintains existing protocol and behavior

The design leverages Tadpole's existing event-driven architecture and immutable state management to ensure consistency while adding multi-client capabilities in a clean, maintainable way.