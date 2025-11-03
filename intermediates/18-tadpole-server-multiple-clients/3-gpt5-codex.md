 ## Current Behavior Snapshot

- `TadpoleServer` keeps a single `ServerWebSocket` in `this.client` and refuses additional connections (`server/tadpole-server.ts:99`, `server/tadpole-server.ts:369`).
- `sendEvent` only targets that socket and emits nothing if it'"'s absent ("'`server/tadpole-server.ts:530`).
- Disconnecting the lone client triggers server shutdown (`server/tadpole-server.ts:441`).
- Incoming messages are parsed as `ClientCommand` without any notion of client identity or capabilities, and `handleCommand` is fired without awaiting or queueing (`server/tadpole-server.ts:413`).
- There is no in-memory history of outbound packets, so late joiners cannot reconstruct prior server events.

## Requirements Recap
1. Accept multiple concurrent WebSocket clients.
2. Perform a handshake where each client declares whether it is read-only.
3. Replay all prior server packets to the newcomer as part of that handshake.
4. Permit read-write clients to issue stateful commands while protecting state from read-only clients.
5. Keep the system resilient to conflicting commands and disconnections.

## Proposed Architecture

- **Client Registry**: Replace `this.client` with `Map<string, ServerWebSocket<ClientSession>>`. `ClientSession` extends the existing activity metadata with `clientId`, `mode`, and `handshakeComplete` flags.
- **Structured Handshake**: Define a dedicated `client.handshake` message validated with Zod. Until a socket successfully handshakes, every payload is treated as handshake data and regular commands are rejected.
- **Event Buffer**: Track outbound `ServerEvent`s in an append-only ring buffer (configurable size, default 5000). Each event is indexed by its `EventId`. Handshake replay uses this buffer to re-send the full history (or everything after a `resumeAfterEventId` when reconnecting).
- **Command Queue**: Funnel commands through a server-wide async queue so that state mutations stay serialized regardless of which client sent them.
- **Broadcast Helpers**: Split event sending into `broadcastEvent` (all clients + buffer append) and `sendEventToClient` (targeted messages like `server.ready` or error responses).

## Implementation Steps

1. **Define Session & Handshake Types**
    - Near the existing `ClientData` interface, add:
        ```ts
        interface ClientSession extends ClientData {
            clientId: string;
            mode: "read-only" | "read-write";
            handshakeComplete: boolean;
            resumeAfter?: string; // last seen event id, if provided
        }
        ```
    - Extend `server/command-schemas.ts` (or a new `client-message-schemas.ts`) with:
        ```ts
        const clientHandshakeSchema = z.object({
        type: z.literal("client.handshake"),
        data: z.object({
            readOnly: z.boolean(),
            resumeAfterEventId: z.string().optional(),
            requestedClientId: z.string().min(1).max(64).optional(),
        }),
        });
        export type ClientHandshake = z.infer<typeof clientHandshakeSchema>;
        ```
    - Update `ServerEvent` schema to include a `server.handshakeAck` event containing assigned `clientId`, the resolved mode, and optional replay metadata.

2. **Introduce Event Buffer Utility**
    - Create `server/event-buffer.ts` with a small class:
        ```ts
        export class EventBuffer {
            constructor(private maxSize = 5000) {}
            private events: ServerEvent[] = [];

            append(event: ServerEvent): void {
                this.events.push(event);
                if (this.events.length > this.maxSize) {
                    this.events = this.events.slice(-this.maxSize);
                }
            }

            replay(afterId?: string): ServerEvent[] {
                if (!afterId) return [...this.events];
                const idx = this.events.findIndex((evt) => evt.id === afterId);
                return idx === -1 ? [...this.events] : this.events.slice(idx + 1);
            }
        }
        ```
    - Instantiate it in `TadpoleServer`'"'s constructor (after "'`StateManager`), optionally exposing configuration via `DEFAULT_CONFIG` (e.g., `eventBufferSize`).

3. **Refactor Server Fields**
    - Replace `private client` with:
        ```ts
        private clients = new Map<string, ServerWebSocket<ClientSession>>();
        private commandQueue: Promise<void> = Promise.resolve();
        private eventBuffer: EventBuffer;
        ```
    - Adjust constructor parameters to initialise `eventBuffer` with the configured size.

4. **Update Connection Lifecycle**
    - In `handleConnection`, stop rejecting additional sockets. Generate a provisional `clientId` (`generateId()`), attach default session metadata, and emit an informational log.
    - Immediately send a targeted `server.ready` (updated to include `requiresHandshake: true`) using `sendEventToClient` so the UI knows to perform the handshake.

5. **Implement Handshake Processing**
    - In `handleMessage`, branch on `ws.data.handshakeComplete` before parsing commands:
        ```ts
        if (!ws.data.handshakeComplete) {
            const handshake = clientHandshakeSchema.safeParse(parsed);
            if (!handshake.success) {
                this.sendEventToClient(ws, buildError("Handshake required"));
                return;
            }
            this.finalizeHandshake(ws, handshake.data);
            return;
        }
        ```
    - `finalizeHandshake` assigns/normalises the `clientId`, resolves mode (`read-only` vs `read-write`), records `resumeAfterEventId`, and stores the socket in
    `this.clients`.
    - After storing, send a `server.handshakeAck` targeted to the client and immediately stream the replay:
        ```ts
        this.sendEventToClient(ws, {
            id: EventId(generateId()),
            timestamp: new Date().toISOString(),
            type: "server.handshakeAck",
            data: { clientId, mode: session.mode },
        });
        for (const event of this.eventBuffer.replay(session.resumeAfter)) {
            this.sendEventToClient(ws, event);
        }
        ```

6. **Gate and Queue Command Execution**
    - After handshake, parse payloads with `clientCommandSchema` as today but route through a queue:
        ```ts
        const context = { clientId: ws.data.clientId, mode: ws.data.mode };
        this.commandQueue = this.commandQueue
        .then(() => this.executeCommand(result.data, context))
        .catch((error) => this.logger.log(...));
        ```
    - Extract current `handleCommand` body into `private async executeCommand(command, context)`.
    - Inside `executeCommand`, ensure a read-only client is allowed before continuing:
        ```ts
        const isReadOnlyAllowed = this.READ_ONLY_COMMANDS.has(command.type);
        if (context.mode === "read-only" && !isReadOnlyAllowed) {
            this.sendEventToClient(this.clients.get(context.clientId)!, buildError(...));
            return;
        }
        ```
    - Continue using the existing command logic afterwards.

7. **Broadcast Events to All Clients**
    - Rename `sendEvent` to `broadcastEvent` (update all call sites accordingly). Implementation:
        ```ts
        private broadcastEvent(event: ServerEvent): void {
            this.eventBuffer.append(event);
            for (const [clientId, socket] of this.clients) {
                try {
                    socket.send(JSON.stringify(event));
                    socket.data.lastActivity = new Date();
                    this.logger.logSocketTraffic(this.config.socketLogFile, "out", { clientId, event });
                } catch (error) {
                    this.logger.log(`Failed to send event to ${clientId}: ${error}`, "error");
                    this.removeClient(clientId, "send failure");
                }
            }
            this.emit("event", event);
        }
        ```
    - Update helper methods (e.g., `sendStateSnapshot`) to call `broadcastEvent` instead of the old `sendEvent`.
    - Provide `private sendEventToClient` for targeted responses without touching the buffer.

8. **Revise Disconnect & Shutdown Semantics**
    - Change `handleClose` to drop the client and only trigger shutdown if an explicit command requested it or a new config flag (e.g., `shutdownWhenIdle`) is true and the last client leaves.
    - Ensure `shutdown` iterates `this.clients` and closes each socket before clearing the map.

9. **Documentation & Config Updates**
    - Extend `documentation/server-protocol.md` with the new handshake flow and replay semantics.
    - Update `DEFAULT_CONFIG` / `ServerConfig` with knobs for `maxClients`, `eventBufferSize`, and `shutdownWhenIdle` (default `false` to avoid surprise shutdowns).
    - Adjust any CLI tooling or prompts that expect single-client behaviour.

## Race & Conflict Mitigation
- The command queue serializes execution, preventing interleaved mutations from different clients.
- Handshake gating stops non-handshaken sockets from issuing writes.
- Replay uses `EventId` ordering; missing IDs fall back to full history to keep clients in sync.
- Read-only enforcement prevents accidental destructive actions from observers.
- Per-send error handling removes broken sockets so they cannot clog the broadcast loop.

## Testing Strategy
1. **Unit**
    - EventBuffer append/trim/replay logic, including resume-after edge cases.
    - Handshake validation (bad payloads rejected, resume id applied).
    - Read-only enforcement (mock clients verifying blocked commands).

2. **Integration**
    - Spin up `TadpoleServer`, connect three WebSocket clients (two read-write, one read-only) and verify broadcast order consistency.
    - Reconnect scenario where client provides `resumeAfterEventId` and receives only newer events.
    - Ensure server stays alive when one client disconnects and remaining clients keep receiving events.
    - Confirm shutdown closes all sockets and clears the registry.

3. **Regression**
    - Run existing manual scripts/phases to ensure command semantics unchanged from a single read-write client perspective.
    - Capture WebSocket logs to verify handshake and replay packets are logged per client.

## Follow-Up Enhancements (Optional)
- Persist the event buffer to disk using the existing JSONL socket log for crash recovery.
- Add a `clients.list` read-only command that outputs current connections for debugging.
- Introduce authentication hooks if multiple users will connect from different machines.