these are solid. i’d add a few missing pieces and tighten a couple overlaps so the eventual naming pass is easier.

# Add — concepts that deserve a name (each in 1–2 lines)

* **Phase Lifecycle (state machine)**
  The canonical states a phase moves through: preparing → starting → initializing → running → {completed|failed|skipped}. Naming this explicitly helps UX, logs, and error handling line up.

* **Event Model (typed stream)**
  The taxonomy of messages the server emits/ingests (e.g., `assistant.action`, `tool.result`, `file.updated`, `token.usage`, `phase.*`, `server.*`, `error`). This is the contract chroniclers and clients code against.

* **Identity & Addressing**
  Stable IDs and how to refer to things: `RunId`, `PhaseId`, `SessionId`, `ToolUseId`, checkpoint SHA/label. Useful for APIs, logs, and user commands (e.g., rollback to `<PhaseId>@completed`).

* **Operator Controls & Autostart Policy**
  The verbs users send (`phase.next`, `phase.skip`, `phase.redo`, `rollback.*`, `forceStop`) and whether a run autostarts on connect. Makes CLI/TUI/Web consistent.

* **Tool Catalog (contract & registry)**
  The formal definition of available tools (names, params, IO, error surface) and where that lives. Distinct from runtime tracking of tool use/results.

* **Tool Permissions & Safety**
  Capability/allow-list model (e.g., shell, network, write locations), redaction rules, and per-phase overrides. This is the “guardrails” policy, not just the proxy.

* **Budgets & Limits**
  Declarative per-phase/run ceilings (tokens, \$, time, tool calls) with behavior on hit (warn, degrade, stop). Pairs with cost tracking to enable governance.

* **Continuation & Compatibility Rules**
  When context can be continued (model version match, prior messages exist) and what happens when it can’t (fallback to fresh). Prevents confusing “silent resets.”

* **Truncation & Redaction Policy**
  How large tool outputs/logs are truncated and how sensitive strings are masked across events, logs, and checkpoints. Keeps observability safe and predictable.

* **File Resolution & Ignore Rules**
  The `.gitignore`-aware resolver and glob semantics that decide what’s “tracked.” Useful to document because it explains why some files never appear in diffs.

* **Checkpoint Policy**
  When we checkpoint (workspace-setup, completion, error, skip), naming conventions, and retention/GC. Clarifies rollback UX and storage expectations.

* **Observability Channels**
  The three sources of truth: state transitions (`events.jsonl`), Claude JSONL logs (per phase), and WebSocket traffic logs. Helpful to point users to the right log for the job.

* **Recovery Modes**
  Crash detection via lock/heartbeat, backup state (`state.json.bak`), and how a run is marked/recovered. Makes failure behavior legible.

* **Chronicler Output Sinks**
  Where chroniclers write (files, logs, annotations) and guarantees (non-blocking, failures never crash run). Distinct from triggers/strategies.

# Modify — merge or tighten overlaps

* **Executable Plan ↔ Program/Workflow ↔ Workflow Configuration**
  Collapse to two layers: **Program** (the entire thing to run, shareable package) and **Phase Config(s)** (the JSON that defines each step). Use “Workflow” only as a descriptive noun if you must, not a proper object.

* **Primary AI Worker / Primary Agent**
  Pick one canonical term (e.g., **Main Agent**) and reserve “agent” for this; avoid “worker” unless you later add background executors.

* **Isolated Workspace / Execution Directory / Execution Environment**
  Use **Execution Environment** as the concept; “execution directory” is the path where it lives.

* **Data Source / Source Material / Data Folder**
  Standardize on **Data Source**; “mount” can be the path inside the environment (`read_only_data_source/`).

* **Logical Workflow History / Execution Thread**
  Keep **Execution Thread** and make “logical history” the definition sentence, not a second name.

* **LLM Request Interceptor / LLM Proxy + Middleware**
  Keep **LLM Proxy** for the component; call the pieces **Proxy Middleware** (plural) and **Transport** (forwarder).

* **Control Interface / WebSocket Protocol / TUI**
  **Server Protocol** (WebSocket + JSON schema) is the API; **Clients** are TUI/Web that speak it.

* **Generated Artifacts / Output files**
  Use **Artifacts** as the umbrella; “outputs” in prose is fine.

# Small clarifications (worth calling out explicitly)

* **Phase → Core Agentic Loop**: say outright that the loop is *how* a phase runs (prompt → tools → file changes → result), not a separate object.
* **Shadow Repository**: note per-run branches and that it’s intentionally separate from the user’s VCS.
* **Model Profile**: include defaults (temp, max tokens) so “profile” reads like a reusable preset later.
* **Chronicler non-interference**: keep the “cannot block or change the main loop” guarantee in the definition.

If you want, I can fold these into the Tier 1/2/3 lists you already have so we’ve got a single, deduped source to name against next.

