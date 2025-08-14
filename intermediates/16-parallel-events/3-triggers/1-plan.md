We're building a pretty large feature into our codebase (use README.md to get an understanding of the system), and we're starting with the trigger system. The intent here is to get triggers up and running and well tested before we build the rest. If we're successful, we have a configurable trigger system that reliably (and in a non-blocking way) triggers when the right events happen in the server.

## Introduction: The Chronicler System

This document outlines the plan for a new, parallel observation feature for the Tadpole Runner, named the **Chronicler System**. The core goal is to enable the extraction of information, evaluation of agent behavior, and generation of human-readable summaries by running lightweight, parallel LLM calls that observe the main agent's activity stream without interfering with it.

### Core Concept: What is a Chronicler?

A **Chronicler** is a configurable, non-blocking agent that subscribes to the event stream of a Tadpole phase. It acts as a dedicated "note-taker" or "observer," watching the primary agent work and producing its own derived outputs.

Key properties of a Chronicler include:

*   **Parallel & Non-Blocking:** Chroniclers run in parallel to the main agentic loop. They are architecturally prohibited from blocking, slowing down, or mutating the state of the core agent.
*   **Event-Driven:** They are consumers of the same `ServerEvent` stream that is sent to the client, making them passive listeners that react to activity rather than directing it.
*   **Data-Configurable:** Like phases, Chroniclers are defined entirely in JSON configuration files. This makes them easy to create, modify, and reuse without writing any new code.
*   **Modular & Reusable:** A Chronicler's configuration can be copied and pasted between different phases or even different projects to provide consistent analysis or summarization capabilities.
*   **Fault-Tolerant:** An error within a Chronicler (e.g., a failed API call, a malformed prompt) is a non-critical event. It will be logged, but it will never crash the main agent's phase or the Tadpole server itself.

### Intent & Value Proposition

The Chronicler system is designed to solve several challenges inherent in long-running, complex agentic workflows:

1.  **Offloading Cognitive Load:** The core agent should focus on its primary task. Asking it to also "take notes on interesting files" or "summarize its progress every 5 minutes" adds cognitive load, increases token usage, and can cause it to lose focus. Chroniclers offload this work entirely.
2.  **Structured Data Extraction:** The agent's activity stream is a rich but unstructured source of data. Chroniclers can act as "event source extractors," turning the stream of tool calls and messages into structured `.jsonl` files, which can be used for analysis or fed as clean input to future phases.
3.  **Real-time Evaluation & Monitoring:** During a phase that runs for hours, it's difficult to know if the agent is making progress or is stuck in a loop. A Chronicler can be configured to evaluate the agent's behavior and provide a real-time "quality score" or identify repetitive, unhelpful actions.
4.  **Enhanced UI & Readability:** The raw event stream can be verbose and difficult for a human to follow. A "Narrator" Chronicler can create a simplified, human-readable summary of the agent's actions, dramatically improving the user experience for long-running tasks.
5.  **Enabling New Capabilities:** The system opens the door to new features that don't belong in the core agent loop, such as real-time translation of the agent's output or creating specialized logs for different audiences (e.g., a technical log and a high-level business summary).

### Architectural Fit

The Chronicler system is designed to integrate seamlessly into the existing Tadpole architecture, leveraging its core strengths:

*   **Event Bus (`TadpoleServer` & `TypedEventEmitter`):** The server's event-driven nature is the perfect foundation. The `ChroniclerManager` will simply be another listener on the existing event bus.
*   **Configuration-Driven Design (`phases.json`):** The system's reliance on JSON configuration is extended to Chroniclers. They will be an optional array within the `PhaseConfig` schema, validated by Zod at startup.
*   **AI SDK:** Chroniclers will use the provided AI SDK (`generateObject`, `streamText`, etc.) for their LLM calls. This cleanly decouples them from the `ClaudeProcessManager` and `claude-cli`, which remain dedicated to the core agent.

### Impact on the System: Files to Modify & Create

