# Looping Phases — Architecture and Implementation Plan

## Summary
- Goal: Allow defining looping phases where one or more phases repeat N times, with optional continuation across iteration boundaries ("continue-previous").
- Approach: Add a loop-capable configuration format, preprocess it into a flattened `PhaseConfig[]` the rest of the system already understands, and keep runtime logic (state manager, execution thread, checkpoints, TUI, protocol) unchanged.
- Key benefits: Minimal invasive changes, full backward compatibility, reuses existing continuation semantics, preserves current tests with minimal updates.

## Clarifications Requested
- Loop scope: Confirm loops are finite count-based only in v1 (e.g., `iterations: 3`). Any need for condition-based exit (e.g., stop-on-success) now, or defer to v2?
- Cross-iteration continuation: For the first phase of iteration k>1, should it continue from the last phase of iteration k-1 by default, or be explicit via a loop option like `continueBetweenIterations: true`? If true, do you want an override per-first-phase?
- Phase IDs: OK to auto-generate iteration-suffixed IDs (e.g., `review#2`), or require explicit user-provided templates (e.g., `review-{i}`)?
- Failure policy: When a phase fails inside a loop, continue to next iteration, break loop, or stop the run? Should this be configurable (e.g., `onFailure: "break" | "continue" | "stop"`)? v1 default recommendation: stop the run.
- Prompt templating: Do we need iteration variables (e.g., `{i}`, `{iteration}`, `{totalIterations}`) available in `promptText` and `appendSystemPromptText`? v1 can be a small win; confirm.

## Relevant Code
- Config loading/validation: `server/config.ts`
  - `phaseConfigSchema` (Zod), `loadPhaseConfig()`, `validatePhaseConfig()`
- Execution planning: `server/execution-thread.ts`
  - Determines `nextPhaseId` by sequential order in `config.phases`
- State & phases: `server/state-manager.ts`, `server/types/*`
- Phase execution: `server/tadpole-server.ts` (uses `config.phases` order, tracked files, continuation)

## Design Options

### Option A — Config Preprocessor (Flattening) [Recommended]
- Extend the JSON config schema to accept both normal phases and loop blocks.
- Preprocess/expand loops into a flat `PhaseConfig[]` with auto-generated unique IDs and adjusted `continuationMode` where needed.
- Keep all downstream systems unchanged.

Pros:
- Minimal changes to runtime/state/threads/TUI.
- Backward compatible for existing plain arrays.
- Continuation works out-of-the-box by ordering the flattened list.

Cons:
- Requires care around ID generation and user mental model (IDs multiplied per iteration).

### Option B — Loop-Aware Scheduler
- Keep config unchanged but modify `execution-thread.ts` and scheduling to virtually repeat a block, tracking iteration counters in state.
- Phases retain the same IDs; add separate iteration metadata.

Pros:
- Simpler config, visually cleaner.

Cons:
- Requires intrusive changes across execution thread, state serialization, checkpoints (phase IDs used in many places), UI, and tests.
- Higher risk and larger scope.

Conclusion: Choose Option A (Flattening) for v1.

## Proposed Config Additions (Option A)
Support arrays containing either a normal phase or a loop block. Example:

```jsonc
[
  { "id": "spec", "name": "Write Specs", "model": "sonnet", "continuationMode": "fresh", "promptFile": "prompts/spec.md" },
  {
    "type": "loop",
    "id": "rev",                  // loop id, optional but recommended
    "name": "Review/Refine Loop",  // optional label
    "iterations": 3,               // required positive integer
    "continueBetweenIterations": true, // if true, first phase of iter k continues from last phase of iter k-1
    "phases": [
      {
        "id": "review",
        "name": "Review",
        "model": "sonnet",
        "continuationMode": "continue-previous",
        "promptFile": "prompts/review.md",
        "trackedFiles": ["src/**/*.ts"]
      },
      {
        "id": "refine",
        "name": "Refine",
        "model": "sonnet",
        "continuationMode": "continue-previous",
        "promptFile": "prompts/refine.md",
        "trackedFiles": ["src/**/*.ts"]
      }
    ]
  },
  { "id": "finalize", "name": "Finalize", "model": "opus", "continuationMode": "continue-previous", "promptFile": "prompts/finalize.md" }
]
```

Flattening output (conceptual):
- `spec`
- `review#1`, `refine#1`
- `review#2`, `refine#2`
- `review#3`, `refine#3`
- `finalize`

Continuation behavior:
- Within an iteration: `refine#k` uses `continue-previous` from `review#k`.
- Between iterations (if enabled): `review#k+1` uses `continue-previous` from `refine#k` by being placed right after it.

ID Scheme:
- Default: `${phase.id}#${i}` with `i` starting at 1. Allow optional `idTemplate` at loop level (e.g., `"idTemplate": "${id}-iter-${i}"`). Names can similarly be templated.

## Validation and Schema Sketch (Zod)
Add a loop block schema and accept a union at the top level; then expand.

