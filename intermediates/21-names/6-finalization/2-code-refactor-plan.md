This is the **Master Migration Specification** for converting the **Tadpole** codebase to **Hankweave Runtime**.

This document is designed for an AI agent or developer to follow step-by-step. It prioritizes safety and cohesion over speed.

### ⚠️ Agent Instructions (Read First)

1.  **No Blind Global Find/Replace**: Do **not** run a global regex replace across the entire project. Context matters. You must verify that you are not renaming dependencies (e.g., external libraries) or breaking standard English sentences in comments unless they refer to the system architecture.
2.  **File-by-File Execution**: Perform renames and edits file-by-file or directory-by-directory. This limits the blast radius of errors.
3.  **Compile Often**: If possible, run `bun tc` (typecheck) between major steps. The TypeScript compiler is your best friend here—breaking types intentionally to find all references is a valid strategy.
4.  **Update Imports**: When files are renamed, you must update the imports in consuming files immediately to maintain a traversable graph.

---

### 1. The Dictionary

Use this as the absolute source of truth.

| Concept | Old Name | New Name | Context / Usage |
| :--- | :--- | :--- | :--- |
| **Project Name** | Tadpole | **Hankweave** | The runtime, the CLI tool, the branding. |
| **Input Program** | Tadprogram / Phase Config | **Hank** | The combination of the sequence JSON and prompt files. |
| **Execution Unit** | Phase | **Codon** | The atomic step in a workflow. |
| **Setup** | Workspace / workspaceSetup | **Rig** / **rigSetup** | Preparing the environment (files/commands) before AI runs. |
| **Observer** | Chronicler | **Sentinel** | Parallel agents watching the event stream. |
| **Config File** | `phases.json` | `codon-sequence.json` | The default configuration file name. |
| **State Dir** | `.tadpole` | `.hankweave` | The hidden folder tracking state. |
| **Executions** | `.tadpole-executions` | `.hankweave-executions` | Where runs actually happen. |
| **Events** | `phase.*`, `chronicler.*` | `codon.*`, `sentinel.*` | Wire protocol event types. |

---

### 2. Step-by-Step Execution Plan

#### Step 1: File System Restructuring
*Goal: Rename files and directories to match new domains. This will temporarily break imports.*

1.  **Main Server File**:
    *   Rename `server/tadpole-server.ts` $\rightarrow$ `server/hankweave-runtime.ts`.
2.  **Chroniclers $\rightarrow$ Sentinels**:
    *   Rename directory `server/chroniclers/` $\rightarrow$ `server/sentinels/`.
    *   Inside that directory, rename:
        *   `chronicler.ts` $\rightarrow$ `sentinel.ts`
        *   `chronicler-manager.ts` $\rightarrow$ `sentinel-manager.ts`
        *   `chronicler-config-loader.ts` $\rightarrow$ `sentinel-config-loader.ts`
        *   `chronicler-defaults.ts` $\rightarrow$ `sentinel-defaults.ts`
        *   `chronicler-fatal-error.ts` $\rightarrow$ `sentinel-fatal-error.ts`
3.  **Configuration Validation**:
    *   Rename `server/config-validation/chronicler.schema.ts` $\rightarrow$ `server/config-validation/sentinel.schema.ts`.
4.  **Types**:
    *   Rename `server/types/chronicler-types.ts` $\rightarrow$ `server/types/sentinel-types.ts`.

---

#### Step 2: Core Types & Schemas (The Skeleton)
*Goal: Update the definitions. This will cause TypeErrors everywhere, highlighting exactly what needs to change in the logic.*

**Target: `server/types/branded-types.ts`**
*   Rename `PhaseId` $\rightarrow$ `CodonId`.
*   (Keep `RunId`, `SessionId`, `EventId` as is).

**Target: `server/types/types.ts`**
*   Rename interface `Phase` $\rightarrow$ `Codon`.
*   Rename interface `PhaseConfig` $\rightarrow$ `CodonConfig`.
*   Rename interface `Loop` property `phases` $\rightarrow$ `codons`.
*   Rename `WorkspaceSetupItem` $\rightarrow$ `RigSetupItem`.
*   Rename `WorkspaceShellCommand` $\rightarrow$ `RigShellCommand`.
*   Rename `PhaseChroniclerEntry` $\rightarrow$ `CodonSentinelEntry`.
    *   Inside this: `chroniclerConfig` $\rightarrow$ `sentinelConfig`.

