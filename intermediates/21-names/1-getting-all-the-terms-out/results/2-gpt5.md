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