Implementing this feature will involve changes to existing files and the creation of a new, dedicated `chroniclers` directory.

#### Existing Files to Modify:

1.  **`server/config.ts`:**
    *   The main `phaseConfigSchema` will be updated to include an optional `chroniclers` array, using the new `chroniclerConfigSchema`.
    *   The `validatePhaseConfig` function will be updated to orchestrate the validation of these new configurations.
2.  **`server/types/types.ts`:**
    *   New `ServerEvent` types will be added for Chronicler-specific communications to the client, such as `chronicler.output.stream`, `chronicler.output.complete`, and `chronicler.error`.
3.  **`server/tadpole-server.ts`:**
    *   The `TadpoleServer` class will be modified to instantiate and manage a `ChroniclerManager`.
    *   **`startPhase()`:** Will be updated to initialize the `ChroniclerManager` for the new phase.
    *   **`cleanupCurrentPhase()`:** Will be updated to shut down the active `ChroniclerManager`.
    *   The event emitter subscription will be set up here.

#### New Files & Modules to Create:

The bulk of the new code will be organized under a new `server/chroniclers/` directory:

1.  **`server/types/chronicler-types.ts`:** A new file containing all the TypeScript type definitions for the trigger and execution schemas (`ChroniclerTrigger`, `ChroniclerExecution`, etc.).
2.  **`server/config-validation/chronicler.schema.ts`:** A new file containing the comprehensive Zod schemas for validating Chronicler configurations.
3.  **`server/config-validation/event-schemas.ts`:** A new file that will map `ServerEventType` strings to Zod schemas for their `data` payloads, enabling the powerful path validation.
4.  **`server/chroniclers/chronicler-manager.ts`:** The main orchestrator that manages the lifecycle of all active Chroniclers for a given phase.
5.  **`server/chroniclers/chronicler.ts`:** A class representing a single, running Chronicler instance. It will manage its own state, trigger engine, and execution strategy.
6.  **`server/chroniclers/trigger-engine.ts`:** Contains the logic for both `EventTrigger` and `SequenceTrigger` evaluation.
7.  **`server/chroniclers/condition-evaluator.ts`:** A pure utility module for evaluating individual trigger conditions against event data.

### Reference Documentation

To fully understand the context for this plan, the following existing documentation and code are essential:

*   **`documentation/architecture.md`:** Provides the high-level overview of the event-driven system.
*   **`documentation/phase-system.md`:** Defines the concepts of Phases, Runs, and the lifecycle events that Chroniclers will listen to.
*   **`server/types/types.ts`:** The canonical source for all `ServerEvent` types and their data payloads.
*   **`ai-sdk-docs.md`:** The reference for how Chroniclers will make their parallel, non-blocking LLM calls.

## Plan: The Tadpole Chronicler Trigger System

### 1. Overview & Goals

This document outlines the design and implementation plan for the Tadpole Chronicler Trigger System. This system is a declarative, event-driven engine responsible for activating "Chroniclers"—parallel, non-blocking LLM agents that observe and process the main agent's activity stream.

**Core Goals:**

*   **Declarative:** All trigger logic must be definable in simple, human-readable JSON.
*   **Type-Safe:** The system will leverage TypeScript and Zod to catch configuration errors at build-time or server startup, not at runtime.
*   **Decoupled:** The trigger system must not block, slow down, or mutate the core agentic loop. It is a passive observer.
*   **Expressive:** The trigger DSL must be powerful enough to handle common real-world scenarios, including simple events, complex event sequences, and timing-based batching.
*   **Testable:** The design must facilitate isolated unit testing of trigger logic and integration testing against real event logs.

### 2. Core Concepts & Event Flow

The system is composed of two primary configuration objects for each Chronicler: the `trigger` (the "what") and the `execution` (the "how").