**Target: `server/types/state-types.ts`**
*   Rename `ChroniclerState` $\rightarrow$ `SentinelState`.
*   Rename `PhaseStatus` $\rightarrow$ `CodonStatus`.
*   Rename `PhaseExecution` $\rightarrow$ `CodonExecution`.
*   Rename specific states:
    *   `PreparingPhase` $\rightarrow$ `PreparingCodon`
    *   `StartingPhase` $\rightarrow$ `StartingCodon`
    *   `InitializingPhase` $\rightarrow$ `InitializingCodon`
    *   `RunningPhase` $\rightarrow$ `RunningCodon`
    *   `CompletingChroniclersPhase` $\rightarrow$ `CompletingSentinelsCodon` (Note the double rename).
    *   `CompletedPhase` $\rightarrow$ `CompletedCodon`
    *   `FailedPhase` $\rightarrow$ `FailedCodon`
    *   `SkippedPhase` $\rightarrow$ `SkippedCodon`
*   In `Run` interface: `phases: PhaseExecution[]` $\rightarrow$ `codons: CodonExecution[]`.
*   In `TadpoleState` interface:
    *   Rename interface to `HankweaveState`.
    *   Rename `executionPlan` type to use `ExecutionCodonEntry` (see step 3).

**Target: `server/schemas/event-schemas.ts`**
*   **Breaking Change**: You must rename the string literals in the Zod schemas.
*   `phase.started` $\rightarrow$ `codon.started`
*   `phase.completed` $\rightarrow$ `codon.completed`
*   `phaseId` (property) $\rightarrow$ `codonId`
*   `phaseName` (property) $\rightarrow$ `codonName`
*   `chronicler.loaded` $\rightarrow$ `sentinel.loaded`
*   `chroniclerId` $\rightarrow$ `sentinelId`
*   `rollback.phaseCheckpoint` $\rightarrow$ `rollback.codonCheckpoint`
*   `rollback.workspaceCleanup` $\rightarrow$ `rollback.rigCleanup`
*   Update all `Export type` names to match (e.g., `PhaseStartedEvent` $\rightarrow$ `CodonStartedEvent`).

---

#### Step 3: Logic & Implementation (The Flesh)
*Goal: Resolve the compile errors generated by Step 2.*

**Target: `server/config.ts`**
*   Rename `loadPhaseConfig` $\rightarrow$ `loadCodonSequence`.
*   Rename `validatePhaseConfig` $\rightarrow$ `validateHank`.
*   Update `DEFAULT_CONFIG` paths:
    *   `.tadpole/logs/` $\rightarrow$ `.hankweave/logs/`
    *   `.tadpole/server.lock` $\rightarrow$ `.hankweave/runtime.lock`
*   Update validation error messages: "Phase" $\rightarrow$ "Codon", "Loop must contain phases" $\rightarrow$ "Loop must contain codons".

**Target: `server/execution-planner.ts`**
*   Rename `ExecutionPhaseEntry` $\rightarrow$ `ExecutionCodonEntry`.
*   Rename `phaseConfigs` $\rightarrow$ `codonConfigs`.
*   Logic: `generateIterationPhaseId` $\rightarrow$ `generateIterationCodonId`.

**Target: `server/state-manager.ts`**
*   Rename class `TadpoleState` references to `HankweaveState`.
*   Rename methods:
    *   `getCurrentlyRunningPhase` $\rightarrow$ `getCurrentlyRunningCodon`.
    *   `getPhaseById` $\rightarrow$ `getCodonById`.
    *   `getNextPhaseToExecute` $\rightarrow$ `getNextCodonToExecute`.
*   Logic: Update the `processQueue` loop to handle the new Event types (e.g., `CodonStarted` instead of `PhaseStarted`).

**Target: `server/checkpoint-git.ts`**
*   **Git Config**: Change user.name from "Tadpole Runner" to "Hankweave Runtime".
*   **Paths**: `.tadpole/checkpoints` $\rightarrow$ `.hankweave/checkpoints`.

**Target: `server/hankweave-runtime.ts` (formerly tadpole-server)**
*   **Class Name**: `TadpoleServer` $\rightarrow$ `HankweaveRuntime`.
*   **Lock File**: `.tadpole/server.lock` $\rightarrow$ `.hankweave/runtime.lock`.
*   **Methods**:
    *   `startPhase` $\rightarrow$ `startCodon`.
    *   `autoStartNextPhase` $\rightarrow$ `autoStartNextCodon`.
    *   `handlePhaseComplete` $\rightarrow$ `handleCodonComplete`.
*   **Logic**:
    *   Update `workspaceSetup` iteration to look for `rigSetup`.
    *   Update `chronicler` loading to look for `sentinels`.
    *   Update log file paths: `<codonId>-claude.log`.

**Target: `server/sentinels/sentinel-manager.ts` (formerly chronicler-manager)**
*   Rename class `ChroniclerManager` $\rightarrow$ `SentinelManager`.
*   Directory path: `.tadpole/chroniclers` $\rightarrow$ `.hankweave/sentinels`.
*   Logic: Ensure it listens to `codon.*` events, not `phase.*`.

---

#### Step 4: String Literals, Regex, and Environment Variables
*Goal: Catch the things TypeScript misses.*

