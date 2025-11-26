<intermediates/17-names/1-getting-all-the-terms-out/results/2-gemini.md>
### Core Execution Concepts

1.  **The Executable Plan**
    This is the user-authored configuration file (e.g., `phases.json`) that declaratively defines the entire multi-step task. It serves as the master blueprint or "program" that the system reads to understand the sequence of operations, their prompts, and their dependencies.

2.  **A Single Unit of Work (currently "Phase")**
    This is the fundamental, atomic building block of the Executable Plan, representing one discrete task for the AI to accomplish. Each unit is defined by its own prompt, model configuration, and environment, and it represents a single, logical step in the overall workflow.

3.  **The Primary AI Worker**
    This refers to the main, active agentic process that executes a single Unit of Work. It is the entity that receives the prompt, thinks, uses tools, modifies files, and carries the conversational context forward to complete its assigned task.

4.  **A Single Server Session (currently "Run")**
    This represents one complete lifecycle of the orchestration server, from the moment it starts until it shuts down. Each session has a unique identity, contains the execution history of one or more Units of Work, and forms an isolated branch in the versioning system.

5.  **The Logical Workflow History (currently "Execution Thread")**
    This is the reconstructed, coherent sequence of successfully completed tasks, even when they span across multiple Server Sessions due to rollbacks. It represents the project's "true" evolutionary path and is used to intelligently determine what the next logical Unit of Work should be.

### Observation & Meta-Processing

6.  **The Parallel Observer Agent (currently "Chronicler")**
    This is a non-blocking, event-driven agent that watches the Primary AI Worker's activity stream to perform its own parallel tasks. Its purpose is observation, analysis, summarization, or evaluation, and it never interferes with or delays the main workflow.

7.  **The LLM Request Interceptor (currently "LLM Proxy")**
    This is a middleware layer that sits between the AI Worker and the external LLM API. It transparently inspects, logs, and can modify all incoming requests and outgoing responses, enabling features like cost tracking, safety guardrails, and caching.

### Environment & State Concepts

8.  **The Isolated Workspace (currently "Execution Directory")**
    This is the sandboxed directory where all operations take place, keeping the user's original project pristine. It contains the linked source data, all generated files, logs, checkpoints, and state, ensuring that every run is contained and reproducible.

9.  **The Source Material (currently "Data Source" / "Data Folder")**
    This is the user's original project directory or single file that serves as the initial input for the entire process. The system treats this material as read-only, accessing it via a symlink or copy within the Isolated Workspace to guarantee data integrity.

10. **The State Snapshot (currently "Checkpoint")**
    This is a point-in-time snapshot of all tracked files within the Isolated Workspace, captured and managed by the internal "shadow" git repository. These snapshots are the atomic units that enable the system's powerful rollback and versioning capabilities.

### Supporting Concepts

11. **The Central Orchestrator (currently "Tadpole Server")**
    This is the core engine that reads the Executable Plan and manages the entire process. It is responsible for spinning up AI Workers, managing state, handling file I/O, creating Snapshots, and communicating with the user via its control interface.

12. **The Control Interface (currently "WebSocket Protocol" / "TUI")**
    This defines the API and mechanism through which a human user or programmatic client interacts with the Central Orchestrator. It's the channel for sending commands (like `start`, `skip`, `rollback`) and receiving the real-time stream of events from the system.

13. **The Preparatory Step (currently "Workspace Setup")**
    This is an automated sequence of operations, like copying files or running shell commands (`npm install`), that executes *before* a Unit of Work begins. Its function is to prepare the Isolated Workspace so the AI Worker has the necessary environment and dependencies to succeed.

14. **The Generated Artifacts (currently "Output files")**
    These are the final, tangible files and data produced as the result of the entire workflow. They represent the successful culmination of the AI's work, such as new source code, documentation, or a data analysis report, all residing within the Isolated Workspace.
</intermediates/17-names/1-getting-all-the-terms-out/results/2-gemini.md>

<intermediates/17-names/1-getting-all-the-terms-out/results/3-gpt5.md>
# Tier 1 — User-facing primitives (names we should settle first)

* **Tadpole Runner (the product)**

  * The orchestration server that runs complex, multi-step AI workflows with isolation, state, and rollback. It’s the thing people install/run and the anchor brand for everything else.

* **Program / Workflow (your “thing to run”)**

  * The authored set of steps and rules that tells Tadpole what to do; today this spans prompts, models, setup, and tracked files. We should pick one canonical word (Program vs Workflow) and stick to it everywhere.

* **Phase**

  * The atomic unit of work (a single focused task) with its own prompt, model, and tracking. Users think of these as the steps in their program.

* **Phase Config**

  * The JSON that defines a phase (prompt source, model, continuation, workspace setup, tracked files, env). It’s the developer-facing contract for how a phase behaves.

* **Core Agentic Loop**

  * The run-time loop that executes a phase: prompt → LLM/tool use → files/logs → result. It’s the mental model for “what’s happening right now” inside a phase.

* **Run**

  * A single end-to-end session of the server that executes one or more phases and collects their history. People use runs to compare approaches and recover after crashes.