1.  **Event Source:** The `TadpoleServer`'s internal event emitter is the single source of truth, providing a real-time stream of `ServerEvent` objects.
2.  **Chronicler Manager:** A central manager listens to every event.
3.  **Trigger Evaluation:** For each event, the manager evaluates the `trigger` configuration of all active Chroniclers.
4.  **Execution Strategy:** When a trigger's conditions are met, the relevant event(s) are passed to the Chronicler's `execution` strategy handler.
5.  **LLM Job Queuing:** The execution handler formats a prompt and queues an asynchronous LLM call using a concurrency limiter.

**Visual Flow:**
```
 New ServerEvent
       │
       ▼
┌──────────────────────┐
│  ChroniclerManager   │
│ (Listens to all events) │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐   ┌──────────────────────┐   ┌──────────────────────┐
│  Chronicler A        │   │  Chronicler B        │   │  Chronicler C        │
│  - Does event match  │   │  - Does event match  │   │  - Does event match  │
│    trigger A?        │   │    trigger B?        │   │    trigger C?        │
└──────────┬───────────┘   └──────────┬───────────┘   └──────────┬───────────┘
           │ NO                       │ YES                      │ YES
           │                          │                          │
           ▼                          ▼                          ▼
        (Ignore)           ┌──────────────────────┐   ┌──────────────────────┐
                           │ Execution Strategy B │   │ Execution Strategy C │
                           │ (e.g., immediate)    │   │ (e.g., debounce)     │
                           └──────────┬───────────┘   └──────────┬───────────┘
                                      │                          │
                                      ▼                          ▼
                           ┌─────────────────────────────────────────┐
                           │      p-limit Concurrency Queue        │
                           │  [LLM Job B] [LLM Job C (pending)] ...  │
                           └─────────────────────────────────────────┘
```

### 3. The Canonical Schema

This is the definitive schema for the `trigger` and `execution` objects.

#### 3.1 TypeScript Definitions (`server/types/chronicler-types.ts`)

```typescript
import type { ServerEvent } from "./types";

type ServerEventType = ServerEvent['type'];

// --- Condition Logic ---
export interface EqualsCondition { operator: "equals" | "notEquals"; path: string; value: string | number | boolean | null; }
export interface InCondition { operator: "in" | "notIn"; path: string; value: Array<string | number>; }
export interface ContainsCondition { operator: "contains"; path: string; value: string; }
export interface MatchesCondition { operator: "matches"; path: string; value: string; }
export interface NumericComparisonCondition { operator: "greaterThan" | "lessThan"; path: string; value: number; }

/** A discriminated union ensuring the `value` type matches the `operator`. */
export type Condition = EqualsCondition | InCondition | ContainsCondition | MatchesCondition | NumericComparisonCondition;

// --- Trigger Logic ("The What") ---
export interface PatternStep { type: ServerEventType; conditions?: Condition[]; }
export interface EventTrigger { type: "event"; on: ServerEventType[]; conditions?: Condition[]; }
export interface SequenceTrigger {
  type: "sequence";
  interestFilter: { on: ServerEventType[]; };
  pattern: PatternStep[];
  options?: { consecutive?: boolean; };
}

/** Discriminated union of all possible trigger types. */
export type ChroniclerTrigger = EventTrigger | SequenceTrigger;

// --- Execution Logic ("The How") ---
export interface ImmediateExecution { strategy: "immediate"; }
export interface DebounceExecution { strategy: "debounce"; milliseconds: number; }
export interface CountExecution { strategy: "count"; threshold: number; }
export interface TimeWindowExecution { strategy: "timeWindow"; milliseconds: number; }

/** Discriminated union of all possible execution strategies. */
export type ChroniclerExecution = ImmediateExecution | DebounceExecution | CountExecution | TimeWindowExecution;
```

#### 3.2 Zod Schema for Validation (`server/config-validation/chronicler.schema.ts`)

*(This schema will be used by the main config loader to validate `phases.json` at startup.)*