```ts
// server/config.ts (schema additions)
const loopBlockSchema = z.object({
  type: z.literal("loop"),
  id: z.string().min(1).optional(),
  name: z.string().optional(),
  iterations: z.number().int().positive(),
  continueBetweenIterations: z.boolean().optional().default(false),
  idTemplate: z.string().optional(),      // e.g., "${id}#${i}"
  nameTemplate: z.string().optional(),    // e.g., "${name} (iter ${i})"
  phases: z.array(phaseConfigSchema),
});

const topLevelConfigSchema = z.array(z.union([phaseConfigSchema, loopBlockSchema]));
```

Preprocessing/expansion (conceptual snippet):

```ts
function expandConfig(raw: Array<PhaseConfig | LoopBlock>): PhaseConfig[] {
  const out: PhaseConfig[] = [];
  for (const item of raw) {
    if ((item as any).type !== "loop") { out.push(item as PhaseConfig); continue; }
    const loop = item as LoopBlock;
    for (let i = 1; i <= loop.iterations; i++) {
      for (const p of loop.phases) {
        const id = loop.idTemplate
          ? template(loop.idTemplate, { id: p.id, name: p.name, i }) as string
          : (p.id as string) + "#" + i;
        const name = loop.nameTemplate
          ? template(loop.nameTemplate, { id: p.id, name: p.name, i }) as string
          : `${p.name} (iter ${i})`;
        out.push({ ...p, id: id as any, name });
      }
    }
  }
  // If continueBetweenIterations, ordering above already makes first phase of iter k+1 follow last phase of iter k.
  return out;
}
```

Note: Use the existing path resolution and file validation logic after expansion (i.e., call current validation on the flattened list).

## Execution Thread and Continuation
- No changes required. `execution-thread.ts` already picks next phase by index in `config.phases` and resolves `continue-previous` from the previous config item.
- Cross-iteration continuation becomes natural due to flattened ordering when `continueBetweenIterations` is true.

## Checkpoints, Costs, and State
- Unchanged. Each expanded phase ID is unique, so checkpoints and token accounting continue to work.
- TUI displays the expanded phase `name` and `id` with iteration number. No protocol changes.

## Edge Cases and Policies
- First phase of the entire config with `continue-previous`: still warned by `validatePhaseConfig` — keep as-is.
- Failures inside loops: v1 default is to stop the run. Optionally, future `onFailure` policy at loop-level can modify behavior.
- Nested loops: Defer for v1; support later by recursive expansion.
- Prompt templating: If approved, expose `{i}`, `{iteration}`, `{iterations}` as variables for `promptText` and `appendSystemPromptText` (post-expansion replacement only, preserving the rest of the pipeline).

## Step-by-Step Implementation Plan
1) Schema and Types
   - Add `LoopBlock` schema in `server/config.ts` (kept internal, not exported in `PhaseConfig` types).
   - Update top-level loader to parse `Array<Phase|LoopBlock>`.

2) Expansion
   - Implement `expandConfig()` that takes parsed array and returns flat `PhaseConfig[]`.
   - Apply existing path resolution checks to the expanded list (retain current code paths after expansion).

3) Validation
   - Reuse current validation on the expanded list (model names, file existence, workspace setup, continuation warnings).
   - Add dedicated warnings if any loop expands to zero phases (not possible with positive `iterations`, but check anyway).

4) Optional Prompt Variable Substitution (if approved)
   - During expansion, replace `${i}` and `${iterations}` in `promptText` and `appendSystemPromptText` when present.

5) Documentation
   - Update `documentation/phase-configuration-guide.md` with a new "Looping Phases" section, examples, and ID template options.

6) Tests
   - Add unit tests in `tests/unit/config.test.ts` for loop expansion, ID uniqueness, ordering, continuation behavior (first/last across iterations), and error cases (invalid iterations, empty phases list).

## Rollout and Backward Compatibility
- Existing configs (plain phase arrays) remain fully supported.
- New loop syntax is additive; no breaking changes.
- TUI and server protocol unchanged.

## Sample Full Config Using Loops
```jsonc
[
  { "id": "setup", "name": "Setup", "model": "sonnet", "continuationMode": "fresh", "promptFile": "prompts/setup.md" },
  {
    "type": "loop",
    "id": "dev",
    "name": "Dev Cycle",
    "iterations": 2,
    "continueBetweenIterations": true,
    "idTemplate": "${id}-${i}",
    "phases": [
      { "id": "plan",   "name": "Plan",   "model": "opus",   "continuationMode": "fresh",              "promptFile": "prompts/plan.md" },
      { "id": "build",  "name": "Build",  "model": "sonnet", "continuationMode": "continue-previous", "promptFile": "prompts/build.md",  "trackedFiles": ["src/**/*"] },
      { "id": "verify", "name": "Verify", "model": "sonnet", "continuationMode": "continue-previous", "promptFile": "prompts/verify.md" }
    ]
  },
  { "id": "ship", "name": "Ship", "model": "opus", "continuationMode": "continue-previous", "promptFile": "prompts/ship.md" }
]
```

Resulting execution order:
- `setup`
- `plan#1` → `build#1` → `verify#1`
- `plan#2` → `build#2` → `verify#2`
- `ship`

## Open Questions Recap
- Confirm v1 scope (count-based loops only; default on-failure policy; optional prompt templating; cross-iteration continuation default).

— End of report —