* **Execution Thread**

  * The unified, logical timeline stitched across rollbacks and new runs to describe “what really happened” and “what’s next.” It’s what the server uses to advance to the correct next phase.

* **Execution Environment**

  * The isolated workspace where work actually happens (separate from your original data), created per execution directory. Users benefit because rollbacks are clean and their source stays untouched.

* **Data Source / Data Mount**

  * The input (file or directory) you point Tadpole at; it’s mounted read-only into the execution environment. This is the canonical way phases “see” your data.

* **Workspace Setup**

  * The pre-phase actions (copy scaffolds, run commands) that prep the environment before the agent starts. It’s how programs reliably bootstrap tools, templates, and dependencies.

* **Tracked Files**

  * The file globs Tadpole watches and checkpoints during a phase. They define what counts as “state” for diffs, rollbacks, and progress UI.

* **Checkpoint & Rollback**

  * Checkpoints are shadow-git commits of tracked files at critical moments; rollback jumps you back to one. This is the core safety net for experimentation and recovery.

* **Chroniclers (parallel observers)**

  * Sidecar agents that watch events and generate summaries, evaluations, logs, or alerts without blocking the main loop. They make long runs understandable, auditable, and safer in real time.

* **Outputs / Artifacts**

  * The files the system produces (reports, code, logs, docs) in predictable locations within the execution environment. Clear naming here helps users find results quickly and automate downstream steps.

# Tier 2 — Integrator & operator concepts (names to standardize for docs/SDKs)

* **Continuation Mode**

  * Controls whether a phase starts fresh or continues the previous conversation context. It’s key to building multi-turn workflows without mega-prompts.

* **Model Profile**

  * The choice of model (e.g., Sonnet/Opus) and its parameters for a phase. A consistent term helps when we expose defaults, costs, and limits.

* **Server & Socket (Protocol)**

  * The single-client WebSocket server and the JSON event/command protocol it speaks. This is the API surface for UIs and automations.

* **Basic TUI**

  * The built-in terminal client that shows live events and offers hotkeys (next/skip/rollback). It’s the default operator cockpit for local runs.

* **Tool Use & Tool Result Tracking**

  * Structured capture of every tool invocation and its outcome (timings, errors, truncation). This is the spine for observability, evals, and “stuck” detection.

* **Cost & Token Usage**

  * Real-time accounting of input/output tokens and dollars per interaction/phase/run. It enables budgets, alerts, and post-mortems.

* **File Events & File Tree**

  * Live notifications of created/changed/deleted tracked files and a rolling tree snapshot. These power the UI, chroniclers, and checkpoints.

* **Shadow Git Repository**

  * A separate git repo used only for checkpoints, with per-run branches and structured commit messages. It keeps versioning powerful without touching the user’s repo.

* **State Manager (Event-sourced)**

  * The append-only, immutable state core that validates, applies, and persists transitions atomically. It guarantees consistency and makes recovery deterministic.

* **Logs & Audit Trail**

  * `events.jsonl` for state transitions, per-phase Claude logs, and WebSocket traffic logs. This is the ground truth for debugging and compliance.

* **Crash & Lock Handling**

  * A lock file with heartbeat to enforce single client and detect crashes, plus auto-marking of crashed runs. It prevents split-brain and preserves history.

* **LLM Proxy (Passthrough + Middleware/Guardrails)**

  * An HTTP proxy that can inspect/modify LLM requests/responses and apply policies or limits. It’s the hook point for rate limits, token caps, redaction, and enterprise controls.

* **Proxy Middleware**

  * Pluggable request/response transformers (e.g., logging, token doubling, model gating). This is how orgs codify rules without touching programs.

* **Claude Process & Log Parser**

  * The subprocess manager and real-time JSONL parser that turn model output into typed events. It’s how raw LLM activity becomes actionable server events.

* **Chronicler Trigger System**

  * Declarative event/sequence triggers with conditions that wake chroniclers on interesting patterns. It’s the rule engine for “when should the sidecar act.”

* **Chronicler Execution Strategies**

  * Immediate, debounce, count, and time-window batching modes. These keep sidecar work cheap, timely, and human-readable.

* **Chronicler Conversational Mode**

  * Persistent history per phase with trimming strategies for context. It lets observers build continuity without polluting the main loop.

* **Chronicler Template System**

  * Eta templating to inject event data into prompts safely and fast. This is how we produce consistent, contextual analyses and summaries.

* **Safety Monitors (Security/PII/Budget)**

  * Always-on watchers for destructive commands, secrets, PII, and cost thresholds. They surface interventions without blocking normal flow.

* **Performance & Progress Metrics**

  * Timings, throughput, completion estimates, and efficiency ratios at phase/run levels. They inform UX (progress bars) and ops (SLOs).

* **Data Hashing & Execution Discovery**

  * Deterministic fingerprints of input data to find/resume related executions. This underpins “resume where I left off” and multi-approach comparisons.

* **Checkpoint Types**

  * Named moments like workspace-setup, completed, error, skipped, start, end. Consistent labels make rollback UX and APIs clear.

