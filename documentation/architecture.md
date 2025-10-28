# Tadpole Runner Architecture

## System Overview

Tadpole Runner is a sophisticated orchestration server designed to manage complex, multi-step AI workflows executed by the Claude AI. At its core, it is a stateful, WebSocket-based application that provides a structured environment for breaking down large tasks into discrete, manageable "phases". This architecture enables robust features such as persistent state, file tracking, cost monitoring, and a powerful git-based rollback system.

The server supports **multiple concurrent WebSocket connections** with granular access control (readonly or readandwrite modes). A formal handshake protocol manages client connection and mode negotiation.

A key architectural feature is **execution isolation**: Tadpole runs in separate execution directories rather than directly in your project. This provides clean rollbacks, multiple execution tracking, and ensures your original data remains untouched. The user's data (file or directory) is accessed via a symlink or copy at `<execution-dir>/read_only_data_source/`.

### Core Design Principles

The architecture is guided by several key principles to ensure robustness, maintainability, and extensibility:

-   **Single Responsibility**: Each module and class is designed to have a clear and focused purpose, such as state management, process control, or configuration parsing. This separation of concerns makes the system easier to understand, test, and extend.

-   **Type Safety**: The entire codebase is written in TypeScript and leverages advanced features:
    - **Branded Types**: These are nominal types that prevent accidental type confusion. For example, `PhaseId` and `RunId` are both strings at runtime, but TypeScript ensures you can't accidentally pass a `RunId` where a `PhaseId` is expected:
      ```typescript
      type Branded<T, Brand> = T & { __brand: Brand };
      type PhaseId = Branded<string, "PhaseId">;
      type RunId = Branded<string, "RunId">;
      ```
    - **Discriminated Unions**: The `PhaseExecution` type uses the `status` field as a discriminator, allowing TypeScript to narrow the type and ensure type-safe access to status-specific fields:
      ```typescript
      type PhaseExecution =
        | { status: "running"; currentCost: number; /* ... */ }
        | { status: "completed"; finalCost: number; /* ... */ }
        | { status: "failed"; failureReason: FailureReason; /* ... */ }
      ```

-   **Event-Driven Communication**: Internal modules communicate through a type-safe event emitter. This decouples components and allows for flexible, asynchronous interactions. For example, the log parser emits events that the main server listens for, without the two being tightly coupled.

-   **State Immutability**: All state transitions are handled as pure functions that take the current state and an event, and return a new state object. This avoids side effects and makes state changes predictable and easy to reason about.

-   **Event Sourcing Pattern**: The state manager uses an event-sourcing-inspired approach where:
    - All state changes are represented as discrete events (`StateTransition` types)
    - Events are queued and processed sequentially
    - Each event is validated before application
    - The current state can be reconstructed by replaying events
    - Server state events are journaled in `.tadpole/events/events.jsonl`

-   **Fail-Safe Operation**: The system is designed to be resilient. It includes mechanisms for graceful degradation (e.g., disabling checkpointing if Git is unavailable) and recovery from crashes, primarily through atomic state writes and a robust lock file mechanism.

-   **Event Categorization and Routing**: All server events are categorized into two types: **Server State Events** (persisted and broadcasted to all clients) and **Connection State Events** (ephemeral and client-specific). This separation ensures clean distinction between domain logic and connection lifecycle, with compile-time safety guarantees via TypeScript's type system. See [Event Journal documentation](./event-journal.md) for details.

-   **Append-Only History**: To ensure a complete and auditable trail, historical data (runs, phase executions, checkpoints) is never modified or deleted. New states are appended, preserving the full history of the workflow.

## Module Organization

The server is composed of several distinct, yet interconnected, modules.

### Entry Points & User Interfaces

-   **`server/index.ts`**: The main entry point of the application. It is responsible for parsing command-line arguments, validating the workflow configuration, instantiating the main server, and selecting the operational mode (WebSocket, TUI, etc.).
-   **`server/basic-tui.ts`**: A self-contained Terminal User Interface. It acts as a WebSocket client that connects to the server, providing a real-time, color-coded display of events and handling keyboard input for interactive control.

### The Core Orchestrator

