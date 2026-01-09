# Strandweave Packaging Details

This document covers the technical details, edge cases, and solutions for building Strandweave as a standalone executable.

## Overview

Strandweave uses [Bun's compile feature](https://bun.sh/docs/bundler/executables) to create single-file executables. However, the Claude Agent SDK requires special handling because it spawns `cli.js` as a subprocess—which can't run directly from Bun's virtual filesystem.

## The Problem

When you compile a Bun application with `bun build --compile`, all JavaScript/TypeScript files get bundled into a single executable. At runtime, these files exist in Bun's virtual filesystem (`$bunfs`), not on the real disk.

The Claude Agent SDK works by spawning `cli.js` as a child process:

```typescript
// Inside the SDK
spawn("bun", [pathToCliJs, ...args]);
```

This fails in compiled executables because:

1. `cli.js` lives at `/$bunfs/root/node_modules/@anthropic-ai/claude-agent-sdk/cli.js`
2. `spawn()` can only execute files on the real filesystem
3. The SDK's path resolution returns the virtual path, not a real file

### Error We Saw

```
Claude Code executable not found at /$bunfs/root/cli.js.
Is options.pathToClaudeCodeExecutable set?
```

## The Solution: Runtime Extraction

We embed the SDK files during compilation and extract them to disk at runtime.

### Build Process

The build script (`scripts/build-executable.ts`) embeds necessary files:

```bash
bun build server/index.ts --compile \
  --embed node_modules/@anthropic-ai/claude-agent-sdk/cli.js \
  --embed node_modules/@anthropic-ai/claude-agent-sdk/resvg.wasm \
  --embed node_modules/@anthropic-ai/claude-agent-sdk/tree-sitter.wasm \
  --embed node_modules/@anthropic-ai/claude-agent-sdk/tree-sitter-bash.wasm \
  --embed node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep/<platform>/rg \
  --embed node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep/<platform>/ripgrep.node \
  --outfile releases/strandweave-<platform>
```

### Runtime Extraction

At startup, `server/claude-runtime-extractor.ts` handles extraction:

1. **Detection**: Check if running as compiled executable

   ```typescript
   function isCompiledExecutable(): boolean {
     return process.argv[1]?.startsWith("/$bunfs/");
   }
   ```

2. **Versioned Cache**: Extract to `~/.strandweave/claude-sdk/<version>/`

   - Avoids re-extraction on every run
   - Handles SDK updates cleanly

3. **Extraction**: Read embedded files with `Bun.file()` and write to disk

   ```typescript
   const content = await Bun.file(`${EMBEDDED_SDK_PATH}/cli.js`).arrayBuffer();
   await Bun.write(destPath, content);
   ```

4. **Environment Setup**: Set `CLAUDE_PATH_TO_CLAUDE_EXECUTABLE` to the extracted path

### Files Extracted

| File                                     | Purpose          | Required    |
| ---------------------------------------- | ---------------- | ----------- |
| `cli.js`                                 | Claude Code CLI  | ✅ Yes      |
| `resvg.wasm`                             | SVG rendering    | ❌ Optional |
| `tree-sitter.wasm`                       | Syntax parsing   | ❌ Optional |
| `tree-sitter-bash.wasm`                  | Bash syntax      | ❌ Optional |
| `vendor/ripgrep/<platform>/rg`           | Fast file search | ❌ Optional |
| `vendor/ripgrep/<platform>/ripgrep.node` | Node bindings    | ❌ Optional |

## Edge Cases & Solutions

### 1. Bun Virtual Filesystem Detection

**Problem**: Need to reliably detect when running as a compiled executable.

**Solution**: Check if `process.argv[1]` starts with `/$bunfs/`:

```typescript
const mainPath = process.argv[1] || "";
return mainPath.startsWith("/$bunfs/root/");
```

Other approaches tried (less reliable):

- Checking `import.meta.url` (also returns `$bunfs` paths)
- Checking if `node_modules` exists (fails if cwd has node_modules)
- Using `require.resolve()` (can find host's node_modules)

### 2. WASM/Binary Files Not Extracting

**Problem**: Only `cli.js` extracts successfully; WASM and binary files fail with "Embedded file not found".

**Status**: Known limitation. Possibly a Bun `--embed` behavior with non-JS files.

**Workaround**: Mark these as optional. Core functionality works without them:

- WASM files: Used for syntax highlighting and SVG rendering
- Ripgrep: Used for fast file search (falls back to slower methods)

### 3. glibc vs musl Incompatibility

**Problem**: Bun compiles executables using glibc. Running on Alpine Linux (musl) fails:

```
Dynamic loader not found: /lib64/ld-linux-x86-64.so.2
```

**Solution**: Use Debian-based containers, not Alpine:

```dockerfile
# ❌ WRONG - Alpine uses musl
FROM oven/bun:1-alpine

# ✅ CORRECT - Debian uses glibc
FROM debian:bookworm-slim
```

### 4. Architecture Mismatch

**Problem**: Building `linux-x64` on Apple Silicon requires x86_64 emulation in Docker, which is slow and may fail.

**Solution**: Build for the native architecture:

```bash
# On Apple Silicon Mac
bun build:linux-arm   # → strandweave-linux-arm64

# On Intel Mac/Linux
bun build:linux       # → strandweave-linux-x64
```

Use matching Docker platform:

```bash
docker run --platform linux/arm64 ...  # For ARM64 builds
docker run --platform linux/amd64 ...  # For x64 builds
```

### 5. Claude SDK Requires Bun in PATH

**Problem**: The SDK spawns `cli.js` using Bun:

```
Executable not found in $PATH: "bun"
```

**Solution**: Bun must be installed on the target system:

```dockerfile
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/home/testuser/.bun/bin:$PATH"
```

**Note**: This is a requirement of the Claude Agent SDK, not Strandweave. Users need Bun installed to run the standalone executable.

### 6. Environment Variable Passthrough

**Problem**: `ANTHROPIC_API_KEY` must reach the Claude subprocess.

**Solution**: The SDK manager explicitly passes through Anthropic environment variables:

```typescript
if (key.startsWith("ANTHROPIC_")) {
  options.env[key] = process.env[key];
}
```

### 7. Entry Point Ordering in Bun Build

**Problem**: If `--embed` flags appear before the entry point, Bun may treat embedded `.js` files as entry points.

**Solution**: Always put the entry point first:

```bash
# ✅ CORRECT
bun build server/index.ts --compile --embed cli.js ...

# ❌ WRONG - cli.js might be treated as entry point
bun build --compile --embed cli.js server/index.ts ...
```

### 8. Graceful Shutdown with TUI

**Problem**: BasicTUI sets `stdin` to raw mode, which keeps the process alive even after errors.

**Solution**:

- TUI listens for "shutdown" event from server
- Cleanup restores stdin: `setRawMode(false)` and `pause()`
- State transitions include required metadata (e.g., `exitCode` for "failed" state)

## Docker Test Environment

### Dockerfile (`scripts/test-docker/Dockerfile`)

```dockerfile
FROM debian:bookworm-slim

# Install utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl git ca-certificates bsdutils unzip

# Install Node.js (required by cli.js)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs

# Create non-root user
RUN useradd -m testuser
USER testuser

# Install Bun (required by Claude SDK)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/home/testuser/.bun/bin:$PATH"
```

### Key Design Decisions

1. **Debian over Alpine**: glibc compatibility
2. **Non-root user**: Realistic testing environment
3. **Bun installation**: Required by Claude SDK
4. **Node.js**: May be needed by cli.js internals
5. **Minimal packages**: Keep image small

### Test Scripts

| Script                              | Purpose                                                 |
| ----------------------------------- | ------------------------------------------------------- |
| `bun test:docker`                   | Quick validation (--help, --validate, extraction check) |
| `bun test:docker:e2e`               | Full codon execution with real Claude API               |
| `bun test:docker:x64`               | Force x64 build (for Intel targets)                     |
| `bun test:docker:full-e2e`          | Run full happy-path + rollback test suites in Docker    |
| `bun test:docker:full-e2e:happy`    | Run only happy-path E2E tests in Docker                 |
| `bun test:docker:full-e2e:rollback` | Run only rollback E2E tests in Docker                   |
| `bun test:docker:full-e2e:shell`    | Drop into shell for debugging                           |

### Full E2E Test Suite in Docker

For comprehensive testing, you can run the complete E2E test suites inside a Docker container. This tests the full Strandweave functionality in a clean Linux environment.

```bash
# Run both test suites (happy-path + rollback)
bun test:docker:full-e2e

# Run individual suites
bun test:docker:full-e2e:happy      # Just happy-path tests
bun test:docker:full-e2e:rollback   # Just rollback tests

# Debug mode - drops into shell
bun test:docker:full-e2e:shell
```

**Requirements**:

- Docker must be running
- `ANTHROPIC_API_KEY` must be set in your environment
- Tests run against live Claude API (costs money)

**What it tests**:

- Full codon execution flow
- Checkpoint system (git-based)
- Rollback functionality
- State management
- Event journaling
- File watching
- Sentinel integration

**Note**: These tests run from source code, not the compiled executable. They validate Strandweave's core functionality in a clean Linux environment, independent of your local development setup.

## Build Commands

```bash
# Build for current platform
bun build

# Build for specific targets
bun build:linux        # Linux x64
bun build:linux-arm    # Linux ARM64
bun build:mac          # macOS ARM64 (Apple Silicon)
bun build:mac-intel    # macOS x64 (Intel)

# Build all platforms
bun build:all
```

Output goes to `releases/` directory:

```
releases/
├── strandweave-linux-x64
├── strandweave-linux-arm64
├── strandweave-darwin-arm64
├── strandweave-darwin-x64
└── strandweave-windows-x64.exe
```

## Distribution Requirements

For users to run the standalone executable, they need:

1. **The executable** (~120MB, contains embedded SDK files)
2. **Bun runtime** (required by Claude SDK to run cli.js)
3. **ANTHROPIC_API_KEY** environment variable

That's it—no Node.js, no npm install, no Claude CLI installation needed.

## Troubleshooting

### "Claude Code executable not found at /$bunfs/..."

- Extraction may have failed
- Check `~/.strandweave/claude-sdk/<version>/cli.js` exists
- Delete the directory and let it re-extract

### "Executable not found in $PATH: bun"

- Bun is not installed on the target system
- Install with: `curl -fsSL https://bun.sh/install | bash`

### "Dynamic loader not found: /lib64/ld-linux-x86-64.so.2"

- Running glibc executable on musl system (Alpine)
- Use Debian/Ubuntu-based container instead

### WASM files not extracting

- Known limitation with Bun's `--embed` for non-JS files
- Core functionality works without them
- These provide optional features (syntax highlighting, SVG rendering)

## Future Improvements

1. **Investigate WASM embedding**: Figure out why non-JS files don't extract
2. **Remove Bun dependency**: If Claude SDK allows Node.js to run cli.js
3. **Static linking**: Explore options to eliminate glibc dependency
4. **Windows testing**: Add Windows container tests
5. **Size optimization**: Investigate reducing the 120MB executable size