**Target: Global Search**
*   Search for: `TADPOLE_`
    *   Replace with: `HANKWEAVE_` (e.g., `HANKWEAVE_API_KEY`).
    *   Special attention: `server/index.ts` (CLI args processing) and `server/config.ts` (env var loading).
*   Search for: `.tadpole`
    *   Replace with: `.hankweave` (check `.gitignore` resolution logic in `server/file-resolver.ts`).
*   Search for: `tadpole-results`
    *   Replace with: `hankweave-results` (Output directory default).
*   Search for: `phases.json`
    *   Replace with: `codon-sequence.json` (Default config file name).

**Target: `server/index.ts`**
*   CLI Help Text: Update "Tadpole Server" to "Hankweave Runtime".
*   Flags:
    *   `--phases` (if it exists) $\rightarrow$ `--sequence`.
    *   Logs: "Starting Tadpole Server..." $\rightarrow$ "Starting Hankweave Runtime...".

---

#### Step 5: The TUI (`server/basic-tui.ts`)
*Goal: Ensure the UI doesn't break.*

*   **Visuals**: Update console logs "Tadpole Server" $\rightarrow$ "Hankweave".
*   **Event Handling**:
    *   `case "phase.started"` $\rightarrow$ `case "codon.started"`.
    *   `case "phase.completed"` $\rightarrow$ `case "codon.completed"`.
    *   `case "chronicler.output"` $\rightarrow$ `case "sentinel.output"`.
*   **Commands**:
    *   Pressing `[n]` sends `codon.next` (not `phase.next`).
    *   Pressing `[s]` sends `codon.skip`.

---

#### Step 6: Clean Up

*   **package.json**:
    *   Change `"name"` to `"hankweave"`.
    *   Change `"bin"` entry if present: `"hankweave": "./server/index.ts"`.
*   **Execution Setup**:
    *   In `server/execution-setup.ts`, ensure the execution root is `~/.hankweave-executions`.
*   **Data Hasher**:
    *   Ensure hash calculation doesn't rely on string "tadpole" (it shouldn't, but check comments).

### Verification Checklist for the Agent

1.  [ ] Does `server/index.ts` load `codon-sequence.json` by default?
2.  [ ] Are all `TADPOLE_` environment variables renamed to `HANKWEAVE_`?
3.  [ ] Does `server/basic-tui.ts` correctly display `Codon Started`?
4.  [ ] Is the hidden state directory `.hankweave`?
5.  [ ] Does the git checkpoint commit message say `checkpoint(rig-setup)` instead of `workspace-setup`?
6.  [ ] Are all `Chronicler` references in `server/sentinels/*` gone?
7.  [ ] Does `bun tc` pass without errors?


This is an addendum of **deep-dive specifics** and **hidden references** that might be missed during a high-level rename. This covers internal type names, specific string interpolation patterns, and "homage" cleanup.

### 1. Deep Code References (Types & Classes)

These are specific internal names in files that don't always show up in a general "search for 'Tadpole'":

*   **`server/types/input-ai-types.ts`**:
    *   This entire file prefixes everything with `Tadpole`.
    *   `TadpoleModelMessage` $\rightarrow$ `HankweaveModelMessage`.
    *   `TadpoleSystemModelMessage`, `TadpoleUserModelMessage`, etc. $\rightarrow$ `HankweaveSystem...`.
    *   `assertTadpoleIsSubsetOfSdk` $\rightarrow$ `assertHankweaveIsSubsetOfSdk`.

*   **`server/types/error-types.ts`**:
    *   `TadpoleError` (Base class) $\rightarrow$ `HankweaveError`.
    *   `PhaseError` $\rightarrow$ `CodonError`.
    *   `APITimeoutError`: Check `phaseId` property inside constructor. Rename to `codonId`.

*   **`server/types/llm-call-types.ts`**:
    *   `TadpoleLlmCallParams` $\rightarrow$ `HankweaveLlmCallParams`.
    *   `TadpoleGenerateTextOptions`, etc. $\rightarrow$ `HankweaveGenerateTextOptions`.

*   **`server/utils.ts`**:
    *   `isTadpoleError` / `toTadpoleError` (if they exist, or if you see generic error handling referring to the old class name).

### 2. String Formatting, File Naming & Logic

These are runtime string constructions that need to be updated to match the new terminology.

*   **History File Naming (`server/sentinels/history-manager.ts`)**:
    *   Current: ``const filename = `${chroniclerId}-phase-${phaseId}.json`;``
    *   New: ``const filename = `${sentinelId}-codon-${codonId}.json`;``
    *   *Impact*: This changes the on-disk format. Since we are effectively breaking compatibility, this is acceptable, but crucial for consistency.

