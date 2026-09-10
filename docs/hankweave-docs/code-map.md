# Hankweave 0.10.0 code map

Use this map after finding the documentation that owns the question. Paths below are repository
paths; prepend `source/` to read them with `scripts/hankweave-docs.sh` after attaching the matching
optional source pack. They identify source at `v0.10.0`, commit
`d0f0a86bcf4528f23ffa687b9c8964c15fe7cb88`, not proof of what every installed package executes.

Run `bash scripts/hankweave-docs.sh info` first to check source availability. A whole-repository
layout can discover `docs/source/hankweave-source-0.10.0.parquet` automatically; the installed
core skill normally has no source bodies. Attach a pack elsewhere with `--source-parquet PATH`
or `HANKWEAVE_SOURCE_PARQUET`. Without it, docs citations retain their source IDs, URLs and line
bounds, but a `missing-source` result with a null preview is not a source read.

| What you need to check | Start here, then follow the relevant calls |
|---|---|
| CLI flags, startup, initialization | `server/cli-parser.ts`, `server/index.ts`, `server/init-command.ts`, `tests/unit/cli-parser.test.ts` |
| Hank settings, validation, public types and schemas | `server/config.ts`, `server/validate-command.ts`, `server/exports/schemas.ts`, `server/exports/types.ts`, `schemas/hank.schema.json`, `scripts/generate-schemas.ts` |
| Prompt files, path safety, rig setup and output handoffs | `server/hank-refs.ts`, `server/prompt-builder.ts`, `server/file-resolver.ts`, `server/execution-setup.ts`, `server/hankweave-runtime.ts` |
| Codon order, loops and execution state | `server/execution-planner.ts`, `server/codon-runner.ts`, `server/hankweave-runtime.ts`, `server/state-manager.ts` |
| Failures, retries and replay | `server/error-classification.ts`, `server/retry-coordinator.ts`, `server/replay.ts`, `server/replay-process-manager.ts` |
| Budget allocation, spending and resume accounting | `server/budget.ts`, `server/cost-tracker.ts`, `server/validate-budget.ts`, `tests/unit/budget.test.ts` |
| Checkpoints, rollback and continuation sessions | `server/checkpoint-git.ts`, `server/execution-thread.ts`, `server/archive-manifest.ts`, `server/state-manager.ts`, `tests/e2e/rollback-comprehensive-e2e.test.ts` |
| Model selection, provider configuration and authentication | `server/llm/llm-provider-registry.ts`, `server/llm/provider-config.ts`, `server/provider-ids.ts`, `server/aws-credentials.ts` |
| Agent SDK and shim process boundaries | `server/claude-agent-sdk-manager.ts`, `server/pi-sdk-manager.ts`, `server/shim-process-manager.ts`, `server/base-process-manager.ts` |
| Shim translation and packaging | `shims/pi/src/index.ts`, `shims/pi/src/translator.ts`, `shims/codex/src/shim.ts`, `shims/gemini/src/shim.ts`, `shims/opencode/src/shim.ts`; compare each shim's `index.js`, `package.json` and `rebuild.sh` |
| Sentinel triggers, context and history | `server/sentinels/sentinel-manager.ts`, `server/sentinels/trigger-engine.ts`, `server/sentinels/prompt-templating-engine.ts`, `server/sentinels/history-manager.ts` |
| Events, logs and telemetry privacy | `server/schemas/event-schemas.ts`, `server/event-journal.ts`, `server/storage/file-event-storage.ts`, `server/telemetry/privacy-enforcement.ts`, `reference/telemetry.md` |
| Release contents and test scenarios | `package.json`, `scripts/build.ts`, `scripts/build-executable.ts`, `.github/workflows/release.yml`, `TESTING.md`, `tests/suite-manifest.ts`, `learning/hank-basics.md` |

## Check a claim all the way through

1. Search the docs, read the owning section, and keep its version and review status in view.
2. With the matching source pack attached, choose a starting file above. Use source search or `outline` to locate the symbol, then `page`
   to read the complete file. Declaration and method sections are lookup windows of at most
   40 lines; a return, cleanup branch or state write may lie beyond the excerpt.
   Prefer `shims/*/src/` when reasoning about shim behavior. Tracked `index.js` bundles are
   included for artifact comparisons, but the Pi bundle alone is about 13 MB; do not load a
   whole minified bundle as the default context. Search for the relevant symbol and use a
   targeted window when the bundled form itself needs checking.
3. Follow callers as well as imports. Search the symbol across source, read its call sites, and
   trace the values it reads and writes through validation, execution and persistence. `neighbors`
   records relative imports/re-exports, not every call, dynamic load or package alias.
4. Read the relevant tests for their inputs and expected outcomes. A checked-in test describes a
   scenario; its presence does not establish that it passed for the published artifact.
5. Compare the result with captured behavior. `source/surfaces/help.txt`,
   `source/surfaces/cli-flags.json`, `source/surfaces/schemas/hank.schema.json` and
   `source/surfaces/init-fixture/hank.json` are captured surfaces, not repository files. For run
   evidence, use the fixture scope and read the capture manifest before interpreting the output.

For example, after locating the hank configuration docs:

```bash
bash scripts/hankweave-docs.sh search --scope source validateHank
bash scripts/hankweave-docs.sh outline --scope source source/server/config.ts
bash scripts/hankweave-docs.sh page --scope source source/server/config.ts
bash scripts/hankweave-docs.sh neighbors --scope source source/server/config.ts
bash scripts/hankweave-docs.sh page --scope source source/surfaces/schemas/hank.schema.json
```

For a claim about the shipped release, the locked artifact and a capture of its behavior take
precedence over an inference from source at the tag. A source schema and a captured schema may
differ. Report that difference rather than making the capture agree with the source. Repository
examples, shim notes and test logs are also source-at-tag evidence, not fresh runtime captures.

## What the source scope contains

The optional source pack is about **10.51 MB** and contains **636 repository text files and 57 captured surfaces**. The repository
portion contains all 421 TypeScript and four JavaScript files, including the four tracked shim
bundles, plus shell scripts, schemas, package/configuration files, text lockfiles, tests, examples
and explanatory documents. File text and downloadable source bytes are retained without
normalization. Root files and `.github/workflows/release.yml` are included; source is no longer
limited to `server/`.

Of the 710 pinned repository files, 74 are excluded: 69 files of recorded runtime state under
`tests/fixtures/…/.hankweave/`, two binary images, and three binary Bun lockfiles. These omissions
mean this corpus is **not a complete runnable checkout, a release archive, or all replay data**.
The export policy also excludes dependency/build caches, credential files and unreviewed hidden
paths; reviewed ignore/configuration files and `.github` are allowed. Unknown visible file types,
symlinks and invalid text payloads stop export instead of silently disappearing.

GitHub repository URLs pin the commit above. Captured-surface URLs use the site's separate
versioned `/source/` assets, not documentation page routes under `/<version>/files/`, and must
not be cited as files from that commit. See the [online references](SKILL.md#online-references)
for the optional pack and its matching manifest in the repository.
Discover the attached pack's source IDs with `toc --scope source`; an older parquet may not yet
contain the expanded inventory.
