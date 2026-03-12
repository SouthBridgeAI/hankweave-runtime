# Validation

## Local validation status

The shim was previously validated against the real OpenCode CLI using `google/gemini-2.5-flash`.

Documented successful checks:

- `bun test`
- `bun run typecheck`
- `bun run build`
- repeated eval-suite `tool-workflow` runs
- full eval-suite run

## Full eval-suite result

Fresh documented run:

```bash
cd packages/eval-suite
bun run src/cli.ts --shim "bun /.../shim/index.js" --model google/gemini-2.5-flash
```

Outcome:

- **36 / 36 tests passed**
- report: `packages/eval-suite/runs/2026-03-09T16-24-17-index/report.md`

Key passed categories included:

- JSONL validity
- strict message ordering
- session resume
- tool workflows
- timeout behavior
- debug logging behavior
- deep research / long-running agentic workflows

## Important regressions covered by local tests

The shim package includes local regression coverage for several OpenCode-specific failure modes:

- pre-work silence triggers the baseline idle timeout
- busy steps do not false-timeout while streaming non-lifecycle events
- process exit without terminal `reason: "stop"` is treated as an error
- resume without `--debug-dir` uses native OpenCode session lookup and does not create `~/.shim`
- tool normalization and empty bash output handling

## Packaging verification

This packaged directory is intended to validate with:

```bash
cd shim
./rebuild.sh
bun test
bun run typecheck
```

`./rebuild.sh` should:

1. install dependencies
2. build `dist/index.js`
3. refresh `VERSION`
4. ensure the node shebang and executable bit
5. copy `dist/index.js` to root `index.js`

## Notes on `VERSION`

This is a thin subprocess shim around the external OpenCode CLI and does not bundle a third-party SDK dependency. `VERSION` is therefore expected to contain:

```text
n/a
```