*   **Sentinel Output Naming (`server/sentinels/sentinel.ts`)**:
    *   Current: ``const filename = `${this.config.id}-${this.phaseId}-${timestamp}.${extension}`;``
    *   New: ``const filename = `${this.config.id}-${this.codonId}-${timestamp}.${extension}`;``
    *   *Note*: Check path generation in `generateLogFilePath`.

*   **Template Context (`server/sentinels/prompt-templating-engine.ts` & `sentinel.ts`)**:
    *   The context object passed to Eta templates currently has a key `phase`.
    *   Current: `phase: { id: ..., name: ... }`
    *   New: `codon: { id: ..., name: ... }`
    *   *Impact*: This changes the API for users writing prompts. Documentation must reflect that they now access `<%= it.codon.name %>` instead of `<%= it.phase.name %>`.

### 3. The "Homage" & Git Identity

In **`server/checkpoint-git.ts`**:
*   **Git User**: `user.name = Tadpole Runner` $\rightarrow$ `Hankweave Runtime`.
*   **Git Email**: `froggie@southbridge.ai` is a Tadpole reference (Frog/Tadpole).
    *   Rename to: `weaver@southbridge.ai` (Matches "Hankweave").
*   **Initial Commit Message**: "Initial checkpoint setup" (Safe, but check if it mentions Tadpole).

### 4. CLI & Validation Logic

In **`server/index.ts`**:
*   **Arg Validation Regex**:
    *   The `validPatterns` array might contain regexes specific to old flags if any existed (e.g. `--phase=...`).
    *   Help text block: This is a large template string. Read through it carefully. "Tadpole runs in an isolated execution directory..." $\rightarrow$ "Hankweave runs...".

In **`server/config.ts`**:
*   **Zod Error Map Messages**:
    *   There are custom error messages for Zod: `"Phase \"${phaseName}\" (${phaseId})..."`
    *   These must be updated to say `"Codon \"${codonName}\"..."`

### 5. Default & Hidden Paths

*   **`server/execution-setup.ts`**:
    *   Look for `execution-meta.json`. The file name is fine, but check the *content* written into it.
    *   Does it contain a `version` field that might be confused?
    *   The path `.tadpole/execution-meta.json` changes to `.hankweave/execution-meta.json`.

*   **`server/data-hasher.ts`**:
    *   The function `findExecutionDirs` searches `os.homedir(), ".tadpole-executions"`.
    *   Must search `.hankweave-executions`.

### 6. Package.json & Scripts

*   **`package.json`**:
    *   Name: `"tapole"` (Note the typo in your provided file "tapole" -> "tadpole"). Change to `"hankweave"`.
    *   Scripts often refer to paths: `bun server/index.ts`. If you rename the file to `server/hankweave-runtime.ts` (or similar entry point), update the scripts!
    *   **IMPORTANT**: The file `server/index.ts` is the entry point. You might NOT want to rename `index.ts` itself, but you *should* check imports inside it.

### 7. Agent Instructions (Refined)

Add these specific constraints for the agent:

1.  **"Codon" is not "Code"**: Be extremely careful when grepping for "code". Do not rename "code" to "codon". Only rename "phase" to "codon".
2.  **Case Sensitivity**:
    *   `Phase` -> `Codon` (Class names, Types)
    *   `phase` -> `codon` (Properties, variables)
    *   `PHASE` -> `CODON` (Constants, Enums like `ErrorSeverity.PHASE`)
3.  **Preserve "Legacy" references only if marked**: If you see comments explicitly marking something as "Legacy support for X", check if we still want to support it. (Decision: **Remove legacy Tadpole support**. We are doing a hard rename. Clean the code.)
4.  **Sentinel Configuration**: When updating `server/config-validation/sentinel.schema.ts` (formerly chronicler.schema.ts), remember that you are changing the **JSON Schema** that users write.
    *   Old JSON: `{ "chroniclers": [...] }`
    *   New JSON: `{ "sentinels": [...] }`
    *   Old JSON: `{ "failPhaseIfNotLoaded": true }` -> `{ "failCodonIfNotLoaded": true }` (See `settings` object).

### 8. One Final Check on "Rig"

In **`server/config.ts`** and **`server/types/types.ts`**:
*   `workspaceSetup` -> `rigSetup`.
*   `workspaceShellCommand` -> `rigShellCommand`.
*   The internal string literal `"lastCopied"` works for Rigs, but check the default working directory string:
    *   `type ShellCommandWorkingDirectory = "project";`
    *   Is "project" still the right word? Yes, the "project" is the user's data. Rigs operate on the project. This is fine.

### Summary of "Invisible" Renames

*   Event String Literals (`type: "phase.started"`)
*   Zod Schema Error Messages
*   Git User/Email
*   Template Context Keys (`it.phase` -> `it.codon`)
*   File Generation Naming Patterns (`${id}-phase-${id}.json`)
*   Error Class Names (`PhaseError`)