```typescript
import { z } from "zod";
import { serverEventDataSchemas, serverEventTypes } from "./event-schemas"; // To be created

// --- Schemas ---
const conditionSchema = z.discriminatedUnion("operator", [ /* ... as defined in previous response ... */ ]);
const patternStepSchema = z.object({ /* ... as defined ... */ }).superRefine(/* ... */);
const eventTriggerSchema = z.object({ /* ... as defined ... */ });
const sequenceTriggerSchema = z.object({ /* ... as defined ... */ });

// --- Final Exports ---
export const chroniclerTriggerSchema = z.discriminatedUnion("type", [eventTriggerSchema, sequenceTriggerSchema])
  .superRefine((trigger, ctx) => { /* Path validation logic as defined in previous response */ });

export const chroniclerExecutionSchema = z.discriminatedUnion("strategy", [
    z.object({ strategy: z.literal("immediate") }),
    z.object({ strategy: z.literal("debounce"), milliseconds: z.number().int().positive() }),
    z.object({ strategy: z.literal("count"), threshold: z.number().int().positive() }),
    z.object({ strategy: z.literal("timeWindow"), milliseconds: z.number().int().positive() }),
]);
```

### 4. Trigger Evaluation Logic

This section details the algorithm for how the system will process events.

#### 4.1 `EventTrigger` Evaluation (Stateless)

This is the simplest form of evaluation, performed for every incoming `ServerEvent`.
1.  Check if the `event.type` is present in the trigger's `on` array. If not, stop.
2.  If `conditions` are defined, iterate through them. For each `condition`:
    a.  Resolve the `path` within the `event.data` object. A helper function `getValueByPath(event.data, condition.path)` will be needed. If the path is invalid or the value is `undefined`, the condition fails.
    b.  Evaluate the `operator` with the resolved value and the condition's `value`.
    c.  If any condition returns `false`, stop evaluation for this trigger.
3.  If all conditions pass, the trigger is considered **matched**. The event is passed to the execution strategy handler.

#### 4.2 `SequenceTrigger` Evaluation (Stateful)

