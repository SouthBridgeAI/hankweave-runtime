# Verification

## Eval-suite result

Latest recorded full eval-suite run in this workspace:

- Run directory: `packages/eval-suite/runs/2026-03-09T17-00-28-index`
- Model: `gemini-2.5-flash`
- Result: `36/36` passed

Primary command used:

```bash
cd ../packages/eval-suite
bun run src/cli.ts --shim /absolute/path/to/shim/index.js --model gemini-2.5-flash
```

## Explicit target-model probes

Additional real-agent checks were recorded for `google/gemini-2.5-pro`, including:

- `multi-file-project-creation`
- `valid-session-resume`
- manual protocol inspection of a tool-using run

Relevant run directories noted in the project materials:

- `packages/eval-suite/runs/2026-03-09T16-47-33-index`
- `packages/eval-suite/runs/2026-03-09T16-58-46-index`
- `packages/eval-suite/runs/2026-03-09T16-49-13-index` (mixed batch; later outer-suite timeouts under load)

## Shim-local regression tests

Run from `shim/`:

```bash
bun test
```

The included tests cover:

- argument parsing
- model normalization
- child process exit tracking
- tool normalization
- invalid JSON detection
- silent-success retry logic
- adaptive timeout behavior
- invalid-JSON repair continuation flow

## Packaging verification

From `shim/`:

```bash
./rebuild.sh
cmp -s dist/index.js index.js && echo identical
```

Expected result:

- `rebuild.sh` completes successfully
- `index.js` exists at the package root
- `dist/index.js` and `index.js` are byte-identical
- `VERSION` contains `n/a` for this subprocess-based shim
