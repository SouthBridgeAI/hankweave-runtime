# Third-party notices

## Primary SDK dependency

This shim is a **thin subprocess wrapper** around the external OpenCode CLI.

- Primary bundled SDK dependency: **none**
- `VERSION`: `n/a`

The compiled `index.js` bundle does **not** embed the OpenCode CLI itself. OpenCode must be installed separately and discovered at runtime via PATH or `OPENCODE_BIN`.

## Bundled vendored dependency

### `@shims/common`

- Package: `@shims/common`
- Version: `1.0.0`
- Source: vendored from the local Hankweave shims workspace into `./common`
- License metadata: not declared in `common/package.json`
- Notes: this is a project-local shared utility package used for argument parsing, timeout handling, message typing, and session helpers

## External runtime dependency

### OpenCode CLI

- Package/runtime: `opencode`
- Bundled in `index.js`: **no**
- License: see the OpenCode npm package and/or source repository

## Full license texts

For third-party components, consult the package metadata and source repositories distributed with those dependencies. For OpenCode specifically, use the license text published in the upstream package or repository because the CLI is not bundled into this shim package.
