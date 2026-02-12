# Clausetta

**A hank for building polymorphic agent shims**

Clausetta generates, tests, and documents shims—command-line executables that translate between Hankweave's standardized orchestration interface and specific AI coding agents (Gemini CLI, OpenCode, etc.).

## What is a Shim?

A shim is a translation layer that allows Hankweave to orchestrate any AI coding agent through a consistent interface:

```
┌────────────────────┐
│   HANKWEAVE        │
│   (Orchestrator)   │
└─────────┬──────────┘
          │  Standardized Interface
          ▼
┌────────────────────┐
│   SHIM             │  ← Clausetta builds these
│   (Translator)     │
└─────────┬──────────┘
          │  Agent-specific Protocol
          ▼
┌────────────────────┐
│   AI AGENT         │
│   (Gemini/OpenCode)│
└────────────────────┘
```

## When to Use This Hank

Run Clausetta when you need to:
- Add support for a new AI coding agent to Hankweave
- Build a shim from agent documentation and SDK references
- Test an existing shim against the eval suite
- Document a shim for distribution

## Input Requirements

Place the following in your data directory:
- Agent documentation (API docs, SDK reference, event formats)
- Authentication requirements
- Any existing shim code to continue working on

## How It Works

### Phase 1: Build Pre-Loop (Research & Initial Build)
Sets up the workspace with the eval suite and begins researching the target agent. Creates initial shim implementation with research notes.

### Phase 2: Build Loop (Iterative Development)
Continues building and refining the shim through research and implementation cycles. Each iteration improves the shim based on discoveries.

### Phase 3: Evaluation Loop (Testing & Fixing)
Runs the shim against the comprehensive eval suite:
- Validates JSONL output format
- Checks message ordering (system init first, result last)
- Verifies tool_use/tool_result pairing
- Tests session continuation
- Ensures no permission hangs

Documents issues and fixes them iteratively.

### Phase 4: Documentation
Cleans up the code, removes unnecessary files, and creates comprehensive markdown documentation for shim users.

## Outputs

- `shim/` — Complete, working shim implementation
- `research.md` — Research notes on agent behavior and quirks
- `thoughts_questions_and_issues.md` — Development log of decisions and issues
- `docs/` — User documentation for the shim

## Shim Requirements

Shims built by Clausetta conform to the shim specification:

| Requirement | Description |
|-------------|-------------|
| JSONL output | Each line is valid JSON, UTF-8 encoded |
| Message ordering | System init first, result last |
| Tool normalization | Standard names (Read, Write, Bash, etc.) |
| Permission bypass | Auto-approve all permissions (headless) |
| Session management | Create, persist, and resume sessions |
| Parallel execution | Dynamic port allocation for concurrency |

## Running the Hank

```bash
# Place agent docs in data directory
cd /path/to/agent-docs

# Run with Hankweave
hankweave --config=/path/to/clausetta/hank.json --data=.
```

## Eval Suite

The included `eval-suite/` validates shim compliance:

```bash
cd eval-suite
bun install
bun run src/cli.ts --shim /path/to/your-shim --model your-model
```

Tests cover:
- Output format validation
- ID format (UUID, msg_*, toolu_*)
- Tool workflow (use → result pairing)
- Session continuation
- Graceful error handling

## Structure

```
clausetta/
├── hank.json              # Hank configuration
├── shim-spec.md           # Complete shim specification (appended to system prompts)
├── codons/
│   ├── 1-loop-build-shim.md    # Build phase prompt
│   ├── 2-eval-shim.md          # Evaluation phase prompt
│   └── 3-test-and-document.md  # Documentation phase prompt
└── eval-suite/            # Test suite for validating shims
    ├── src/
    └── package.json
```

## Example Shim Output

```jsonl
{"type":"system","subtype":"init","session_id":"550e8400-...","cwd":"/workspace","tools":["Read","Write","Bash"],"model":"gemini-2.5-flash","permissionMode":"bypassPermissions","apiKeySource":"env"}
{"type":"assistant","message":{"id":"msg_abc123","type":"message","role":"assistant","model":"gemini-2.5-flash","content":[{"type":"text","text":"I'll help you..."}]}}
{"type":"result","subtype":"success","is_error":false,"duration_ms":1234,"num_turns":1,"result":"Task completed"}
```

## Notes

- The reference implementation is Claude Code CLI (`claude`)
- When in doubt about behavior, match what Claude Code does
- Shims must never block waiting for user input—auto-approve everything
- Always test with real API calls, not mocks
