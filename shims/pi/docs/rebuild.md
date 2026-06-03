# Rebuild and packaging

## Goals

This directory is intended to work in two modes:

1. **Drop-in bundle** — `./index.js` can be used directly by Hankweave
2. **Self-contained source package** — `./rebuild.sh` reinstalls dependencies and rebuilds the bundle

## Rebuild command

```bash
./rebuild.sh
```

`rebuild.sh` performs the following steps:

1. `bun install`
2. `bun run build`
3. resolves the primary dependency version (the first dependency in `package.json` other than `@shims/common`)
4. writes that resolved version to `VERSION`
5. ensures `dist/index.js` has a `#!/usr/bin/env node` shebang
6. makes `dist/index.js` executable
7. copies `dist/index.js` to `./index.js`
8. makes `./index.js` executable

## VERSION semantics

`VERSION` contains the resolved version of the primary bundled dependency.

For this shim, that is the installed version of:

- `@earendil-works/pi-coding-agent` (formerly `@mariozechner/pi-coding-agent`
  — the package was renamed at upstream v0.74.0)

Example:

```text
0.77.0
```

Thin subprocess shims with no primary SDK dependency would instead use:

```text
n/a
```

## Build output

```text
shim/
├── index.js         # drop-in bundle used by Hankweave
├── dist/index.js    # normal build artifact
├── src/             # shim source
├── common/          # vendored @shims/common
├── docs/            # package docs
├── package.json
├── rebuild.sh
├── VERSION
└── THIRDPARTY.md
```

## Upgrading dependencies

Typical flow:

```bash
bun add @earendil-works/pi-coding-agent@latest
./rebuild.sh
```

If a user-level `~/.pi/agent/models.json` was authored against the pre-0.73
SDK, migrate any `compat.reasoningEffortMap` entries to the per-model
`thinkingLevelMap` shape (upstream change in v0.73.0).

After the rebuild:

- `dist/index.js` is refreshed
- `index.js` is refreshed
- `VERSION` reflects the installed SDK version

## Vendored common package

`@shims/common` is included in `./common/` and referenced from `package.json` as:

```json
"@shims/common": "file:./common"
```

That keeps the shim rebuildable outside the original monorepo workspace.