This is more complex and requires the `Chronicler` instance to maintain state (`lastTriggerEventId`).
1.  On a new `ServerEvent`, check if `event.type` is the last event in the `interestFilter.on` array. If not, stop. (Otherwise it's not time to trigger).
2.  Retrieve all `ServerEvent`s from the global event log that occurred after `lastTriggerEventId`. This is the **search window**.
3.  Apply the `interestFilter` to the search window to produce a smaller list of **interesting events**.
4.  Check if the tail of the **interesting events** list matches the `trigger.pattern`.
    *   This involves iterating backwards from the end of the list and comparing each event against the corresponding `PatternStep` in the pattern.
    *   If `options.consecutive` is `true` (the default), the match must be exact and contiguous at the end of the list.
5.  If the pattern is fully matched:
    a.  The trigger is considered **matched**.
    b.  The list of events that formed the successful match is passed to the execution strategy handler.
    c.  Update the Chronicler's internal state: `lastTriggerEventId` is set to the ID of the last event in the matched sequence.

### 5. Implementation & Testing Plan

This is a step-by-step guide to building the feature.

#### Phase 1: Schemas, Types, and Validation

1.  **Create Type Files:**
    *   Create `server/types/chronicler-types.ts` with the TypeScript definitions.
    *   Create `server/config-validation/event-schemas.ts` and populate `serverEventDataSchemas` with Zod schemas for the `data` payload of every `ServerEvent`. This is a crucial, one-time task.
    *   Create `server/config-validation/chronicler.schema.ts` with the final Zod schemas.
2.  **Integrate into Config Loading:**
    *   In `server/config.ts`, update `phaseConfigSchema` to include `chroniclers: z.array(chroniclerConfigSchema).optional()`. Also allow for chroniclers to be separate json files.
    *   The existing validation logic in `validatePhaseConfig` will now automatically run our powerful Chronicler validation at startup.
3.  **Initial Tests:**
    *   Create `tests/unit/chronicler-validation.test.ts`.
    *   Create valid and invalid chronicler configs for real situations, and write tests that attempt to parse valid and invalid Chronicler JSON configurations, asserting that Zod produces the expected errors (e.g., for bad paths, invalid event types, operator/value mismatches).

#### Phase 2: The Core Logic and Unit Tests

1.  **Create `server/chroniclers/` Directory:** This will house the new logic.
2.  **Implement Condition Evaluator:**
    *   Create `server/chroniclers/condition-evaluator.ts`.
    *   Implement `evaluateCondition(condition: Condition, eventData: object): boolean`.
    *   Write extensive unit tests in `tests/unit/condition-evaluator.test.ts` covering every operator and edge cases (e.g., nested paths, missing paths).
3.  **Implement Trigger Engines:**
    *   Create `server/chroniclers/trigger-engine.ts`.
    *   Implement `EventTriggerEngine` and `SequenceTriggerEngine` classes. They will manage their internal state (`lastTriggerEventId` for sequence) and expose a method like `processEvent(event)`.
    *   Write unit tests in `tests/unit/trigger-engine.test.ts`. For `SequenceTriggerEngine`, feed it arrays of mock events and assert that it correctly identifies matching and non-matching patterns.

#### Phase 3: Manager and Integration

1.  **Implement `Chronicler` and `ChroniclerManager`:**
    *   Create `server/chroniclers/chronicler.ts`. This class represents a single running Chronicler. It will contain its trigger engine, execution strategy handler, and make the actual LLM calls via the AI SDK.
    *   Create `server/chroniclers/chronicler-manager.ts`. This class will be responsible for creating, managing, and destroying Chronicler instances for a phase. It will subscribe to the server's event stream.
2.  **Integrate into `TadpoleServer`:**
    *   In `TadpoleServer`, instantiate `ChroniclerManager` in `startPhase`.
    *   Hook it up to the event emitter: `this.on('event', this.chroniclerManager.handleEvent)`.
    *   Call its shutdown method in `cleanupCurrentPhase`.

#### Phase 4: Integration Testing with Real Logs

1.  **Create `tests/integration/chronicler-system.test.ts`:**
2.  **Build a Test Harness:** Create a function that:
    a.  Takes a `chroniclerConfig` object and a path to a `websocket.log` file as input.
    b.  Instantiates a `ChroniclerManager` with the config.
    c.  Reads the log file line by line, parsing each `ServerEvent`.
    d.  Feeds each event into the manager.
    e.  Mocks the LLM call function (`generateObject`, `generateText`) and records when it's called and with what payload.
3.  **Write Tests:**
    *   Use the real-world examples below to create test configurations.
    *   Run the harness against a real `websocket.log` file.
    *   Assert that the mocked LLM function was called the correct number of times, at the correct moments, and with the expected event data batched together.

### 6. Real-World Trigger Examples for Testing

These will be used to define test cases.

1.  **Narrator (Debounce):**
    ```json
    "trigger": { "type": "event", "on": ["assistant.action", "tool.result"] },
    "execution": { "strategy": "debounce", "milliseconds": 2500 }
    ```
2.  **File Writer Monitor (Immediate Event):**
    ```json
    "trigger": { "type": "event", "on": ["assistant.action"], "conditions": [{ "path": "toolName", "operator": "in", "value": ["Write", "Edit"] }] },
    "execution": { "strategy": "immediate" }
    ```
3.  **Stuck Agent Detector (Sequence):**
    ```json
    "trigger": {
      "type": "sequence",
      "interestFilter": { "on": ["tool.result"] },
      "pattern": [
        { "type": "tool.result", "conditions": [{ "path": "isError", "operator": "equals", "value": true }] },
        { "type": "tool.result", "conditions": [{ "path": "isError", "operator": "equals", "value": true }] },
        { "type": "tool.result", "conditions": [{ "path": "isError", "operator": "equals", "value": true }] }
      ]
    },
    "execution": { "strategy": "immediate" }
    ```