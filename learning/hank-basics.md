## Why We Built Hankweave: The Complexity Curve

Without structure, agentic work gets exponentially harder to reason about. Every fix, every edge case, every new requirement adds to a tangled ball. Context degrades, behavior drifts, and eventually you throw it away and start over.

```
How hard it is to understand what's happening
    │
    │                              ╱
    │                            ╱
    │                          ╱
    │                       ╱
    │                    ╱
    │                 ╱
    │             ╱
    │         ╱
    │     ╱
    │ ╱
    └──────────────────────────────────── Time / Changes
              Without structure (exponential growth)
```

With codons and rigs, there's an upfront cost - you're defining boundaries, writing prompts, setting up scaffolding. But complexity grows linearly, then plateaus. Codon boundaries act like circuit breakers: problems in codon 3 don't leak into codon 7.

```
How hard it is to understand what's happening
    │
    │                                    ────────
    │                               ╱────
    │                          ╱────
    │                     ╱────
    │                ╱────
    │           ╱────
    │      ╱────
    │ ╱────
    │╱
    │
    └──────────────────────────────────── Time / Changes
              With structure (linear, then plateau)
```

---

## Hanks

A hank is a JSON file that defines your entire agentic workflow: prompts, execution blocks, setup scripts, monitors, and more. It's the program that Hankweave runs.

Run `hankweave init` to scaffold a simple hank in the current folder:

```
<hankweave init command>
```

Hanks are organized to be:

- **Repeatable** through the runtime
- **Scalable** with loops
- **Inspectable** with event logs and sentinels
- **Reliable** with preflight checks and auto-recovery on issues

## Build a Codon

Hanks are made of codons. Let's start with the atomic unit.

