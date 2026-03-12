# Third-party notices

## Runtime bundle

This shim is a thin subprocess wrapper around a locally installed Gemini CLI. It does **not** bundle the Gemini CLI itself or a separate Gemini SDK.

- Primary bundled SDK dependency: `n/a`
- `VERSION`: `n/a`

The runtime bundle may include vendored project-internal code from `@shims/common`, which is part of the same shim codebase rather than a third-party SDK.

## Build-time tooling

These packages are used to build or type-check the shim package:

### esbuild

- Package: `esbuild`
- Version: `^0.27.0`
- License: MIT
- Copyright: Evan Wallace and esbuild contributors

### TypeScript

- Package: `typescript`
- Version: `^5.9.3`
- License: Apache-2.0
- Copyright: Microsoft Corp.

## License text

Full license text for third-party packages can be found in the corresponding npm package contents or the upstream source repository.
