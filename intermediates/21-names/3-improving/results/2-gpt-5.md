love it. here’s a clean, “who needs to know what” map you can build docs and UI around. i’ve split by role, grouped into **things (nouns)**, **operations (verbs)**, **concepts/policies (rules)**, and **primitives (building blocks)**. i also suggest candidate names for the roles so we can replace “creators/users” later.

---

# Role names (pick a pair)

* **Creators** → *Author • Builder • Architect • Composer • Flow Author*
* **Users** → *Operator • Runner • Pilot • Reviewer • Analyst*

---

# For **Creators** (Authors) — what you design and specify

## Things (nouns)

* **Program** — The shareable package you author (all phases + settings). It’s the “thing to run.”
* **Phase** — One focused task; has its own prompt, model profile, setup, and tracked files.
* **Phase Config** — The JSON spec for a phase (prompt sources, model profile, continuation, workspace setup, tracked files, env).
* **Model Profile** — Model + parameters (e.g., Sonnet/Opus, temperature, max output tokens); reusable preset surface.
* **Workspace Setup** — Pre-phase actions (copy templates, run commands) to prep the environment deterministically.
* **Tracked Files** — Glob patterns defining what’s monitored/versioned; determines diffs, checkpoints, and “state.”
* **Tools (Tool Catalog)** — The declared tool interfaces (names, params, IO, error contracts) your phases can call.
* **Chroniclers** — Parallel observers you configure to summarize/eval/monitor without blocking the main loop.
* **Budgets & Limits** — Declarative ceilings (tokens, \$, time, tool calls) for a phase or program.
* **Safety Policy** — Allow-lists and guardrails (what can shell/network write, redaction rules, secret/PII detection).
* **Artifacts** — Expected outputs (code, docs, reports, data) and where they land in the environment.

## Operations (verbs)

* **Author prompts** — Compose prompts from files/text; inject `<%DATA_DIR%>` / `<%EXECUTION_DIR%>` template vars.
* **Define setup** — Copy scaffolds and run commands; make them idempotent.
* **Choose continuation** — Decide fresh vs continue-previous, and handle fallbacks.
* **Specify tools** — Register tool contracts and reference them in prompts.
* **Track files** — Pick precise globs; exclude noise/binaries to keep checkpoints fast and meaningful.
* **Add chroniclers** — Configure triggers, batching strategy (immediate/debounce/count/timeWindow), and prompts.
* **Set budgets/limits** — Attach ceilings and choose behavior on hit (warn, degrade, stop).
* **Wire safety** — Configure permissions (shell, network, write paths) and redaction/truncation.
* **Version & test** — Validate configs, run locally in TUI, inspect artifacts/checkpoints, iterate.

> **Looping phases:** today achieved via `phase.redo` patterns or “small-step” phase graphs; not a separate first-class object yet. If you want tight loops, use short phases + redo or a chronicler-gated “retry” pattern.

## Concepts / policies (rules)

* **Phase Lifecycle** — `preparing → starting → initializing → running → {completed|failed|skipped}`; design prompts to be restartable.
* **Continuation Rules** — Continue only when prior messages exist and models are compatible; otherwise fall back to fresh.
* **Checkpoint Policy** — Named save-points (`workspace-setup`, `completed`, `error`, `skipped`, `start`, `end`) tied to tracked files.
* **Event Model** — Typed stream (`assistant.action`, `tool.result`, `file.updated`, `token.usage`, `phase.*`, `server.*`, `error`) that your chroniclers consume.
* **Observability** — Three channels: state transitions (`events.jsonl`), per-phase Claude JSONL, WebSocket traffic logs.
* **File Resolution** — `.gitignore`-aware globs; explain to yourself why some files won’t ever checkpoint.
* **Cost Semantics** — Input/output tokens roll up to phase/run/program; chroniclers can annotate “why.”

## Primitives (building blocks)

* **IDs** — `ProgramId`, `PhaseId`, `RunId`, `SessionId`, `ToolUseId`; refer to checkpoints by SHA or `<PhaseId>@completed`.
* **Template Vars** — `<%DATA_DIR%>`, `<%EXECUTION_DIR%>` for portable prompts.
* **Env Vars** — `TADPOLE_*` is passed through (prefix removed) to the agent env per phase.
* **Globs** — `**/*.{ts,tsx}`, `!node_modules`, etc., for tracked files.
* **Execution Environment** — The isolated sandbox (the **execution directory** is its path).
* **Data Source & Mount** — Your input (dir/file) mounted read-only at `read_only_data_source/`.