A **hank** is a sequence of codons (blocks of agentic work). A **codon** is a single block - a prompt, a model, and the files it should track. ([Why the unusual names?](#faq))

```
┌─────────────────────────────────────────────────────┐
│  CODON: build-schema                                │
├─────────────────────────────────────────────────────┤
│                                                     │
│  PROMPT                                             │
│  "Read the CSV files in data/ and create            │
│   strict Zod schemas in src/schema/"                │
│                                                     │
│  MODEL: claude-sonnet                               │
│  TRACKS: ["src/schema/**/*.ts"]                     │
│                                                     │
└─────────────────────────────────────────────────────┘
```

```json
{
  "id": "build-schema",
  "name": "Build Zod Schemas",
  "promptFile": "./prompts/schema-builder.md",
  "model": "sonnet",
  "continuationMode": "fresh",
  "checkpointedFiles": ["src/schema/**/*.ts"]
}
```

When this runs, Hankweave creates an isolated execution environment, spawns the agent harness (Claude Code, Gemini CLI, etc.), tracks the specified files, and checkpoints the result when complete. The behavior is captured, not emergent.

Because codons run through standard agent harnesses, developing them is straightforward: get something working in Claude Code or Codex (or whatever agent is popular the week you're reading this), then capture that working state into a codon that you can share, version control, reuse and maintain.

---

## Sequence into a Hank

With codons as building blocks, we chain them into hanks.

Each codon inside a hank gets its own context window - no accumulated confusion, no context degradation.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  HANK: data-codebook                                                         │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐    │
│  │ Observe  │──▶│  Schema  │──▶│  Enrich  │──▶│ Annotate │──▶│ Diagrams │    │
│  │ (gemini) │   │ (sonnet) │   │ (gemini) │   │ (sonnet) │   │ (sonnet) │    │
│  └──────────┘   └──────────┘   └──────────┘   └──────────┘   └──────────┘    │
│       │              │              │              │              │          │
│       ▼              ▼              ▼              ▼              ▼          │
│  observations   zod schemas    enriched      annotated     visualizations    │
│  + questions                    context       schemas                        │
│                                                                              │
│                                                              │               │
│                                                              ▼               │
│                                                        ┌──────────┐          │
│                                                        │  Report  │          │
│                                                        │ (gemini) │          │
│                                                        └──────────┘          │
│                                                              │               │
│                                                              ▼               │
│                                                        PDF codebook          │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

You can mix harnesses within a single hank: Gemini for high-context tasks like reading large datasets, Sonnet for precise reasoning like schema generation. Each codon specifies its own model.

When "Schema" finishes, its results are checkpointed. "Enrich" starts fresh, reading only the files it needs.

Between codons, context can be **passed** (continue the conversation) or **firewalled** (start fresh, reading only the files). You control how much state flows forward. (No more context pollution.)

---

## Add a Rig

Codons can fail when the environment isn't set up correctly. Rigs fix that.

**Rigs** are deterministic scaffolding - files, folders, setup commands - that run before the agent starts. Each codon can have its own rig. They reduce brittleness by ensuring consistent starting conditions.

```
┌─────────────────────────────────────────────────────┐
│  CODON: build-schema                                │
├─────────────────────────────────────────────────────┤
│                                                     │
│  RIG (runs before agent)                            │
│  ├── copy typescript-template/ → workspace          │
│  └── bun install                                    │
│                                                     │
│  PROMPT                                             │
│  "Create Zod schemas for the data..."               │
│                                                     │
│  MODEL: claude-sonnet                               │
│  TRACKS: ["src/schema/**/*.ts"]                     │
│                                                     │
└─────────────────────────────────────────────────────┘
```

The rig handles the reproducible parts; the agent handles the parts that need intelligence. (i.e. Don't use an LLM to do things code can do.)

---

## Add Loops

Sometimes one pass isn't enough.

Loops let codons iterate until a termination condition is met.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  LOOP: schema-refinement                                                │
│  Terminates: 5 iterations OR context exhausted                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌────────────┐   ┌────────────┐   ┌────────────┐                       │
│  │   Schema   │──▶│  Validate  │──▶│  Tighten   │──────┐                │
│  └────────────┘   └────────────┘   └────────────┘      │                │
│        ▲                                               │                │
│        └───────────────────────────────────────────────┘                │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

Loops can terminate on iteration limits or context exhaustion. Either way, they exit gracefully with whatever progress was made.

If something breaks on iteration 47, you don't debug "the agent" - you debug what happened in that specific codon on that specific iteration. (Stack traces for AI.)

---

## Reuse Codons

Build once, use everywhere.

Codons aren't locked to a single hank. The schema loop from the codebook hank can be pulled into an entirely different workflow:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  HANK: agentic-search                                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌────────────┐   ┌────────────────────┐   ┌────────────┐               │
│  │  Observe   │──▶│  Schema Loop       │──▶│  Build     │               │
│  │            │   │  (reused)          │   │  Index     │               │
│  └────────────┘   └────────────────────┘   └────────────┘               │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

Edge cases fixed in one hank travel to every hank that reuses those codons. Over time, codons accumulate wisdom. (Your investment compounds.)

---

## Roll Back to Any Point

When things go wrong, you can step back in time.

Every codon completion, rig setup, and failure creates a **checkpoint** - a git commit capturing the exact file state. Hankweave uses a shadow git repository that tracks your work without touching your project's git.

```bash
$ hankweave checkpoint.list

Available checkpoints (newest first):
  [1] Schema Generation (completed) - 2024-01-15 14:23
  [2] Schema Generation (rig-setup) - 2024-01-15 14:20
  [3] Data Observation (completed) - 2024-01-15 14:15

$ hankweave rollback.toCheckpoint abc123
```

Each run gets its own git branch, so rolling back doesn't destroy history - you can even go back to old rolled-back timelines. This enables true time-travel debugging: try approach A, roll back, try approach B, compare results.

---

## Debug with Event Logs

When something breaks, you need to see what happened.

Every tool call, file write, and decision is captured in the **event log** from the runtime:

```
[14:23:01] codon:schema started
[14:23:01] harness:claude-code spawned
[14:23:02] tool:read_file ./data/raw.csv
[14:23:03] tool:write_file ./src/schema/types.ts
[14:23:15] tool:bash bun run typecheck
[14:23:16] tool:bash exit_code=1
[14:23:17] tool:read_file ./src/schema/types.ts
[14:23:18] tool:write_file ./src/schema/types.ts
[14:23:25] tool:bash bun run typecheck
[14:23:26] tool:bash exit_code=0
[14:23:30] codon:schema completed
```

When something goes wrong, you can trace exactly what happened. These events stream out via WebSocket in real-time, so you can build custom dashboards, pipe to your logging infrastructure, or just watch in the included CLI.

**When debugging:**

- **Check the event log** - trace the exact sequence of events
- **Inspect state** - see where you are in the execution
- **Add a rig** - give the agent more structure upfront
- **Edit and re-run** - change the prompt, re-run just that codon from the previous checkpoint
- **Roll back** - return to any checkpoint and try a different approach

---

## Validate Before Running

Catch mistakes before spending tokens.

Hankweave validates hanks before the first token is spent:

```bash
$ hankweave --validate ./hank.json ./raw-data/

✓ Hank configuration valid
✓ All referenced files exist
✓ Rig setup commands validated
✓ Model configurations valid
✓ Loop termination conditions valid
✓ Budget resolution table displayed
⚠ Warning: codon "enrich" tracks files not created by previous codons

Ready to execute.
```

Missing files, broken references, invalid loop conditions, budget misconfigurations - caught before anything runs. (Fail fast, fail cheap.)

You can also cap your spend from the CLI without editing the hank: `hankweave ./hank.json ./data --max-cost 5.00 --max-time 1800`.

---

## What's Next

This guide covers the core building blocks. Hankweave has more to offer:

- **[Sentinels](https://hankweave.southbridge.ai/concepts/sentinels/)** - parallel observers that watch the event stream and run their own analysis alongside the main agent.
- **[Budgets](https://hankweave.southbridge.ai/concepts/budgets/)** - cost, time, and token limits that let hank authors and operators express preferences the runtime resolves.
- **[The full documentation](https://hankweave.southbridge.ai)** - concepts, guides, and the complete configuration reference.
