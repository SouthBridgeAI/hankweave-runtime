# Shim Evaluation Suite

A comprehensive test suite for validating shim implementations against the [shim specification](../shim-spec-v2/spec.md).

## Purpose

This evaluation suite exists for one reason: **to enable AI agents to build working shims**.

When an AI agent implements a shim, it needs concrete, actionable feedback. This suite provides:

1. **Automated testing** - Run all tests with a single command
2. **Rich failure reports** - When things break, you know exactly why and where to look
3. **Complete artifact preservation** - Every test run saves all inputs, outputs, and workspace files

The suite is designed so that an AI agent can:

1. Read the [shim specification](../shim-spec-v2/spec.md)
2. Implement a shim
3. Run this evaluation suite
4. Read the failure report
5. Fix the issues
6. Repeat until all tests pass

## ⚠️ For AI Agents Building Shims

**Run these tests OFTEN during development, not just at the end!**

```bash
# Run validation tests after every significant change
bun run src/cli.ts --shim /path/to/your-shim --model your-model --category validation

# Run ALL tests before considering the shim complete
bun run src/cli.ts --shim /path/to/your-shim --model your-model
```

| Development Phase                | Tests to Run                                       |
| -------------------------------- | -------------------------------------------------- |
| After basic JSONL output works   | `--test valid-jsonl --test message-ordering`       |
| After tool handling added        | `--category validation`                            |
| After completion detection tuned | `--test premature-completion --test tool-workflow` |
| Before considering shim "done"   | All tests (no category flag)                       |
| After any bug fix                | Full test run to catch regressions                 |

**A shim that "seems to work" but fails tests WILL break orchestrators.**

## Quick Start

```bash
# Install dependencies
cd eval-suite
bun install

# Run against the Claude CLI (reference implementation)
bun run src/cli.ts --shim claude --model sonnet

# Run against a custom shim
bun run src/cli.ts --shim /path/to/your-shim --model your-model

# Run against a shim that needs arguments (e.g., node-based)
bun run src/cli.ts --shim "node /path/to/shim/dist/index.js" --model gemini-2.5-pro
```

## Installation

```bash
bun install
```

Or with npm:

```bash
npm install
```

## Usage

### Basic Usage

```bash
# Run all tests
bun run src/cli.ts --shim <shim-command> --model <model-name>

# Run specific test(s)
bun run src/cli.ts --shim <shim-command> --model <model-name> --test simple-response
bun run src/cli.ts --shim <shim-command> --model <model-name> --test simple-response --test tool-workflow

# Run tests by category
bun run src/cli.ts --shim <shim-command> --model <model-name> --category core
bun run src/cli.ts --shim <shim-command> --model <model-name> --category tools

# List all available tests
bun run src/cli.ts --list
```

### CLI Options

| Option              | Description                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `--shim <command>`  | Shim executable to test (required unless `--list`)                                                         |
| `--model <name>`    | Model to use for testing (default: `sonnet`)                                                               |
| `--test <name>`     | Run specific test(s), can be repeated                                                                      |
| `--category <name>` | Run tests in category: `core`, `tools`, `signals`, `sessions`, `errors`, `stress`, `validation`, `agentic` |
| `--parallel <n>`    | Run up to N tests in parallel (default: 5). Use `--parallel 1` for sequential runs.                        |
| `--timeout <ms>`    | Test timeout in milliseconds (default: 120000)                                                             |
| `--list`            | List all available tests and exit                                                                          |
| `-h, --help`        | Show help                                                                                                  |

### Examples

```bash
# Test the Claude CLI reference implementation
bun run src/cli.ts --shim claude --model sonnet

# Test a custom Node.js shim
bun run src/cli.ts --shim "node ./my-shim/dist/index.js" --model gemini-2.5-pro

# Run only the core tests
bun run src/cli.ts --shim claude --model sonnet --category core

# Run tests in parallel (4x faster!)
bun run src/cli.ts --shim claude --model sonnet --category validation --parallel 4

# Run signal handling tests
bun run src/cli.ts --shim claude --model sonnet --test sigint-handling --test sigterm-handling

# List all tests without running
bun run src/cli.ts --list
```

## Test Categories

### Core Tests (P1 - Must Pass)

These test fundamental shim behavior. A shim that fails these is completely broken.