-   **`server/tadpole-server.ts`**: This is the central nervous system of the application. The `TadpoleServer` class orchestrates all other components. Its key responsibilities include managing the WebSocket server and multiple concurrent client connections (stored in a `Map<string, ClientConnection>` registry), handling the handshake protocol for client authentication and mode negotiation, processing incoming commands, controlling the phase execution lifecycle, routing events based on category (broadcast to all clients vs. targeted to specific connections), and coordinating with the event journal for persistence and history synchronization.

### State Management Subsystem

-   **`server/state-manager.ts`**: This module implements a centralized, event-sourcing-inspired pattern for state management. It exposes a simple `transition()` method, which queues state change events. These events are processed sequentially, ensuring that all state modifications are validated, applied immutably, and persisted atomically to disk. After each successful state transition, it emits a `stateChanged` event that is consumed by `TadpoleServer`, which converts it to a `state.transition` server event for journaling and client broadcast. It also features a cost cache for performance and crash recovery logic.
-   **`server/state-types.ts`**: This file is crucial for the system's type safety. It defines the TypeScript interfaces for the entire state tree, including the `TadpoleState`, `Run`, and the `PhaseExecution` discriminated union, which models the seven distinct states of a phase's lifecycle.
-   **`server/execution-thread.ts`**: This module contains the logic for analyzing the execution history. Its primary export, `analyzeExecutionThread`, is a powerful function that traverses the potentially branching history of runs to construct a single, logical "thread" of execution, which is used to determine the next phase to run.

### Event System & Validation

-   **`server/schemas/event-schemas.ts`**: The single source of truth for all server event definitions. This file uses Zod schemas to define the structure and validation rules for all 19 server event types. TypeScript types are automatically inferred from these schemas, ensuring perfect consistency between runtime validation and compile-time type checking. The file exports both the schemas and the inferred types, including a discriminated union `ServerEvent` type for type-safe event handling.
-   **`server/types/types.ts`**: Contains non-event TypeScript types and interfaces used throughout the system, such as `PhaseConfig`, `ServerConfig`, and command types. Event types are re-exported from the schemas file for backward compatibility.

### Process & Log Management

-   **`server/claude-process-manager.ts`**: This class is responsible for the entire lifecycle of the Claude CLI subprocess. It handles spawning the process with the correct arguments and environment variables, creating and managing log streams, and ensuring the process is properly monitored and cleaned up.
-   **`server/claude-log-parser.ts`**: A real-time parser for Claude's JSONL output. It reads new lines from the log file as they are written, validates them against a schema, and emits typed events for different message types (system, assistant, user, result), which the main server then processes. It now includes parsing of tool results from user messages, enabling detailed tracking of tool execution outcomes.

### Checkpoint & File System

-   **`server/checkpoint-git.ts`**: This module manages all interactions with the "shadow" git repository. It handles repository initialization, creating run-specific branches, committing changes with structured metadata, and performing hard resets for rollbacks.
-   **`server/file-resolver.ts`**: Provides a unified and consistent way to resolve file glob patterns while respecting `.gitignore` rules. This is used by both the file tracking and checkpointing systems to ensure they operate on the same set of files.

### Execution Isolation

-   **`server/execution-setup.ts`**: Manages the creation and detection of execution directories. It handles automatic execution directory creation in `~/.tadpole-executions/`, supports explicit execution paths, and manages data access via symlinks or copies. This module ensures clean separation between user data and execution artifacts. It supports both files and directories as data sources.
-   **`server/data-hasher.ts`**: Generates deterministic hashes of data sources (files or directories) to identify which executions belong to which data source. Uses time and depth limits to handle large projects efficiently while maintaining unique identification across different data sources. Files are hashed based on content and metadata.

## Data Flow and Interaction

### A Typical Phase Execution Flow