awesome — here’s the single, de-duplicated concept map we’ll name against next. each item is two sentences.

# Tier 1 — user-facing primitives (settle these first)

* **Tadpole Runner (the product)**
  The orchestration server that executes multi-step AI work with isolation, state, and rollback. It’s the thing people install/run and the anchor brand for everything else.

* **Program**
  The authored, shareable package that tells Tadpole what to do end-to-end (steps, prompts, models, setup, tracking). It’s defined by one or more phase configs and is the canonical “thing to run.”

* **Phase**
  The atomic unit of work: one focused task with its own prompt, model, environment prep, and tracked files. Phases compose into a Program’s overall flow.

* **Phase Config**
  The JSON contract that defines a phase (prompt sources, model profile, continuation, workspace setup, tracked files, env). It is the precise, developer-facing specification of behavior.

* **Main Agent**
  The primary agentic process that executes a single phase: it reads the prompt, uses tools, edits files, and produces results. Think “player on the field” for the current step.

* **Run**
  A single server session from start to shutdown that contains the attempted/finished phases and their history. Teams compare runs, recover after crashes, and branch work via runs.

* **Execution Thread**
  The logical, stitched timeline of phases across rollbacks and multiple runs. It represents the “true history” and determines what comes next.

* **Execution Environment**
  The isolated workspace where all work happens, separate from the user’s originals. It enables clean rollbacks and reproducibility without touching source data.

* **Data Source**
  The user’s original directory or file used as input. It is mounted read-only inside the Execution Environment (the “data mount”) to preserve integrity.

* **Workspace Setup**
  The pre-phase actions (copy templates, run commands) that prepare the environment before the Main Agent starts. It guarantees each phase begins with the right tools and structure.

* **Tracked Files**
  The glob patterns that define which files are monitored and versioned. They decide what shows up in diffs, checkpoints, and progress UI.

* **Checkpoint & Rollback**
  Checkpoints are point-in-time snapshots of tracked files in a shadow git repo; rollback restores to one of them. This is the core safety mechanism for exploration and recovery.

* **Chroniclers**
  Parallel, non-blocking observer agents that watch events to summarize, evaluate, or alert. They never interfere with the Main Agent’s loop.

* **Artifacts**
  The tangible outputs produced by phases/programs (code, docs, reports, data). They live in predictable locations within the Execution Environment for downstream use.

# Tier 2 — integrator & operator concepts (standardize across docs, SDKs, UI)

* **Phase Lifecycle (state machine)**
  The canonical states: preparing → starting → initializing → running → {completed | failed | skipped}. Naming this explicitly aligns UX, logs, and error handling.

* **Core Agentic Loop**
  The mechanics of a running phase: prompt → tool use → file changes → result. It describes “what’s happening right now” inside the phase.

* **Event Model (typed stream)**
  The taxonomy of server messages (e.g., `assistant.action`, `tool.result`, `file.updated`, `token.usage`, `phase.*`, `server.*`, `error`). Clients and chroniclers code against this contract.

* **Identity & Addressing**
  Stable identifiers and references: `RunId`, `PhaseId`, `SessionId`, `ToolUseId`, and checkpoint SHA/labels. They make APIs, logs, and commands (e.g., rollback to `<PhaseId>@completed`) precise.

* **Operator Controls & Autostart Policy**
  The verbs users send (`phase.next`, `phase.skip`, `phase.redo`, `rollback.*`, `forceStop`) and whether the first phase starts automatically. This defines interactive control and automation behavior.

* **Model Profile**
  The model choice and parameters (e.g., Sonnet/Opus, temp, max tokens) applied to a phase. Treat it as a reusable preset surface for defaults and governance.

* **Continuation Mode**
  Whether a phase starts fresh or continues prior conversation context. It enables multi-turn workflows without mega-prompts.

* **Continuation & Compatibility Rules**
  The conditions under which continuation is allowed (e.g., previous messages exist, model compatibility) and the fallback when not (start fresh). This prevents silent context loss.

* **Tool Use & Result Tracking**
  Structured capture of each tool invocation and outcome (inputs, timings, errors, truncation). It powers observability, evals, and stuck-loop detection.

* **Tool Catalog (contract & registry)**
  The formal definition of available tools—their names, parameters, IO, and error surface. It’s distinct from runtime tracking and used by prompts, policy, and docs.

* **Tool Permissions & Safety**
  Capability and allow-list policy (shell, network, write locations) with per-phase overrides. It’s where guardrails and redaction rules live.

* **LLM Proxy**
  The request/response interceptor between the server and external LLM APIs. It enables logging, cost control, rate limits, redaction, and policy enforcement.

* **Proxy Middleware**
  Pluggable transforms that inspect or modify LLM traffic (e.g., token caps, model gating, logging). This encodes org-level rules without changing programs.