| Test                   | Description                                                      |
| ---------------------- | ---------------------------------------------------------------- |
| `simple-response`      | Basic prompt → response → clean exit                             |
| `multi-turn-context`   | Agent maintains context within conversation                      |
| `valid-jsonl`          | Every output line is valid JSON                                  |
| `message-ordering`     | System init first, result last                                   |
| `premature-completion` | Shim waits for work to complete (doesn't exit on initial "idle") |

### Tool Tests (P1 - Must Pass)

These verify the agent can perform useful work.

| Test                      | Description                                             |
| ------------------------- | ------------------------------------------------------- |
| `tool-workflow`           | Combined Write → Read → Write workflow                  |
| `bash-command`            | Shell command execution with output capture             |
| `tool-completion-waiting` | Shim waits for slow tools (3+ second operations)        |
| `complex-workflow`        | Multi-step project creation (directories, files, reads) |
| `permission-handling`     | Tool operations don't hang on permissions               |

### Signal Tests (P1 - Must Pass)

| Test               | Description                      |
| ------------------ | -------------------------------- |
| `sigint-handling`  | Graceful exit on SIGINT (Ctrl+C) |
| `sigterm-handling` | Graceful exit on SIGTERM         |

### Session Tests (P2 - Should Pass)

| Test                     | Description                             |
| ------------------------ | --------------------------------------- |
| `invalid-session-resume` | Graceful error for non-existent session |
| `valid-session-resume`   | Session continuation maintains context  |

### Error Tests (P1 - Must Pass)

| Test           | Description                     |
| -------------- | ------------------------------- |
| `empty-prompt` | Empty stdin → exit 0, no output |

### Validation Tests (P1 - Must Pass)

These tests validate shim output format compliance. These are critical for ensuring shims produce correct, usable output.

| Test                    | Description                                                                      |
| ----------------------- | -------------------------------------------------------------------------------- |
| `valid-jsonl`           | Every output line is valid JSON                                                  |
| `tools-array-valid`     | System init tools array contains only valid tool names (no "invalid", "unknown") |
| `tool-name-not-unknown` | All tool_use messages have proper tool names                                     |
| `tool-input-not-empty`  | Tool inputs contain actual parameters (not empty `{}`)                           |
| `tool-results-emitted`  | Every tool_use has a corresponding tool_result                                   |
| `tool-id-format-valid`  | Tool IDs use proper format (`toolu_*` or `call_*`)                               |
| `message-ordering`      | Tool results appear after their tool_use, system first, result last              |
| `no-shell-pollution`    | Tool outputs don't contain shell initialization messages                         |
| `tool-result-content`   | Tool results contain meaningful content (not empty strings)                      |

### Stress Tests (P3 - Nice to Have)

| Test                  | Description                                 |
| --------------------- | ------------------------------------------- |
| `large-file-handling` | Read/report on 10,000 line file             |
| `unicode-handling`    | Non-ASCII characters in files and responses |

### Agentic Tests (P2/P3 - Advanced Workflows)

These test complex, multi-step agentic workflows that exercise advanced capabilities.

| Test                          | Description                                                     |
| ----------------------------- | --------------------------------------------------------------- |
| `deep-research-workflow`      | Web search, progress tracking, PDF generation for research task |
| `multi-file-project-creation` | Create structured TypeScript project with interdependent files  |
| `iterative-file-refinement`   | Create and iteratively improve a file within one conversation   |

## Output & Artifacts

Every test run creates a timestamped directory under `runs/`:

```
runs/
└── 2024-12-17T15-00-41-my-shim/
    ├── report.md              # Human/AI readable failure analysis
    ├── summary.json           # Machine-readable results
    │
    └── tests/
        ├── simple-response/
        │   ├── input.txt      # Prompt sent to shim
        │   ├── output.jsonl   # Raw stdout from shim
        │   ├── stderr.txt     # Raw stderr from shim
        │   └── workspace/     # Test working directory
        │
        ├── tool-workflow/
        │   ├── input.txt
        │   ├── output.jsonl
        │   ├── stderr.txt
        │   └── workspace/
        │       ├── data.txt       # Files created by agent
        │       └── summary.txt
        │
        └── ... (one directory per test)
```

### Report Structure

The generated `report.md` is designed to be read by AI agents fixing shim issues:

- **Summary** - Quick pass/fail counts
- **How the test was run** - Exact command to reproduce
- **Test descriptions** - What each test verifies and why
- **Failure details** - Expected vs actual, captured output, file paths
- **Debugging hints** - Where to look in the code, common causes
- **Run directory structure** - Navigate the artifacts

## Understanding Test Failures

### Reading Failure Reports

When a test fails, the report includes:

1. **What went wrong** - Clear description of the failure
2. **Expected vs Actual** - Specific values that didn't match
3. **Captured Output** - First 3000 chars of stdout/stderr inline
4. **Log paths** - Links to full output files
5. **Debugging hints** - Possible causes and code locations

### Common Failure Patterns

#### "tool_use has name: unknown"

**Cause:** Tool name not being extracted from SDK events

**Where to look:** Event translation layer where tool_use messages are created

**Solution:** Check what field contains the tool name in the raw SDK event. Common fields: `kind`, `title`, `name`, `function`

#### "tool_use has empty input {}"

**Cause:** Emitting tool_use on `pending` status before input is populated

**Where to look:** Tool event handler — look for where you emit `tool_use` messages

**Solution:** Wait for `running` or `completed` status, not `pending`. Many SDKs emit tool events in stages:

1. `pending` — input is empty `{}`
2. `running` — input is populated
3. `completed` — has input and output

Only emit `tool_use` on `running` (or later).

#### "Missing tool_result for tool_use"

**Cause:** Not emitting tool_result when tool completes

**Where to look:** Tool completion handler

**Solution:** When tool status becomes `completed` or `error`, emit a `user` message with `tool_result`. The `tool_use_id` must match the original `tool_use.id`.

#### "File X should exist"

**Cause:** Agent didn't complete all requested tasks

**Possible causes:**

- Premature completion detection (shim exiting too early)
- Tool call not being processed
- File write handler not working

**Where to look:** Check `output.jsonl` for tool_use → tool_result pairs. Missing pairs indicate dropped operations.

#### "Second run should succeed" (session resume)

**Cause:** Session persistence or loading not working

**Possible causes:**

- Session files not being saved to disk
- Session lookup using wrong ID
- Agent doesn't support session loading

**Where to look:** Session storage directory (`.{shim-name}/session-map.json` or similar)

#### "Exit code should be X"

**Cause:** Wrong exit code for the scenario

**Solution:** Review exit code handling:

- 0 = success
- 1 = error (with JSONL or stderr depending on error type)
- Clean exit on signals (0, 1, or 128+signal)

#### "Response should mention X"

**Cause:** Agent behavior issue (not a shim bug)

This typically means the LLM didn't include expected content in its response. These failures may indicate:

- The prompt wasn't clear enough
- The model has different response patterns
- Network/API issues

**Note:** Some tests verify agent behavior, which can vary between models. A shim can be compliant even if the underlying agent doesn't follow instructions perfectly.

## Shim vs Agent Issues

Some test failures are **shim bugs**, others are **agent behavior** issues:

### Shim Bugs (Your Code)

- Wrong JSONL format
- Missing system init / result messages
- Wrong exit codes
- Tool names not extracted
- Signals not handled
- Session persistence broken

### Agent Behavior (Model/API)

- Response doesn't contain expected text
- Agent doesn't complete all tasks
- Agent uses different tool names
- Session resume not supported by underlying API

The suite tries to minimize agent-dependent tests, but some are unavoidable. If your shim passes Claude CLI but fails on another agent, the failing tests may be agent-specific.

## Writing Custom Tests

Tests are TypeScript functions that return `TestResult`:

```typescript
interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: {
    message: string;
    expected?: string;
    actual?: string;
    context?: object;
  };
  logs: {
    stdout: string;
    stderr: string;
    workspace: string;
  };
}
```

### Test Pattern

```typescript
async function runMyTest(config: ShimConfig, workspace: WorkspaceManager): Promise<TestResult> {
  const testName = "my-test";
  const startTime = Date.now();
  const logger = getLogger();

  logger.testStart(testName);

  try {
    // Run shim with specific prompt
    const result = await runShim(
      config,
      {
        prompt: "Your prompt here",
        timeout: 30000,
      },
      workspace,
      testName
    );

    // Make assertions
    assertEqual(result.exitCode, 0, "Expected exit code 0");
    // ... more assertions

    const duration = Date.now() - startTime;
    logger.testPass(testName, duration);

    return {
      name: testName,
      passed: true,
      duration,
      logs: {
        stdout: result.stdout,
        stderr: result.stderr,
        workspace: result.workspace,
      },
    };

  } catch (error) {
    const duration = Date.now() - startTime;
    logger.testFail(testName, duration, error.message);

    return {
      name: testName,
      passed: false,
      duration,
      error: error.toTestError(),
      logs: { ... },
    };
  }
}
```

### Available Assertions

```typescript
// Basic assertion
assert(condition, "Message", { context });

// Equality
assertEqual(actual, expected, "Message", { context });

// Contains check
assertContains(haystack, needle, "Message");

// Defined check
assertDefined(value, "Message");
```

### Available Utilities

```typescript
// Parse JSONL output
const messages = parseJsonl(stdout);

// Get specific message types
const systemMsg = getSystemMessage(messages);
const resultMsg = getResultMessage(messages);
const assistantText = getAllAssistantText(messages);
const toolNames = getUniqueToolNames(messages);

// File operations in workspace
const exists = await workspace.fileExists(workspacePath, "file.txt");
const content = await workspace.readFile(workspacePath, "file.txt");
```

## Reference Implementation

The Claude Code CLI (`claude`) serves as the reference implementation. All tests are designed to pass against Claude Code. When developing:

```bash
# Test the evaluation suite itself against Claude
bun run src/cli.ts --shim claude --model sonnet
```

If tests pass against Claude but fail against your shim, the issue is in your shim. If tests fail against Claude, there may be a bug in the test.

## Architecture

```
shim-eval-suite/
├── src/
│   ├── cli.ts              # Command-line interface
│   ├── runner.ts           # Test orchestration
│   ├── shim.ts             # Shim process spawning
│   ├── workspace.ts        # Test directory management
│   ├── logger.ts           # Colored console output
│   ├── reporter.ts         # Report generation
│   ├── types.ts            # TypeScript interfaces
│   │
│   ├── tests/              # Test implementations
│   │   ├── core.ts         # Core functionality tests
│   │   ├── tools.ts        # Tool usage tests
│   │   ├── signals.ts      # Signal handling tests
│   │   ├── sessions.ts     # Session management tests
│   │   ├── errors.ts       # Error handling tests
│   │   ├── stress.ts       # Stress/edge case tests
│   │   └── index.ts        # Test registry
│   │
│   └── utils/
│       ├── assertions.ts   # Custom assertions with rich context
│       ├── parsing.ts      # JSONL parsing utilities
│       └── validation.ts   # ID format validation
│
├── runs/                   # Test output (gitignored)
├── SPEC.md                 # Detailed test specifications
└── package.json
```

## Pitfalls & Edge Cases

### Shim Command With Spaces

If your shim command contains spaces (e.g., `node /path/to/shim`), quote it:

```bash
bun run src/cli.ts --shim "node /path/to/shim/dist/index.js" --model gemini-2.5-pro
```

### Timeout Issues

Default test timeout is 180 seconds (3 minutes). Long-running agentic tests (like `deep-research-workflow`) have longer individual timeouts.

### Parallel Testing

By default, tests run with `--parallel 5` for faster execution. Be aware:

- **API Rate Limits**: Running multiple tests in parallel can hit API rate limits, causing timeouts
- **Long-Running Tests**: Agentic tests may take 5-10 minutes; they'll hold a parallel slot

If you see unexpected timeouts during parallel runs, try reducing parallelism:

```bash
bun run src/cli.ts --shim claude --model sonnet --parallel 2  # Less aggressive
bun run src/cli.ts --shim claude --model sonnet --parallel 1  # Sequential (slowest but safest)
```

> **Note:** Per the shim spec (Section 1.4), shims MUST use dynamic port allocation to support parallel execution. Shims that use deterministic ports are non-compliant.

### Permission Prompts

Shims must auto-approve all permission requests. If your shim prompts for permissions, tests will hang and timeout.

### Session Storage Location

Sessions are stored in the test's workspace directory. Different workspace = different session context. The `valid-session-resume` test uses a shared workspace for both runs.

### Debug Directory Isolation

The evaluation suite automatically passes `--debug-dir <workspace>/.shim-debug` to all shim invocations. This ensures:

- Shims don't create debug folders in unexpected locations
- All debug artifacts are captured within the test workspace
- Shims comply with the spec requirement to only write debug files when `--debug-dir` is provided

If your shim doesn't support `--debug-dir`, it should ignore unknown arguments (per spec). However, compliant shims should use this directory for any debug logs, raw agent data, or session files.

### Signal Tests

Signal tests send SIGINT/SIGTERM after ~2 seconds. Your shim should exit gracefully without hanging. Acceptable exit codes: 0, 1, or 128+signal_number.

### Network Requirements

Tests make real API calls. Ensure:

- API keys are configured in environment
- Network access is available
- Rate limits won't be hit

### Workspace Isolation

Each test gets its own workspace directory. Tests don't share files unless explicitly designed to (like session resume tests).

## Exit Codes

| Code | Meaning                  |
| ---- | ------------------------ |
| 0    | All tests passed         |
| 1    | One or more tests failed |

## Related Documentation

- [Shim Specification](../shim-spec-v2/spec.md) - The contract shims must implement
- [Eval Suite Spec](./SPEC.md) - Detailed test specifications and rationale
- [Report Example](./runs/) - Example reports (after running tests)

## License

MIT