1.  **Connection & Handshake**: A client connects via WebSocket and immediately sends a `handshake` message specifying its desired access mode (readonly or readandwrite). The server responds with a `handshake.response` containing the client ID and confirming the mode. Only after handshake completion does the client receive server events.
2.  **Command Reception**: A client sends a `phase.start` command over WebSocket. The `TadpoleServer` receives it and calls its internal `startPhase` method.
3.  **Phase Initialization**: `startPhase` orchestrates the setup, which includes running `workspaceSetup` commands, creating a `workspace-setup` checkpoint via `CheckpointGit`, and finally using `ClaudeProcessManager` to spawn the Claude CLI process.
4.  **Log Processing**: As the Claude process runs, it writes JSONL logs to a file. The `ClaudeLogParser` tails this file, parses new lines, and emits events (e.g., for an assistant message, tool use, or tool result).
5.  **Tool Result Tracking**: When Claude uses a tool, the server tracks the invocation. When the tool completes, Claude logs the result in a user message. The server correlates these results with their invocations, calculates execution time, and creates `tool.result` events.
6.  **State Updates**: The `TadpoleServer` listens for these parser events. Upon receiving one, it creates a corresponding `StateTransition` object (e.g., `CostsIncremented`) and sends it to the `StateManager`. The `StateManager` validates, applies, and persists the change.
7.  **Event Routing**: The `TadpoleServer` transforms parser events and state changes into server events (e.g., `assistant.action`, `tool.result`, `phase.started`). These events are categorized: Server State Events are appended to the event journal and broadcasted to all connected clients with completed handshakes, while Connection State Events are sent only to specific target clients.

### The State Transition Flow

The state transition process is designed to be robust and atomic:
1.  A component calls `stateManager.transition({...})`. The transition is added to a queue.
2.  The `StateManager` processes the queue sequentially. For each transition, it first validates that the change is legal (e.g., a phase cannot transition from `running` to `initializing`).
3.  It then applies the transition by creating a deep clone of the current state and modifying it, ensuring immutability.
4.  The new state is persisted to disk using an atomic write operation (write to temp, backup old, rename).
5.  After the state is safely on disk, the `StateManager` emits a `stateChanged` event to notify other parts of the system.
6.  The `TadpoleServer` listens for `stateChanged` events and converts them into `state.transition` server events with detailed transition metadata.
7.  The `state.transition` event flows through the event routing system: categorized as a Server State Event, it is appended to the event journal (`.tadpole/events/events.jsonl`) and broadcasted to all connected clients with completed handshakes.

## System Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│              Clients (WebSocket, Multi-Client)                   │
│         ┌────────────┬────────────┬────────────┐                 │
│         │ Client 1   │ Client 2   │ Client N   │                 │
│         │ (R/W mode) │ (RO mode)  │ (R/W mode) │                 │
│         └─────┬──────┴─────┬──────┴─────┬──────┘                 │
└───────────────┼────────────┼────────────┼────────────────────────┘
                │            │            │
        ┌───────▼────────────▼────────────▼───────┐
        │         TadpoleServer                    │
        │      (Core Orchestrator)                 │
        │   ┌──────────────────────────┐           │
        │   │  Client Registry         │           │
        │   │  Map<id, ClientConn>     │           │
        │   └──────────────────────────┘           │
        └──┬────┬────┬────┬────┬────┬────┬────┬──┘
           │    │    │    │    │    │    │    │
   ┌───────▼┐ ┌─▼────▼──┐ │ ┌─▼────▼──┐ │ ┌──▼─────┐
   │State   │ │ Event   │ │ │ Claude  │ │ │Chkpt   │
   │Manager │ │ Journal │ │ │ Process │ │ │Git     │
   │        │ │         │ │ │ Manager │ │ │        │
   │┌──────┐│ │┌───────┐│ │ │┌───────┐│ │ │┌──────┐│
   ││Trans ││ ││Storage││ │ ││ Log   ││ │ ││Shadow││
   ││Queue ││ ││Backend││ │ ││Parser ││ │ ││ Git  ││
   │└──────┘│ │└───┬───┘│ │ │└───────┘│ │ │└──────┘│
   └────┬───┘ └────┼────┘ │ └─────────┘ │ └────────┘
        │          │      │             │
   ┌────▼───┐ ┌────▼──────▼─────────────▼──┐
   │state   │ │ .tadpole/                  │
   │.json   │ │   events/events.jsonl      │
   └────────┘ └────────────────────────────┘
