# Verification Notes

## Local checks performed in this workspace

- `bun run typecheck`
- `bun test`
- `bun run build`
- `./rebuild.sh`

## Real-agent verification previously recorded for this shim

This shim was previously validated against real Codex models during the build run that produced this package.

Highlights:
- all current eval-suite tests were reported as passing category-by-category with `gpt-5.1-codex-max`
- direct smoke testing succeeded with `gpt-5.2-high`
- manual inspection confirmed public `toolu_*` IDs and valid JSONL output
- shell-backed write normalization was regression-tested for both redirect and heredoc writes

## Known limitation

`o4-mini` was observed failing in this environment due to upstream model metadata / account compatibility issues. The shim handles that as a clean synthetic runtime error rather than hanging or crashing.

## Recommended revalidation commands

```bash
cd shim
./rebuild.sh
bun run typecheck
bun test

echo "Say hello" | node ./index.js --model gpt-5.1-codex-max
node ./index.js --self-test
```