* **Prompt Assembly & System Addenda**

  * The rules for composing user/system prompts from files/text plus template variables (e.g., `<%DATA_DIR%>`). It’s the contract that keeps prompts portable across environments.

* **Environment Variables (TADPOLE\_ pass-through)**

  * A safe path for secrets/config into phases by prefixing env vars. This is the sanctioned way to connect external services/tools.

# Tier 3 — Emerging/adjacent ideas (likely need future names)

* **Self-Editing / Inspect-and-Modify**

  * The pattern where an agent (or sidecar) proposes edits to the program itself or its intermediates during a run. It introduces “gates/choke points” and needs crisp terms for proposals, reviews, and applied changes.

* **Evaluation & Checkpoints as Gates**

  * Formal points where results are verified, scored, or approved before continuing. Clear names help teams integrate humans-in-the-loop and automated QA.

* **Planning DSL**

  * A structured mini-language for plans that makes agent behavior verifiable and testable. It would formalize how phases or sub-steps are proposed and executed.

If this looks right, next step is to pick canonical labels for Tier 1 (and the one term for Program/Workflow), then cascade that vocabulary through Tier 2 so everything reads naturally end-to-end.

</intermediates/17-names/1-getting-all-the-terms-out/results/3-gpt5.md>

<intermediates/17-names/1-getting-all-the-terms-out/results/4-opus-4.1.md>
## Core Execution Concepts

**Execution Environment** - The isolated directory (currently `~/.tadpole-executions/...`) where Tadpole operates on a copy/symlink of user data. This is the safe sandbox that enables rollbacks and keeps the original data untouched.

**Data Source** - The user's original project directory or file that Tadpole reads from but never modifies. This is accessed via symlink or copy at `read_only_data_source/` within the execution environment.

**Workflow Configuration** - The JSON file (currently `phases.json`) that defines the entire multi-step process. This is the blueprint that tells Tadpole what to do, in what order, with what models.

## Execution Units

**Phase** - The atomic unit of work - a single focused task for Claude with its own prompt, model selection, and configuration. Phases are the building blocks that compose into larger workflows.

**Run** - A complete server lifecycle from startup to shutdown, containing multiple phase executions. When you rollback and continue, you create a new run that branches from the previous one.

**Execution Thread** - The logical sequence of phases across potentially multiple runs, stitching together the "true" history after rollbacks. This is what determines "what comes next" in complex, branching histories.

## Agent Architecture

**Primary Agent** - The main Claude process that executes phases and performs the core work. This is the "player on the field" doing the actual task.

**Chronicler** - A parallel, non-blocking observation agent that watches the primary agent's activity stream. These are the "commentators in the booth" that analyze, summarize, or evaluate without interfering.

**Agent Communication Protocol** - The WebSocket-based real-time messaging system between server and clients. This enables live monitoring and interactive control of the workflow.

## State & Versioning

**Shadow Repository** - The hidden git repository in `.tadpole/checkpoints` that versions tracked files. This enables the powerful rollback system without touching the user's actual git repo.

**Checkpoint** - An automatic git commit in the shadow repository at key lifecycle moments. These are the "save points" you can rollback to.

**State Management System** - The event-sourced, append-only system that tracks all runs, phases, and transitions. This ensures complete auditability and crash recovery.

## Runtime Components

**Workspace Setup Operations** - Pre-phase actions like copying templates or running commands. These prepare the environment before Claude starts working.

**File Tracking Patterns** - Glob patterns that specify which files to monitor and checkpoint. This determines what gets versioned and what Claude "sees" changing.

**Session Context** - The conversational history that can be preserved between phases. This enables multi-turn workflows where later phases build on earlier ones.

**Tool Execution System** - Claude's ability to use tools (read, write, bash) with detailed tracking of invocations and results. This includes execution timing and error handling.

## Infrastructure

**LLM Proxy Layer** - The middleware system for intercepting, logging, and modifying requests to Claude's API. This enables cost tracking, rate limiting, and request transformation.

**Lock File Mechanism** - The system preventing multiple server instances from corrupting state. Includes heartbeat monitoring for crash detection.

**Cost Tracking System** - Real-time monitoring of token usage and associated costs per phase. This helps manage budgets and optimize prompts.

**TUI/Client Interface** - The user-facing control mechanism, whether the basic terminal UI or programmatic WebSocket clients. This is how humans interact with the system.

## Meta Concepts

**Tadprogram/Workflow** - The complete package of configuration, prompts, and setup that defines a reusable AI automation. This is the "app" or "recipe" that users share and run.

**Execution Model** - The overall paradigm of isolated, versioned, multi-phase AI workflows. This is the conceptual framework that makes Tadpole different from simple prompt runners.

Are there any other concepts you feel are missing or need clearer distinction? I notice terms like "middleware/guardrails" and "inspect and modify loops" that might represent future features for meta-programming (agents modifying their own workflows).
</intermediates/17-names/1-getting-all-the-terms-out/results/4-opus-4.1.md>



Here are thoughts from some other agents. Anything you'd add or modify?