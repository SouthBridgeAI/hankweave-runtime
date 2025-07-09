# Langton Runner Type Safety Implementation Guide

This guide covers all recommended type safety improvements for the Langton Runner project, organized by priority and impact.

## Table of Contents

1. [Semantic Anti-patterns](#1-semantic-anti-patterns)
2. [Branded Types for IDs](#2-branded-types-for-ids)
3. [Exit Code Types](#3-exit-code-types)
4. [Exhaustive Checking](#4-exhaustive-checking)
5. [Zod Validation at Boundaries](#5-zod-validation-at-boundaries)
6. [Phase State Discriminated Unions](#6-phase-state-discriminated-unions)
7. [Model Name Union Types](#7-model-name-union-types)
8. [Synthetic Message Types](#8-synthetic-message-types)
9. [Boolean to Union Conversions](#9-boolean-to-union-conversions)
10. [Const Assertions for Timeouts](#10-const-assertions-for-timeouts)
11. [Error Handling Improvements](#11-error-handling-improvements)
12. [Tightening Optional/Null Types](#12-tightening-optionalnull-types)
13. [Missing Type Additions](#13-missing-type-additions)
14. [Claude Log Validation Strategy](#14-claude-log-validation-strategy)
15. [Type-Safe Event Emitter](#15-type-safe-event-emitter)
16. [Checkpoint Status Types](#16-checkpoint-status-types)

---

## Default Value Philosophy

### When to Use Defaults

**Use defaults for**:

- **Common cases**: `workingDirectory: "project"` (most commands run in project root)
- **Safe values**: Empty arrays for collections that can be empty
- **Display-only fields**: UI elements that can gracefully handle empty values

**Don't use defaults for**:

- **Critical decisions**: `model`, `continuationMode` - user must choose explicitly
- **Identity fields**: `id`, `name` - must be unique and meaningful
- **Behavioral flags**: Settings that change how the system operates
- **Optional metadata**: `description` - absence is different from empty

### Examples

```typescript
// GOOD: Sensible default for common case
workingDirectory: z.enum(["project", "lastCopied"]).default("project");

// GOOD: Required field, no default
model: z.enum(["sonnet", "opus"]); // User MUST specify

// GOOD: Truly optional field
description: z.string().optional(); // Absence has meaning

// BAD: Hidden default behavior
continuationMode: z.enum(["fresh", "continue-previous"]).default("fresh");
// Better: Make it required so user consciously chooses

// BAD: Default for identity field
name: z.string().default("Unnamed Phase");
// Better: Require meaningful names
```

### Schema Validation for Either/Or Fields

```typescript
// Ensure either promptFile or promptText is provided
const phaseConfigSchema = z
  .object({
    // ... other fields
    promptFile: z.union([z.string(), z.array(z.string())]).optional(),
    promptText: z.string().optional(),
    // ... more fields
  })
  .refine((data) => data.promptFile || data.promptText, {
    message: "Either promptFile or promptText must be provided",
  });
```

**Key principle**: Defaults should make the common case easier without hiding important decisions. When in doubt, make it explicit.

---

## 1. Semantic Anti-patterns

### Issue: `workingDirectory` defaults to "project" when undefined

**File**: `server/types.ts`

**Current**:

```typescript
command?: {
  run: string;
  workingDirectory?: "project" | "lastCopied";
}
```

**Change to**:

```typescript
command?: {
  run: string;
  workingDirectory: "project" | "lastCopied";
}
```

**File**: `server/config.ts` (in schema)

**Add default in schema**:

```typescript
workingDirectory: z.enum(["project", "lastCopied"]).default("project"),
```

**Reasoning**: Undefined should not have semantic meaning. Make the default explicit in the schema validation. "project" is a sensible default as it's the most common case.

**Implications**:

- No runtime behavior change
- Config files can still omit the field
- Code becomes self-documenting

### Issue: Empty string vs undefined for descriptions

**File**: `server/types.ts`

**Current**:

```typescript
description?: string;
```

**Keep as optional - no change needed**

**File**: `server/langton-server.ts`

**Update usage to handle undefined explicitly**:

```typescript
// When using description
if (phase.description) {
  // Use the description
}
```

**Reasoning**: Description is truly optional - absence means "no description provided" which is semantically different from an empty description. Users should explicitly provide descriptions when they want them.

**Implications**:

- Forces conscious decision about descriptions
- UI must handle undefined case

### Issue: Null means "not watching"

**File**: `server/langton-server.ts`

**Current**:

```typescript
private watchedPattern: string | null = null;
```

**Change to**:

```typescript
private watchedPattern: string | undefined;
```

**Or better**:

```typescript
private fileWatching:
  | { enabled: false }
  | { enabled: true; pattern: string };
```

**Reasoning**: Null shouldn't have special meaning. Use explicit state representation.

**Implications**: Makes the watching state machine explicit.

---

## 2. Branded Types for IDs

### Create brand utilities

**New file**: `server/branded-types.ts`

```typescript
declare const __brand: unique symbol;
type Brand<B> = { [__brand]: B };
export type Branded<T, B> = T & Brand<B>;

// ID types
export type PhaseId = Branded<string, "PhaseId">;
export type SessionId = Branded<string, "SessionId">;
export type PhaseExecutionId = Branded<string, "PhaseExecutionId">;
export type EventId = Branded<string, "EventId">;
export type MessageId = Branded<string, "MessageId">;
export type ToolUseId = Branded<string, "ToolUseId">;

// Helper functions
export const PhaseId = (id: string): PhaseId => id as PhaseId;
export const SessionId = (id: string): SessionId => id as SessionId;
export const PhaseExecutionId = (id: string): PhaseExecutionId =>
  id as PhaseExecutionId;
export const EventId = (id: string): EventId => id as EventId;
export const MessageId = (id: string): MessageId => id as MessageId;
export const ToolUseId = (id: string): ToolUseId => id as ToolUseId;
```

### Update type definitions

**File**: `server/types.ts`

**Current**:

```typescript
export interface PhaseConfig {
  id: string;
  // ...
}

export interface PhaseState {
  phaseExecutionId: string;
  sessionId: string | null;
  previousSessionId: string | null;
  // ...
}
```

**Change to**:

```typescript
import type { PhaseId, SessionId, PhaseExecutionId } from "./branded-types.js";

export interface PhaseConfig {
  id: PhaseId;
  // ...
}

export interface PhaseState {
  phaseExecutionId: PhaseExecutionId;
  sessionId: SessionId | null;
  previousSessionId: SessionId | null;
  // ...
}
```

### Update usage sites

**File**: `server/langton-server.ts`

**Current**:

```typescript
private async startPhase(phaseId: string, skipPreCommands?: boolean): Promise<void> {
```

**Change to**:

```typescript
private async startPhase(phaseId: PhaseId, skipPreCommands?: boolean): Promise<void> {
```

**When creating IDs**:

```typescript
// Current
phaseExecutionId: generateId(),

// Change to
phaseExecutionId: PhaseExecutionId(generateId()),
```

### Practical Example - Preventing Real Bugs

**The bug this prevents**:

```typescript
// BEFORE: This compiles but is wrong!
const handlePhaseComplete = (sessionId: string, phaseId: string) => {
  // Oops, arguments are swapped
  completedPhases.push({
    phaseId: sessionId, // Wrong!
    sessionId: phaseId, // Wrong!
  });
};

// Somewhere else...
handlePhaseComplete(phase.sessionId, phase.id); // Runtime error!

// AFTER: This won't compile
const handlePhaseComplete = (sessionId: SessionId, phaseId: PhaseId) => {
  completedPhases.push({
    phaseId: sessionId, // ❌ Type error: SessionId not assignable to PhaseId
    sessionId: phaseId, // ❌ Type error: PhaseId not assignable to SessionId
  });
};
```

**Reasoning**: Prevents mixing up different ID types at compile time.

**Implications**:

- Requires updating all ID creation sites
- Type errors will appear where IDs are mixed up
- No runtime impact

---

## 3. Exit Code Types

**File**: `server/types.ts`

**Current**:

```typescript
export interface PhaseCompletedEvent extends ServerEvent {
  data: {
    exitCode: number | null;
  };
}
```

**Change to**:

```typescript
export type ProcessExit =
  | { type: "success" }
  | { type: "error"; code: number }
  | { type: "killed"; signal: NodeJS.Signals };

export interface PhaseCompletedEvent extends ServerEvent {
  data: {
    exitStatus: ProcessExit;
    // ... other fields
  };
}
```

**File**: `server/langton-server.ts`

**Current**:

```typescript
const success = exitCode === 0 && !this.isShuttingDown;
```

**Change to**:

```typescript
const exitStatus: ProcessExit =
  exitCode === 0 ? { type: "success" } : { type: "error", code: exitCode };

const success = exitStatus.type === "success" && !this.isShuttingDown;
```

**Reasoning**: Makes success explicit, distinguishes error types.

**Implications**: Breaking change for WebSocket protocol.

---

## 4. Exhaustive Checking

**File**: `server/utils.ts`

**Add**:

```typescript
export function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(x)}`);
}
```

**File**: `server/langton-server.ts`

**Current**:

```typescript
switch (command.type) {
  case "phase.start":
    // ...
    break;
  case "phase.next":
    // ...
    break;
  // ... other cases
  default:
    this.logger.log(`Unknown command type: ${command.type}`, "error");
}
```

**Change to**:

```typescript
switch (command.type) {
  case "phase.start":
    // ...
    break;
  case "phase.next":
    // ...
    break;
  // ... other cases
  default:
    assertNever(command);
}
```

**Apply to**:

- `handleCommand` in `langton-server.ts`
- `handleServerEvent` in `basic-tui.ts`
- Any switch on union types

**Reasoning**: TypeScript will error if a case is missing.

**Implications**: Compile-time safety for new event/command types.

---

## 5. Zod Validation at Boundaries

**File**: `server/command-schemas.ts` (new file)

```typescript
import { z } from "zod";
import { PhaseId } from "./branded-types.js";

const phaseIdSchema = z.string().transform(PhaseId);

export const clientCommandSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string(),
    type: z.literal("phase.start"),
    data: z.object({
      phaseId: phaseIdSchema,
      skipPreCommands: z.boolean().optional(),
    }),
  }),
  z.object({
    id: z.string(),
    type: z.literal("phase.next"),
  }),
  z.object({
    id: z.string(),
    type: z.literal("phase.skip"),
  }),
  z.object({
    id: z.string(),
    type: z.literal("phase.redo"),
  }),
  z.object({
    id: z.string(),
    type: z.literal("server.shutdown"),
  }),
]);

export type ClientCommand = z.infer<typeof clientCommandSchema>;
```

**File**: `server/langton-server.ts`

**Current**:

```typescript
private handleMessage(ws: ServerWebSocket<ClientData>, message: string | Buffer): void {
  try {
    ws.data.lastActivity = new Date();
    const parsed = JSON.parse(message.toString());
    if (!isValidClientCommand(parsed)) {
      this.logger.log("Invalid client command received", "error");
      return;
    }
    this.logger.logSocketTraffic(this.config.socketLogFile, "in", parsed);
    this.handleCommand(parsed);
  } catch (error) {
    this.logger.log(`Error parsing command: ${toError(error).message}`, "error");
  }
}
```

**Change to**:

```typescript
private handleMessage(ws: ServerWebSocket<ClientData>, message: string | Buffer): void {
  try {
    ws.data.lastActivity = new Date();

    const parsed = JSON.parse(message.toString());
    const result = clientCommandSchema.safeParse(parsed);

    if (!result.success) {
      this.logger.log(`Invalid client command: ${result.error.message}`, "error");
      this.sendError("Invalid command format", false);
      return;
    }

    this.logger.logSocketTraffic(this.config.socketLogFile, "in", result.data);
    this.handleCommand(result.data);
  } catch (error) {
    this.logger.log(`Error parsing command: ${toError(error).message}`, "error");
  }
}
```

**Reasoning**: Validates and transforms data at the boundary.

**Implications**:

- Better error messages
- Type transformation happens during parsing
- Can remove type guards

---

## 6. Phase State Discriminated Unions

**File**: `server/types.ts`

**Current**:

```typescript
export interface PhaseState {
  phase: PhaseConfig;
  phaseExecutionId: string;
  sessionId: string | null;
  previousSessionId: string | null;
  isRunning: boolean;
  startTime: Date;
  phaseCost: number;
  phaseTokens: TokenUsage;
}
```

**Change to**:

```typescript
export type PhaseState =
  | {
      status: "initializing";
      phase: PhaseConfig;
      phaseExecutionId: PhaseExecutionId;
      previousSessionId: SessionId | null;
      startTime: Date;
    }
  | {
      status: "running";
      phase: PhaseConfig;
      phaseExecutionId: PhaseExecutionId;
      sessionId: SessionId;
      previousSessionId: SessionId | null;
      startTime: Date;
      phaseCost: number;
      phaseTokens: TokenUsage;
    };
```

**File**: `server/langton-server.ts`

**Update creation**:

```typescript
// Current
this.currentPhase = {
  phase,
  phaseExecutionId: generateId(),
  sessionId: null,
  previousSessionId,
  isRunning: true,
  startTime: new Date(),
  phaseCost: 0,
  phaseTokens: {
    /* ... */
  },
};

// Change to
this.currentPhase = {
  status: "initializing",
  phase,
  phaseExecutionId: PhaseExecutionId(generateId()),
  previousSessionId,
  startTime: new Date(),
};

// Then when Claude sends init
this.currentPhase = {
  status: "running",
  phase: this.currentPhase.phase,
  phaseExecutionId: this.currentPhase.phaseExecutionId,
  sessionId: SessionId(msg.session_id),
  previousSessionId: this.currentPhase.previousSessionId,
  startTime: this.currentPhase.startTime,
  phaseCost: 0,
  phaseTokens: {
    /* ... */
  },
};
```

**Reasoning**: Makes impossible states unrepresentable.

**Implications**: Must handle both states in code that uses PhaseState.

---

## 7. Model Name Union Types

**File**: `server/types.ts`

**Current**:

```typescript
export interface PhaseConfig {
  model: string;
}
```

**Change to**:

```typescript
export type ModelName = "sonnet" | "opus";

export interface PhaseConfig {
  model: ModelName;
}
```

**File**: `server/config.ts`

**Current**:

```typescript
model: z.string().min(1, "Model name cannot be empty"),
```

**Change to**:

```typescript
model: z.enum(["sonnet", "opus"]),
```

**Reasoning**: Compile-time validation of model names.

**Implications**:

- Config validation will fail for invalid models
- Autocomplete in IDEs
- Easy to add new models

---

## 8. Synthetic Message Types

**File**: `server/types.ts`

**Add**:

```typescript
export interface SyntheticTimeoutMessage {
  type: "assistant";
  message: {
    id: string;
    type: "message";
    role: "assistant";
    model: "<synthetic>";
    content: "API Error: Request timed out.";
    usage?: never;
    stop_reason: null;
    stop_sequence: null;
  };
}

export function isSyntheticTimeout(
  msg: AssistantMessage
): msg is SyntheticTimeoutMessage {
  return (
    msg.message.model === "<synthetic>" &&
    msg.message.content === "API Error: Request timed out."
  );
}
```

**File**: `server/langton-server.ts`

**Use the type guard**:

```typescript
private handleAssistantMessage(msg: AssistantMessage, phaseId: string): void {
  if (isSyntheticTimeout(msg)) {
    this.logger.log(`API timeout detected in synthetic message for phase ${phaseId}`, "error");
    // Handle timeout
    return;
  }
  // ... rest of handling
}
```

**Reasoning**: Documents and enforces the special synthetic message structure.

**Implications**: Clear separation of synthetic vs real messages.

---

## 9. Boolean to Union Conversions

**File**: `server/types.ts`

**Current**:

```typescript
export interface PhaseConfig {
  continueFromPrevious?: boolean;
}
```

**Change to**:

```typescript
export type ContinuationMode = "fresh" | "continue-previous";

export interface PhaseConfig {
  continuationMode: ContinuationMode;
}
```

**File**: `server/config.ts`

**Update schema**:

```typescript
continuationMode: z.enum(["fresh", "continue-previous"]),
// No default - user must be explicit
```

**Migration helper for existing configs**:

```typescript
// In config loading
const migrated = {
  ...config,
  continuationMode:
    config.continuationMode ??
    (config.continueFromPrevious ? "continue-previous" : "fresh"),
};
```

**Reasoning**: Continuation behavior is a critical decision that should be explicit. No default prevents accidental continuation or fresh starts.

**Implications**:

- Config files must specify continuation mode
- Breaking change for existing configs
- More explicit intent in configurations

---

## 10. Const Assertions for Timeouts

**File**: `server/config.ts`

**Current**:

```typescript
export const TIMEOUTS = {
  RESULT_MESSAGE_MS: 30000,
  PROCESS_KILL_GRACE_MS: 5000,
  LOG_PARSER_DELAY_MS: 100,
  PHASE_CLEANUP_DELAY_MS: 100,
};
```

**Change to**:

```typescript
export const TIMEOUTS = {
  RESULT_MESSAGE_MS: 30000,
  PROCESS_KILL_GRACE_MS: 5000,
  LOG_PARSER_DELAY_MS: 100,
  PHASE_CLEANUP_DELAY_MS: 100,
} as const;

export type TimeoutKey = keyof typeof TIMEOUTS;
export type TimeoutValue = (typeof TIMEOUTS)[TimeoutKey];
```

**Usage improvement**:

```typescript
// Instead of magic numbers
setTimeout(() => {}, 30000);

// Use the const
setTimeout(() => {}, TIMEOUTS.RESULT_MESSAGE_MS);
```

**Reasoning**: Makes timeout values discoverable and type-safe.

**Implications**: Can't accidentally modify timeout values.

---

## 11. Error Handling Improvements

**Already exists in utils.ts but needs consistent usage**:

**File**: `server/langton-server.ts` and others

**Current** (various places):

```typescript
} catch (error) {
  this.logger.log(`Error: ${error}`, "error");
}
```

**Change to**:

```typescript
} catch (error) {
  this.logger.log(`Error: ${toError(error).message}`, "error");
}
```

\*\*Apply to all catch blocks that don't already use `toError`.

**Reasoning**: Preserves stack traces and ensures error is Error instance.

**Implications**: Better error messages in logs.

---

## 12. Tightening Optional/Null Types

### Phase-related fields

**File**: `server/types.ts`

**For events - keep optional where appropriate**:

```typescript
export interface PhaseStartedEvent extends ServerEvent {
  data: {
    phaseDescription?: string; // Keep optional - not all phases have descriptions
    previousSessionId?: string; // Keep optional - not all phases continue
  };
}
```

**For configs - be explicit**:

```typescript
export interface PhaseConfig {
  id: PhaseId;
  name: string; // Required - every phase needs a name
  model: ModelName; // Required - must specify model explicitly
  description?: string; // Optional - genuinely optional metadata
  watch?: string; // Optional - not all phases need file watching
  checkpointAndWatch?: string[]; // Optional - not all phases need checkpoints
  workspaceSetup?: WorkspaceSetupItem[]; // Optional - not all phases need setup
  // ... other fields
}
```

**Reasoning**: Distinguish between:

- **Truly optional**: Information that may not exist (descriptions, previous sessions, watch patterns)
- **Required with defaults**: Common cases with sensible defaults (workingDirectory)
- **Always required**: Critical configuration that must be explicit (model, name, promptFile/promptText)

### File node discrimination

**Current**:

```typescript
export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  lastModified?: string;
  children?: FileNode[];
}
```

**Change to**:

```typescript
export type FileNode =
  | {
      name: string;
      path: string;
      isDirectory: true;
      children: FileNode[]; // Always present for directories
    }
  | {
      name: string;
      path: string;
      isDirectory: false;
      lastModified: string; // Always present for files
      children: FileNode[]; // Empty array for files
    };
```

### Workspace setup discrimination

**Current**:

```typescript
export interface WorkspaceSetupItem {
  type: "copy" | "command";
  copy?: {
    from: string;
    to: string;
  };
  command?: {
    run: string;
    workingDirectory?: "project" | "lastCopied";
  };
}
```

**Change to**:

```typescript
export type WorkspaceSetupItem =
  | {
      type: "copy";
      copy: {
        from: string;
        to: string;
      };
    }
  | {
      type: "command";
      command: {
        run: string;
        workingDirectory: "project" | "lastCopied"; // Has default in schema
      };
    };
```

### System prompt fields remain optional

**Keep as-is**:

```typescript
export interface PhaseConfig {
  appendSystemPromptFile?: string | string[]; // Genuinely optional
  appendSystemPromptText?: string; // Genuinely optional
  // These are optional features - not all phases need system prompts
}
```

**Reasoning**: System prompts are an optional enhancement. Their absence doesn't indicate a missing decision - it means "no additional system prompt needed".

### Process manager state

**File**: `server/claude-process-manager.ts`

**Current**:

```typescript
private process: ChildProcess | null = null;
```

**Change to**:

```typescript
private process: ChildProcess | undefined;
```

**Reasoning**: Consistent use of undefined over null.

### Null to undefined conversions

**Files**: Various

Replace all instances of:

- `sessionId: string | null` → `sessionId: SessionId | undefined`
- `previousSessionId: string | null` → `previousSessionId: SessionId | undefined`
- `watchedPattern: string | null` → `watchedPattern: string | undefined`
- `recentFileAccess: {...} | null` → `{...} | undefined`

---

## 13. Missing Type Additions

### Path types

**File**: `server/branded-types.ts`

**Add**:

```typescript
export type LogPath = Branded<string, "LogPath">;
export type GlobPattern = Branded<string, "GlobPattern">;
export type ShellCommand = Branded<string, "ShellCommand">;

export const LogPath = (path: string): LogPath => {
  if (!path.match(/^log-.*\.jsonl$/)) {
    throw new Error("Invalid log path format");
  }
  return path as LogPath;
};

export const GlobPattern = (pattern: string): GlobPattern =>
  pattern as GlobPattern;
export const ShellCommand = (cmd: string): ShellCommand => cmd as ShellCommand;
```

### Template literal types

**File**: `server/types.ts`

**For message IDs**:

```typescript
export type ClaudeMessageId = `msg_${string}`;
export type UUIDMessageId = string; // Keep flexible for UUIDs

export type MessageId = ClaudeMessageId | UUIDMessageId;
```

**For execution IDs**:

```typescript
// In branded-types.ts
export type PhaseExecutionId = Branded<
  `${number}-${string}`,
  "PhaseExecutionId"
>;

export const PhaseExecutionId = (
  timestamp: number,
  random: string
): PhaseExecutionId => `${timestamp}-${random}` as PhaseExecutionId;
```

### Event data generics

**File**: `server/types.ts`

**Current**:

```typescript
export interface ServerEvent {
  id: string;
  timestamp: string;
  type: string;
}
```

**Change to**:

```typescript
export interface ServerEvent<T extends string = string, D = unknown> {
  id: EventId;
  timestamp: string;
  type: T;
  data?: D;
}

// Then update specific events
export interface PhaseStartedEvent
  extends ServerEvent<
    "phase.started",
    {
      phaseId: PhaseId;
      phaseName: string;
      // ... rest of data
    }
  > {}
```

---

## 14. Claude Log Validation Strategy

### Minimal validation approach

**File**: `types/claude-session-schema.ts`

**Keep loose**:

```typescript
// For tool names - accept any string
const toolNameSchema = z.string(); // Not z.enum()

// For tool inputs - accept any object
const toolInputSchema = z.record(z.unknown());

// For model names - accept pattern, not specific values
const modelSchema = z.string().regex(/^(claude-.*|<synthetic>)$/);

// For new fields - make everything optional
const usageSchema = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    // Allow any other fields
  })
  .passthrough();
```

### What to validate strictly

**Critical for operation**:

```typescript
// Message structure
z.object({
  type: z.enum(["system", "assistant", "user", "result"]),
  // Other fields optional/loose
}).passthrough();

// Session ID when present
session_id: z.string().uuid().optional();

// Result status (needed for branching)
subtype: z.enum(["success", "error"]).optional();
```

**Reasoning**: Accept new fields gracefully while validating critical structure.

**Implications**: Won't break when Claude adds new features.

---

## 15. Type-Safe Event Emitter

**File**: `server/typed-event-emitter.ts` (new file)

```typescript
import { EventEmitter } from "node:events";

export class TypedEventEmitter<T extends Record<string, any[]>> {
  private emitter = new EventEmitter();

  on<K extends keyof T>(event: K, listener: (...args: T[K]) => void): this {
    this.emitter.on(event as string, listener);
    return this;
  }

  off<K extends keyof T>(event: K, listener: (...args: T[K]) => void): this {
    this.emitter.off(event as string, listener);
    return this;
  }

  emit<K extends keyof T>(event: K, ...args: T[K]): boolean {
    return this.emitter.emit(event as string, ...args);
  }

  once<K extends keyof T>(event: K, listener: (...args: T[K]) => void): this {
    this.emitter.once(event as string, listener);
    return this;
  }
}

// Define server event map
export interface ServerInternalEvents {
  event: [ServerEvent];
  exit: [code: number];
  error: [error: Error];
  stdout: [data: string];
  stderr: [data: string];
}
```

**File**: `server/langton-server.ts`

**Current**:

```typescript
export class LangtonServer extends EventEmitter {
```

**Change to**:

```typescript
import { TypedEventEmitter, type ServerInternalEvents } from "./typed-event-emitter.js";

export class LangtonServer extends TypedEventEmitter<ServerInternalEvents> {
```

**File**: `server/claude-process-manager.ts`

**Current**:

```typescript
export class ClaudeProcessManager extends EventEmitter {
```

**Change to**:

```typescript
interface ProcessEvents {
  'exit': [code: number];
  'error': [error: Error];
  'stdout': [data: string];
  'stderr': [data: string];
}

export class ClaudeProcessManager extends TypedEventEmitter<ProcessEvents> {
```

**Reasoning**: Compile-time checking for event names and argument types.

**Implications**:

- Can't emit events with wrong arguments
- Autocomplete for event names
- Type-safe event listeners

---

## 16. Checkpoint Status Types

**File**: `server/types.ts`

**Current**:

```typescript
export type CheckpointStatus =
  | "workspace-setup"
  | "completed"
  | "error"
  | "exit"
  | "skipped";
```

**Change to (more explicit)**:

```typescript
export const CHECKPOINT_STATUS = {
  WORKSPACE_SETUP: "workspace-setup",
  COMPLETED: "completed",
  ERROR: "error",
  EXIT: "exit",
  SKIPPED: "skipped",
} as const;

export type CheckpointStatus =
  (typeof CHECKPOINT_STATUS)[keyof typeof CHECKPOINT_STATUS];
```

**Usage improvement**:

```typescript
// Instead of magic strings
await this.createCheckpoint({
  status: "completed", // Could typo
  // ...
});

// Use the const
await this.createCheckpoint({
  status: CHECKPOINT_STATUS.COMPLETED,
  // ...
});
```

**Reasoning**: Prevents typos, provides autocomplete, single source of truth.

**Implications**: Update all checkpoint creation sites.

---

## Additional Context: Tool Input Flexibility

**Important Design Decision**: The tool input typing remains flexible by design.

**File**: `server/types.ts`

Keep current implementation:

```typescript
export interface AssistantActionEvent extends ServerEvent {
  data: {
    toolName?: string; // NOT restricted to ToolName union
    toolInput?: Record<string, unknown>; // NOT typed to specific tools
  };
}
```

**Reasoning**:

- Claude may use new tools not known to the server
- Server should forward unknown tools without breaking
- Type safety is less important than forward compatibility here

**Pattern for handling**:

```typescript
// Type guard for known tools
if (isKnownTool(toolName)) {
  // Full type safety for known tools
  const typedInput = toolInput as ToolInputMap[typeof toolName];
} else {
  // Pass through unknown tools
  this.logger.log(`Unknown tool: ${toolName}`);
}
```



---

## Implementation Order

At each point, run `bun lint:fix` followed by `bun run build` to see the errors. Once good, run `bun test:unit` to run the unit tests. DO NOT RUN `bun test` or `bun test:e2e`. Ask the user to.

### Prerequisites

Ensure TypeScript strict mode is enabled in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "strict": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "noImplicitAny": true
  }
}
```

### Group 1: Pure Type Changes (No Runtime Impact)

These changes only affect compile-time checking:

- Add const assertions for TIMEOUTS
- Create branded types file (without using them yet)
- Add exhaustive checking helper (assertNever)
- Define new type aliases (ModelName, ProcessExit, etc.)
- Add type definitions for missing types

### Group 2: Internal Type Tightening (No API Changes)

These affect internal behavior but not external APIs:

- Fix error handling with toError
- Convert model string to ModelName union
- Tighten optional/null types for internal state
- Replace null with undefined consistently
- Fix undefined semantic anti-patterns (add default ONLY for workingDirectory)
- Keep genuinely optional fields optional (description, previousSessionId)

### Group 3: Branded Type Implementation

Systematic ID type replacement:

- Update all ID type definitions to use branded types
- Update ID creation sites to use brand functions
- Fix type errors where IDs were mixed
- Update type guards to handle branded types

### Group 4: Discriminated Union Refactors

More complex type changes:

- Phase state discriminated union
- File node discriminated union
- Workspace setup item discriminated union
- Exit code to ProcessExit type

### Group 5: WebSocket Protocol Changes (Breaking)

These change the client-server contract:

- Implement Zod validation for commands
- Change event data structures
- Update synthetic message handling
- Add generic types to ServerEvent



### Group 6: Configuration Format Changes (User-Facing)

These affect how users write config files:

- Boolean to union conversions (continuationMode) - NO DEFAULT
- Required fields WITHOUT defaults (model, name, continuationMode)
- Optional fields that remain optional (description)
- Fields with sensible defaults (workingDirectory: "project")

**Important**: Most fields should NOT have defaults. Users should make explicit choices about:

- Which model to use
- Whether to continue from previous phases
- Phase names and IDs



### Group 7: Claude Log Validation Updates

Loosening validation for forward compatibility:

- Make tool validation more permissive
- Allow unknown fields with passthrough
- Keep only critical validations