```

**Note:** missing from the diagram above is LLMProxy server that TadpoleServer starts by default. This proxy is a simple passthrough at the moment.

## Key Architectural Decisions

### Multi-Client Architecture

The server supports multiple concurrent WebSocket connections, each with independent access modes and connection states:

-   **Client Registry**: A `Map<string, ClientConnection>` tracks all active clients by unique client IDs.
-   **Access Modes**: Clients can connect in `readonly` or `readandwrite` mode, with the server enforcing write restrictions for readonly clients.
-   **Handshake Protocol**: All clients must complete a formal handshake before receiving events, during which they specify their desired access mode and optionally request event history.
-   **Graceful Connection Handling**: The server no longer shuts down when a client disconnects (this behavior is configurable), allowing continuous operation with multiple observers and controllers.

This architecture enables use cases such as:
- Multiple developers observing the same execution
- One write-enabled controller with multiple readonly monitoring clients
- Automated systems connecting alongside human operators

### Event Categorization and Routing

All server events are categorized into two mutually exclusive types for intelligent routing:

-   **Server State Events**: Persisted to the event journal and broadcasted to all connected clients (e.g., `phase.started`, `file.updated`, `state.transition`)
-   **Connection State Events**: Ephemeral events sent only to specific target clients (e.g., `handshake.response`, `pong`, `history.batch`)

The system uses TypeScript's type system to enforce compile-time exhaustiveness checks, ensuring all events are explicitly categorized. This prevents accidental misrouting and maintains clean separation between domain logic and connection lifecycle.

See [Event Journal documentation](./event-journal.md) for complete details on event categories, routing implementation, and safety guarantees.

### Event Journal and Storage Architecture

The Event Journal serves as the single source of truth for all server activity. See [Event Journal documentation](./event-journal.md) for architecture details, storage implementations, and client synchronization patterns.

### Shadow Git Repository

Instead of interfering with the user's project git repository, the server maintains its own isolated repository in `.tadpole/checkpoints`. This provides several advantages:
-   **No Interference**: It doesn't create commits or branches in the user's repository.
-   **Complete History**: It can track files that might be in the user's `.gitignore` (e.g., build artifacts), providing a more complete snapshot of the workspace state.
-   **Clean Slate**: It starts from an empty commit, providing a reliable baseline to diff against.
-   **Branch Strategy**: Each run gets its own branch (`run-<runId>`), isolating different execution paths:
     ```
     main (initial empty commit)
       ├── run-1234-abc
       │     ├── workspace-setup: phase-1
       │     ├── completed: phase-1
       │     └── completed: phase-2
       └── run-5678-def (rollback from phase-1)
             ├── completed: phase-1 (different approach)
             └── completed: phase-2
     ```

### Fire-and-Forget State Transitions

The `StateManager.transition()` method is asynchronous in effect but synchronous in invocation ("fire-and-forget"). This decouples the components that generate state changes from the persistence logic, simplifying the codebase. A queue ensures that all transitions are processed in the correct order, preserving causality.

```
Component → transition() → Queue → Validate → Apply → Persist → Emit
                            ↑                                      │
                            └──────────────────────────────────────┘
                                     (Next transition)
```

### The Execution Thread

The concept of an Execution Thread is a solution to the complexity introduced by rollbacks. A simple linear history is not sufficient when a user can branch off from any point in the past. The thread algorithm reconstructs the *logical* sequence of events as the user perceives it, making it possible to correctly determine the "next" phase even in complex, non-linear histories.

#### Example: Rollback Scenario
```
Run 1: [Phase A] → [Phase B] → [Phase C failed]
                        ↓
                    (rollback)
                        ↓
Run 2:             [Phase B'] → [Phase C'] → [Phase D]

Execution Thread: [Phase A] → [Phase B'] → [Phase C'] → [Phase D]
                 (from Run 1)  (from Run 2 - newer versions)
```

### Execution Isolation

The server operates in isolated execution directories rather than directly in the user's project. This architectural decision provides significant benefits:

-   **Data Integrity**: The original project files remain untouched. All modifications occur in the execution directory.
-   **Clean Rollbacks**: Rollbacks affect only the execution environment, never the source data.
-   **Multiple Executions**: Track and compare different execution attempts for the same data source.
-   **Simplified Cleanup**: Remove execution artifacts without affecting the original project.

#### Directory Structure
```
~/.tadpole-executions/
├── 1737123456789-abc-d4f5e6/          # Execution directory
│   ├── read_only_data_source/         # Symlink to user's data or contains file
│   │   └── [filename.txt]             # (if data source is a file)
│   ├── generated-docs/                # Files created by Claude
│   └── .tadpole/                      # Tadpole state and metadata
│       ├── execution-meta.json
│       ├── state.json
│       └── checkpoints/
└── 1737234567890-def-d4f5e6/          # Another execution attempt
```

The system uses data hashing to identify which executions belong to which data source, enabling automatic resumption of the most recent execution or creation of new ones as needed.
