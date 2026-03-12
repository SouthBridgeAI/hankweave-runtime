# Validation

## Local package checks

Recommended checks from the shim directory:

```bash
bun test
node index.js --self-test
./rebuild.sh
```

## Eval-suite usage

From the monorepo root:

```bash
cd packages/eval-suite
bun install
bun run src/cli.ts --shim "node /absolute/path/to/shim/index.js" --model anthropic/claude-haiku-4-5
```

Useful category reruns:

```bash
bun run src/cli.ts --shim "node /absolute/path/to/shim/index.js" --model anthropic/claude-sonnet-4-5 --category tools
bun run src/cli.ts --shim "node /absolute/path/to/shim/index.js" --model anthropic/claude-sonnet-4-5 --category timeout
```

## What the shim tests cover

### Vendored common tests

- argument parsing
- session helpers
- timeout helpers

### Shim-local tests

- timeout regression checks involving real API calls
- watchdog semantics for quiet-but-busy turns
- busy-step timeout classification

## Verified behavior in this workspace

The implementation has been verified for:

- standard JSONL ordering (`system` first, `result` last)
- tool-use / tool-result pairing and ID normalization
- session resume behavior
- debug-dir logging behavior
- adaptive timeout semantics
- self-test output

## Known limitation note

A long open-ended deep-research workflow with `anthropic/claude-sonnet-4-5` can exceed a fixed 10-minute eval-runner cap while still doing meaningful work.

That behavior was investigated separately and does **not** appear to be caused by malformed shim JSONL, invalid IDs, or false timeout resets in the shim itself.

For ordinary compatibility work, the important practical point is:

- P1/P2 behavior is solid
- the remaining risk is task-duration on a long-running target-model workflow, not protocol-shape correctness