---

# For **Users** (Operators) — what you run and control

## Things (nouns)

* **Program** — The bundle you run. It will guide you through phases and produce artifacts.
* **Phase** — A step in the program; shows live actions, tool uses, file changes, and results.
* **Run** — One end-to-end session; useful for comparing approaches and resuming after crashes.
* **Execution Thread** — The stitched “true history” across rollbacks/runs that decides what’s next.
* **Execution Environment** — The sandbox where work happens (your originals stay untouched).
* **Data Source** — The input you provided; mounted read-only inside the environment.
* **Artifacts** — The outputs to review/download/share (reports, code, docs).

## Operations (verbs)

* **Start / Advance** — `phase.next` to progress; autostart may kick off first phase automatically.
* **Skip / Redo / Force-stop** — `phase.skip`, `phase.redo`, `phase.forceStop` to manage a stuck or unwanted step.
* **Rollback** — Jump back to a checkpoint by label or SHA (e.g., `<PhaseId>@completed`) and continue.
* **Restart / Resume** — Start a new run, or pick up the latest for this data source.
* **Inspect** — View file tree, diffs, tool results, cost usage, and chronicler summaries.
* **Download / Share** — Grab artifacts from predictable locations in the environment.

## Concepts / policies (rules)

* **Rollback vs Redo vs Restart**

  * *Rollback* changes files/state to an earlier save-point; *Redo* re-runs the last phase; *Restart* begins a fresh run.
* **Continuation** — Some phases carry context from previous ones; others start fresh by design.
* **Checkpoint Types** — Named save-points you can roll back to (`workspace-setup`, `completed`, `error`, `skipped`, `start`, `end`).
* **Budgets** — Programs may stop/degrade when token/\$/time limits trigger; you’ll see warnings.
* **Safety Monitors** — Destructive commands, secrets/PII, or spend spikes may surface alerts.
* **Progress & Health** — Live status (phase lifecycle), estimates, token/cost counters, stuck-loop detection.
* **Single-client model** — One controller at a time; disconnecting cleanly shuts the server down for safety.

## Primitives (building blocks)

* **Controls** — `phase.next`, `phase.skip`, `phase.redo`, `rollback.*`, `phase.forceStop`, `server.shutdown`.
* **Labels/IDs** — Phase names/IDs, run IDs, and friendly checkpoint labels to target actions precisely.
* **Views** — Timeline (Execution Thread), file diffs, tool results, cost/usage, chronicler outputs.

---

# Shared / cross-cutting (both roles should recognize)

* **Execution Thread** — The authoritative “what really happened, and what’s next” view.
* **Shadow Git Repository** — Internal versioning store for checkpoints (separate from your repo).
* **Server Protocol** — WebSocket + JSON events/commands; UIs and SDKs speak this.
* **LLM Proxy + Middleware** — Request/response interception for logging, policy, and guardrails.
* **Recovery** — Crash detection via lock/heartbeat, backup state (`state.json.bak`), clean resume behavior.

---

## Optional / future-facing (mark as advanced in docs)

* **Evaluation Gates** — Formal approve/score points before proceeding (pairs well with chroniclers).
* **Self-Editing Proposals** — Agent proposes edits to the Program or intermediates, with human/auto gates.
* **Planning DSL** — Structured, testable plans for more verifiable agent behavior.

---

## Quick cheat sheet (one-liners you can paste into sidebars)

* **Creators**: Program, Phase, Phase Config, Model Profile, Workspace Setup, Tracked Files, Tools, Chroniclers, Budgets, Safety, Artifacts, IDs, Globs, Env Vars, Template Vars.
  **Do**: author prompts, define setup, continuation, tools, tracking, chroniclers, budgets, safety; validate/test; iterate.

* **Users**: Program, Phase, Run, Execution Thread, Execution Environment, Data Source, Artifacts.
  **Do**: start/advance, skip/redo/force-stop, rollback/restart/resume, inspect diffs/tools/costs, download/share artifacts.

if you want, i can now turn this into two role-specific docs (Author Guide vs Operator Guide), or propose UI terminology so the same words show up consistently in TUI/Web.