* **Server Protocol**
  The single-client WebSocket + JSON schema used by all clients (TUI/Web/SDK). It is the stable API for commands and real-time events.

* **Basic TUI (client)**
  The built-in terminal interface for local runs with hotkeys (next/skip/rollback) and live feeds. It’s the default operator cockpit.

* **Shadow Git Repository**
  A dedicated git repo in `.tadpole/checkpoints` with per-run branches and structured commit messages. It keeps versioning powerful without touching the user’s own VCS.

* **Checkpoint Types**
  Named save-points such as `workspace-setup`, `completed`, `error`, `skipped`, `start`, `end`. Consistent labels make rollback UX and APIs clear.

* **State Manager (event-sourced)**
  The append-only, immutable state core that validates, applies, and atomically persists transitions. It guarantees consistency and enables crash recovery.

* **Logs & Audit Trail**
  `events.jsonl` for state transitions, per-phase Claude logs, and WebSocket traffic logs. Together they form the ground truth for debugging and compliance.

* **Observability Channels**
  The three places to look: state transitions, Claude JSONL, and protocol logs. Each answers different “why did this happen?” questions.

* **Crash & Lock Handling**
  A lock file with heartbeat to enforce “single client” and detect crashes, plus auto-marking of crashed runs. It prevents split-brain and preserves history.

* **Recovery Modes**
  Automatic fallback to backup state, run-status correction after crashes, and resume behavior. Users can reliably pick up where they left off.

* **Cost & Token Usage**
  Real-time accounting per interaction/phase/run. It supports budgets, alerts, and post-mortems.

* **Budgets & Limits**
  Declarative ceilings (tokens, \$, time, tool calls) with behaviors on hit (warn, degrade, stop). This is governance you can codify.

* **File Events & File Tree**
  Live notifications of created/changed/deleted tracked files and a rolling tree snapshot. These power UIs, chroniclers, and checkpoint eligibility.

* **File Resolution & Ignore Rules**
  The `.gitignore`-aware resolver and glob semantics that decide what’s “tracked.” It explains why some files never appear in diffs or checkpoints.

* **Prompt Assembly & System Addenda**
  How we build prompts from files/text and inject template variables like `<%DATA_DIR%>` and `<%EXECUTION_DIR%>`. It keeps prompts portable across environments.

* **Environment Variables (TADPOLE\_ pass-through)**
  The sanctioned path for secrets/config into phases via `TADPOLE_`-prefixed env vars. Prefix removal at runtime avoids accidental leakage.

* **Chronicler Trigger System**
  Declarative event/sequence triggers with conditions that wake chroniclers on interesting patterns. It’s the rule engine for observer behavior.

* **Chronicler Execution Strategies**
  Immediate, debounce, count, and time-window batching modes. They keep sidecar work timely, cheap, and readable.

* **Chronicler Conversational Mode**
  Persistent per-phase history with trimming strategies. Observers build continuity without polluting the Main Agent’s context.

* **Chronicler Template System**
  Eta templating that safely injects event data into prompts. It standardizes consistent, contextual summaries and analyses.

* **Safety Monitors (Security/PII/Budget)**
  Always-on watchers for destructive commands, secrets/PII, and spend thresholds. They notify or escalate without blocking normal flow.

* **Performance & Progress Metrics**
  Timings, throughput, completion estimates, and efficiency ratios at phase/run scope. They inform operator UX and operational SLOs.

* **Data Hashing & Execution Discovery**
  Deterministic fingerprints of input data to find/resume related executions. It enables “resume the latest for this data” and multi-approach comparison.

# Tier 3 — emerging/adjacent (reserve names, spec later)

* **Self-Editing (inspect-and-modify)**
  Patterns where an agent proposes edits to the Program or intermediates mid-run with gated approvals. It introduces proposals, reviews, and applied changes as first-class objects.

* **Evaluation Gates**
  Formal checkpoints where results are verified, scored, or approved before continuing. They support human-in-the-loop and automated QA.

* **Planning DSL**
  A structured mini-language for plans and sub-steps that is executable and testable. It aims to make agent behavior more verifiable and composable.

---

## Canonicalization decisions (so we don’t drift)

* Use **Program** (not Workflow/Executable Plan) as the top-level thing; **Phase Config** defines each step.
* Use **Main Agent** (not Primary Worker/Primary Agent).
* Use **Execution Environment** (concept) and **execution directory** (its path) consistently.
* Use **Data Source** (with “data mount” for the path inside the environment).
* Keep **Execution Thread** as the name; “logical history” is its definition.
* Use **LLM Proxy** + **Proxy Middleware**; **Server Protocol** for WebSocket+JSON API.
* Use **Artifacts** for outputs.

if you want, i can turn this into a quick glossary table you can drop into docs, and then we can start brainstorming actual brandable names for the Tier-1 items.
