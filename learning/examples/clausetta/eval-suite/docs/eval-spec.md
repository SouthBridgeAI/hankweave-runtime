# Shim Evaluation Suite Specification

## Purpose

This evaluation suite exists for one reason: **to enable AI agents to build working shims**.

An AI agent will:

1. Read the shim specification (`shim-spec-v2/spec.md`)
2. Implement a shim
3. Run this evaluation suite
4. Read the failure report
5. Fix the issues
6. Repeat until all evaluations pass

**The implementation is only as good as the evaluation.** If the eval doesn't catch a bug, the shim ships broken. If the eval doesn't explain a bug, the AI wastes time guessing.

**Reference Implementation:** The Claude Code CLI (`claude`) serves as the reference. All tests are designed to pass against Claude Code.

---

## Design Principles

### 1. Explicit Code, Not Frameworks

Don't build a generic "scenario executor" that reads config files. Just write explicit TypeScript code for each test. The scenarios are documented here in English; the implementation is straightforward test code.

```typescript
// Good: Explicit test code
async function testSimpleHello() {
  const result = await runShim({
    prompt: "Say hello",
    model: "gemini-2.5-pro",
  });

  assert(result.exitCode === 0, "Expected exit 0");
  assert(result.messages[0].type === "system", "First message must be system");
  assert(hasAssistantMessage(result), "Must have assistant response");
}

// Bad: Generic framework
const scenario = loadYAML("simple-hello.yaml");
await scenarioRunner.execute(scenario);
```

### 2. Preserve All Logs

Every evaluation run saves complete logs. When something fails, the report points to exact log files and line numbers.

```
runs/
├── 2024-12-17T17-30-00-gemini-cli-shim/
│   ├── report.md              # Human/AI readable report
│   ├── summary.json           # Machine readable results
│   │
│   └── tests/
│       ├── simple-hello/
│       │   ├── input.txt      # Prompt sent
│       │   ├── output.jsonl   # Raw shim stdout
│       │   ├── stderr.txt     # Shim stderr
│       │   └── workspace/     # Test files created
│       │
│       ├── tool-workflow/
│       │   └── ...
```

### 3. Verify Via Files

The best way to verify agent behavior is to ask it to create files, then check those files exist with correct content. This is concrete and unambiguous.

```typescript
// Ask agent to create a file
const result = await runShim({
  prompt: "Create a file called hello.txt containing 'Hello World'",
});

// Verify the file exists
const content = await fs.readFile(path.join(workspace, "hello.txt"), "utf-8");
assert(content.includes("Hello World"), "File should contain Hello World");
```

### 4. Combine Tests in Complex Runs

Many behaviors can be tested together in a single complex agentic run. This is more efficient and tests realistic usage patterns.

```typescript
// One complex run tests multiple behaviors
const result = await runShim({
  prompt: `
    1. Create a file called step1.txt with content "first"
    2. Read step1.txt and create step2.txt with the same content plus " second"
    3. List all .txt files
    4. Tell me how many files you created
  `,
});

// Check multiple things from one run
assert(await fileExists("step1.txt"), "step1.txt should exist");
assert(await fileExists("step2.txt"), "step2.txt should exist");
assert(
  (await readFile("step2.txt")).includes("second"),
  "step2 should have 'second'"
);
assert(
  result.toolCalls.some((t) => t.name === "Write"),
  "Should use Write tool"
);
assert(
  result.toolCalls.some((t) => t.name === "Read"),
  "Should use Read tool"
);
```

### 5. Fail Loudly With Context

When a test fails, provide everything needed to debug:

```markdown
### ❌ FAILED: test-tool-workflow

**What went wrong:** step2.txt was not created

**Expected:** File `step2.txt` exists with content containing "second"
**Actual:** File does not exist

**Log files:**

- Output: `runs/.../tests/tool-workflow/output.jsonl`
- Stderr: `runs/.../tests/tool-workflow/stderr.txt`

**Messages received:**

1. system.init (line 1)
2. assistant with tool_use "Write" for step1.txt (line 2)
3. user with tool_result (line 3)
4. result with is_error: false (line 4)

**Analysis:** Agent created step1.txt but stopped before creating step2.txt.
This suggests premature completion detection.

**Where to look:** `src/agent/events.ts` - completion detection logic
```

---

## Test Categories

### Priority 1: Core Functionality (Must Pass)

These test the fundamental contract. A shim that fails these is completely broken.

### Priority 2: Tool Usage (Must Pass)

These verify the agent can actually do useful work.

### Priority 3: Edge Cases (Should Pass)

These catch subtle bugs that might not appear in happy-path usage.

### Priority 4: Stress Tests (Nice to Have)

These verify behavior under unusual conditions.

---

## Test Specifications

Each test is described in English. The implementation is explicit TypeScript code.

---

### TEST: Simple Response

**What we're testing:** The most basic flow - prompt in, text response out, clean exit.

**Spec references:** Section 3.2 (Message Types), Section 3.7 (Exit Codes)

**Priority:** P1 - Core

**How to test:**

1. Run shim with prompt "Say hello"
2. Verify exit code is 0
3. Verify first message is `type: "system"`, `subtype: "init"`
4. Verify at least one message has `type: "assistant"` with text content
5. Verify last message is `type: "result"` with `is_error: false`
6. Verify response contains some greeting (case-insensitive "hello")

**What to check in system init:**

- `session_id` is valid UUID v4
- `cwd` is an absolute path
- `tools` array is non-empty
- `model` matches what was requested

**Failure hints:**

| Symptom                          | Likely Cause                                     | Where to Look                              |
| -------------------------------- | ------------------------------------------------ | ------------------------------------------ |
| No assistant message             | Premature completion (exiting on initial "idle") | `src/agent/events.ts` - work-started latch |
| Exit code 1 but no error content | Exit code not matching `is_error`                | `src/shim.ts` - exit handling              |
| Invalid session_id format        | Wrong UUID generation                            | `src/utils/ids.ts`                         |

---

### TEST: Multi-Turn Context

**What we're testing:** The agent maintains context within a session.

**Priority:** P1 - Core

**How to test:**

1. Run shim with prompt "My name is Alice. Remember that. What is my name?"
2. Verify response contains "Alice"

This is a simple test that the agent received and processed the full prompt.

---

### TEST: Tool Workflow (Combined)

**What we're testing:** Multiple tool operations in one run - Write, Read, file verification.

**Priority:** P1 - Tools

**How to test:**

1. Run shim with this prompt:

   ```
   Please do the following in order:
   1. Create a file called data.txt containing exactly "test data 123"
   2. Read data.txt and tell me what it contains
   3. Create a file called summary.txt containing "Read complete"
   ```

2. After run completes, verify:
   - Exit code is 0
   - File `data.txt` exists with content "test data 123"
   - File `summary.txt` exists with content containing "Read complete"
   - Output contains "test data 123" (agent reported what it read)
   - Tool calls include Write (at least 2 times) and Read (at least once)
   - Every tool_use has a matching tool_result

**Failure hints:**

| Symptom                        | Likely Cause                     | Where to Look                                |
| ------------------------------ | -------------------------------- | -------------------------------------------- |
| tool_use has `name: "unknown"` | Tool name not extracted from SDK | `src/agent/events.ts` - tool name extraction |
| tool_use has empty `input: {}` | Tool input not extracted         | `src/utils/tools.ts` - convertToolInput      |
| Files don't exist              | Tool results not being processed | Check tool_result content in logs            |
| Orphan tool_use (no result)    | Tool result not being emitted    | `src/agent/events.ts` - tool result handling |

---

### TEST: Bash Command Execution

**What we're testing:** Shell commands execute and output is captured.

**Priority:** P1 - Tools

**How to test:**

1. Run shim with prompt:

   ```
   Run the command "echo hello_from_bash" and tell me what it outputs.
   Then create a file called bash_test.txt containing the output.
   ```

2. Verify:
   - Exit code is 0
   - Tool calls include Bash
   - Response mentions "hello_from_bash"
   - File `bash_test.txt` exists and contains "hello_from_bash"

---

### TEST: Session Resume - Invalid Session

**What we're testing:** Graceful error when resuming non-existent session.

**Spec reference:** Section 2.5 (Error Handling)

**Priority:** P2 - Edge Cases

**How to test:**

1. Run shim with:

   - Prompt: "Hello"
   - Args: `--resume 00000000-0000-0000-0000-000000000000`

2. Verify:
   - Exit code is 1
   - stderr contains error about session not found
   - Does NOT hang (completes within reasonable timeout)

**Failure hints:**

| Symptom       | Likely Cause                        | Where to Look          |
| ------------- | ----------------------------------- | ---------------------- |
| Hangs forever | Not handling session lookup failure | `src/agent/session.ts` |
| Exit 0        | Not propagating error state         | Exit code logic        |

---

### TEST: Session Resume - Valid Session

**What we're testing:** Session continuation actually maintains context.

**Priority:** P2 - Edge Cases

**How to test:**

1. **First run:**

   - Prompt: "Remember the secret code: PURPLE_ELEPHANT_42. Just acknowledge you've remembered it."
   - Save the session_id from the result

2. **Second run:**

   - Prompt: "What was the secret code I told you earlier?"
   - Args: `--resume <session_id_from_first_run>`

3. Verify second run:
   - Exit code is 0
   - Response contains "PURPLE_ELEPHANT_42" or close variant
   - session_id in second run is the SAME as first run (reused per spec)

**Failure hints:**

| Symptom          | Likely Cause                   | Where to Look                      |
| ---------------- | ------------------------------ | ---------------------------------- |
| Doesn't remember | Session not found              | `src/agent/session.ts` - session storage |
| Different session_id | Not reusing ID on resume    | Session ID handling               |
| Error on resume  | Session storage not persisted  | Check `.{shim-name}/` directory    |

---

### TEST: Signal Handling - SIGINT

**What we're testing:** Shim handles SIGINT gracefully.

**Spec reference:** Section 4.3 (Signal Handling)

**Priority:** P1 - Core

**How to test:**

1. Run shim with long-running prompt: "Write a very detailed 5000 word essay about the history of computing"
2. After ~2 seconds, send SIGINT to the process
3. Verify:
   - Exit code is 0 or 1 (clean exit, not crash)
   - Process doesn't hang

**Note:** Per spec, shims should exit cleanly on signals. The key is they don't hang.

---

### TEST: Signal Handling - SIGTERM

**What we're testing:** Same as SIGINT but with SIGTERM.

**Priority:** P1 - Core

Same test as SIGINT but send SIGTERM instead.

---

### TEST: Empty Prompt

**What we're testing:** Empty stdin exits cleanly with no output.

**Spec reference:** Section 2.4 (Standard Input)

**Priority:** P1 - Core

**How to test:**

1. Run shim with EMPTY stdin (or just whitespace)
2. Verify:
   - Exit code is 0
   - stdout is EMPTY (no JSONL)

---

### TEST: Output Format - Valid JSONL

**What we're testing:** Every line of stdout is valid JSON.

**Spec reference:** Section 3.1 (Format: JSONL)

**Priority:** P1 - Core

**How to test:**

1. Run any successful shim invocation
2. For each line in stdout:
   - Verify it parses as JSON
   - Verify no blank lines
3. Verify output is UTF-8 encoded
4. Verify each line ends with exactly one `\n`

---

### TEST: Output Format - Message Ordering

**What we're testing:** System init first, result last.

**Spec reference:** Section 3.2 (Message Types)

**Priority:** P1 - Core

**How to test:**

1. Run any successful shim invocation
2. Verify:
   - First message: `type: "system"`, `subtype: "init"`
   - Last message: `type: "result"`
   - Only ONE system init message total

---

### TEST: ID Formats

**What we're testing:** All IDs conform to spec formats.

**Spec reference:** Appendix B (ID Format Reference)

**Priority:** P1 - Core

**How to test:**

1. Run a shim invocation that uses tools (to generate tool IDs)
2. Verify session_id matches UUID v4 regex:
   ```
   ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$
   ```
3. Verify message IDs match: `^(msg_[a-zA-Z0-9]+|[0-9a-f-]{36})$`
4. Verify tool_use IDs match: `^(toolu_[a-zA-Z0-9]+|call_[a-fA-F0-9]+)$`

---

### TEST: Premature Completion

**What we're testing:** Shim doesn't exit on initial "idle" before work starts.

**Spec reference:** Section 4.2 (Completion Detection - Work-started latch)

**Priority:** P2 - Edge Cases

**How to test:**

1. Run shim with prompt: "Count from 1 to 10, one number per line"
2. Verify:
   - Exit code is 0
   - Response contains all numbers 1-10
   - Result has `usage.input_tokens > 0` (if usage reported)

**Failure hints:**

| Symptom                     | Likely Cause                    | Where to Look            |
| --------------------------- | ------------------------------- | ------------------------ |
| Empty response, 0 tokens    | Completing on initial idle      | Work-started latch logic |
| Partial response (only 1-3) | Completion timer too aggressive | Timer reset on activity  |

---

### TEST: Tool Completion Waiting

**What we're testing:** Shim waits for slow tool operations to complete.

**Priority:** P2 - Edge Cases

**How to test:**

1. Run shim with prompt:
   ```
   Run the command "sleep 3 && echo done" and tell me what it outputs.
   ```
2. Verify:
   - Duration is at least 3 seconds
   - Response contains "done"
   - Exit code is 0

If shim completes in under 3 seconds, it's not waiting for tool completion.

---

### TEST: Permission Handling

**What we're testing:** Operations that might need permissions don't hang.

**Spec reference:** Section 4.6 (Permission Handling)

**Priority:** P2 - Edge Cases

**How to test:**

1. Run shim with prompt that requires tool use:
   ```
   Create a file called test.txt and run "ls -la"
   ```
2. Set timeout to 30 seconds
3. Verify:
   - Completes within timeout (doesn't hang)
   - Exit code is 0
   - File exists

If it hangs, permission requests are blocking.

---

### TEST: Large File Handling

**What we're testing:** Can handle reading/writing larger files.

**Priority:** P3 - Stress

**How to test:**

1. Before run, create `large.txt` with 10,000 lines of text
2. Run shim: "Read large.txt and tell me how many lines it has"
3. Verify:
   - Exit code is 0
   - Response mentions approximately 10,000 (could be 9999 depending on counting)
   - Doesn't crash or timeout

---

### TEST: Unicode Handling

**What we're testing:** Non-ASCII characters work in prompts and files.

**Priority:** P3 - Stress

**How to test:**

1. Before run, create `unicode.txt` containing: `こんにちは 🌍 مرحبا`
2. Run shim: "Read unicode.txt and repeat its contents back to me"
3. Verify:
   - Exit code is 0
   - Response contains the unicode characters
   - Output JSONL is valid UTF-8

---

### TEST: Complex Workflow (Combined)

**What we're testing:** A realistic multi-step workflow testing many behaviors at once.

**Priority:** P1 - Tools

**How to test:**

1. Run shim with this prompt:

   ```
   I need you to do a small project:

   1. Create a directory structure:
      - project/
        - src/
        - docs/

   2. Create project/src/main.py with a simple "Hello World" Python script

   3. Create project/docs/README.md with a brief description

   4. List all files you created

   5. Read main.py and tell me what it does
   ```

2. After run, verify:
   - Exit code is 0
   - Directory `project/src` exists
   - Directory `project/docs` exists
   - File `project/src/main.py` exists and contains Python code
   - File `project/docs/README.md` exists
   - Multiple tool types were used (Write, Bash/mkdir, Read, LS/Glob)
   - All tool_use have matching tool_result
   - Response describes what main.py does

This single test verifies:

- Multi-turn conversation
- Sequential tool operations
- Different tool types
- Tool result pairing
- File system operations
- Context maintenance (remembers what it created)

---

## Validation Tests (New)

These tests catch common shim implementation bugs discovered through real-world testing.

---

### TEST: Tools Array Valid

**What we're testing:** System init tools array contains only valid tool names, not placeholders.

**Spec reference:** Section 3.3 (System Init Message - Tools Array Validation)

**Priority:** P1 - Core

**How to test:**

1. Run any shim invocation
2. Parse the system init message
3. Verify tools array:
   - Is not empty
   - Contains no entries like "invalid", "unknown", "", "undefined", "null"
   - Ideally only contains standard tool names (Read, Write, Edit, Bash, Glob, Grep, LS)

**Failure hints:**

| Symptom | Likely Cause | Where to Look |
| ------- | ------------ | ------------- |
| `"invalid"` in tools | Including debug/placeholder values | Tool list initialization |
| Empty tools array | Not populating tools from agent | System init emission |

---

### TEST: Tool Result Content

**What we're testing:** Tool results contain actual content, not empty strings.

**Spec reference:** Section 3.5 (Tool Result Content Requirements)

**Priority:** P1 - Tools

**How to test:**

1. Run shim with prompt that triggers file read: "Create test.txt with 'hello', then read it back"
2. Find tool_result messages for Read operations
3. Verify content is not empty string

**Failure hints:**

| Symptom | Likely Cause | Where to Look |
| ------- | ------------ | ------------- |
| Empty tool_result content | Not capturing agent's tool output | Tool result emission code |
| All results empty | Wrong field name in agent response | Log raw agent events |

---

### TEST: Message Ordering Strict

**What we're testing:** tool_use always appears before its corresponding tool_result.

**Spec reference:** Section 3.5 (Message Ordering: Tool Use Before Tool Result)

**Priority:** P1 - Core

**How to test:**

1. Run shim with tool-using prompt
2. Walk through messages in order
3. Track tool_use IDs as they appear
4. When tool_result appears, verify its tool_use_id was already seen

**Failure hints:**

| Symptom | Likely Cause | Where to Look |
| ------- | ------------ | ------------- |
| tool_result before tool_use | Emitting results out of order | Message buffering/ordering logic |
| Batch of results then uses | Processing tool calls incorrectly | Event translation |

---

### TEST: No Shell Pollution

**What we're testing:** Tool results don't contain shell initialization errors.

**Spec reference:** Section 4.5 (Shell Environment Isolation)

**Priority:** P2 - Edge Cases

**How to test:**

1. Run shim with bash command: `echo clean_output_test`
2. Check tool_result content for patterns:
   - `shellenv.sh`
   - `.bashrc` / `.zshrc`
   - `Operation not permitted`
   - nvm/rbenv/pyenv errors

**Failure hints:**

| Symptom | Likely Cause | Where to Look |
| ------- | ------------ | ------------- |
| Shell init in output | Using login shells (`-l` flag) | Shell invocation code |
| Permission errors | macOS security restrictions | Shell environment setup |

---

### TEST: Tool Name Not Unknown

**What we're testing:** Tool calls have proper names, not "unknown".

**Spec reference:** Section 4.5 (Standard Tool Names)

**Priority:** P1 - Tools

**How to test:**

1. Run shim with prompt that uses tools
2. Parse tool_use messages
3. Verify no tool has `name: "unknown"` or empty name

**Failure hints:**

| Symptom | Likely Cause | Where to Look |
| ------- | ------------ | ------------- |
| `name: "unknown"` | Not extracting name from agent event | Tool name extraction |
| Empty name | Wrong field access | Log raw agent events |

---

## Agentic Tests (New)

These tests verify complex, multi-step agentic workflows that exercise advanced capabilities.

---

### TEST: Deep Research Workflow

**What we're testing:** Complex research task involving web search, progress tracking, and PDF generation.

**Priority:** P3 - Advanced

**How to test:**

1. Run shim with this prompt:

   ```
   Can you use web search and thoroughly do deep research on the current state of the art knowledge when it comes to the benefits of interval training on runs? What happens in the body, what it does over a longer period, good intervals to run? Prioritize primary sources and scientific papers. Download primary sources if you need to. Maintain a progress_track.md with questions, answers, links, citations, etc. Keep adding to it as you go, and at the end create a comprehensive, well formatted pdf covering everything.
   ```

2. After run completes, verify:
   - `progress_track.md` was created
   - File contains substantial research content (>100 chars)
   - Content relates to interval training/research
   - Write/edit tools were used
   - PDF creation is optional (not all agents support it)

**What this tests:**
- Web search capability (if available)
- Incremental file updates (progress tracking)
- Multi-step research workflow
- PDF generation (optional)
- File download capabilities (optional)

**Failure hints:**

| Symptom | Likely Cause | Where to Look |
| ------- | ------------ | ------------- |
| No progress_track.md | Agent not writing files | Tool result content |
| Empty file | Tool write not working | Write tool implementation |
| No search tools used | Agent lacks web search | Agent capabilities |

---

### TEST: Multi-File Project Creation

**What we're testing:** Creating a structured TypeScript project with interdependent files.

**Priority:** P2 - Advanced

**How to test:**

1. Run shim with prompt asking to create:
   - `package.json`
   - `src/index.ts` that imports from utils
   - `src/utils/helpers.ts` with exports
   - `README.md`
   - `tsconfig.json`

2. Verify:
   - All files exist
   - `package.json` is valid JSON
   - `src/index.ts` has imports
   - `src/utils/helpers.ts` has exports

---

### TEST: Iterative File Refinement

**What we're testing:** Creating a file and iteratively improving it within one conversation.

**Priority:** P2 - Advanced

**How to test:**

1. Ask agent to:
   - Create `story.txt` with initial content
   - Read it back
   - Edit to add more content
   - Read again to verify
   - Add a title
   - Show final content

2. Verify:
   - `story.txt` exists with substantial content
   - Multiple write/edit/replace operations occurred

---

## Implementation Guide

### File Structure

```
shim-eval-suite/
├── src/
│   ├── cli.ts              # Entry point
│   ├── runner.ts           # Test orchestration
│   ├── shim.ts             # Spawn and interact with shim
│   ├── workspace.ts        # Test directory management
│   ├── logger.ts           # Log management
│   ├── reporter.ts         # Generate reports
│   │
│   ├── tests/              # Actual test implementations
│   │   ├── core.ts         # Simple response, ordering, formats
│   │   ├── tools.ts        # Tool workflow, bash, file ops
│   │   ├── signals.ts      # SIGINT, SIGTERM
│   │   ├── sessions.ts     # Resume, continuation
│   │   ├── errors.ts       # Empty prompt handling
│   │   └── stress.ts       # Large files, unicode
│   │
│   └── utils/
│       ├── assertions.ts   # Test assertions with good errors
│       ├── parsing.ts      # Parse JSONL, extract messages
│       └── validation.ts   # ID format validation, etc.
│
├── runs/                   # Test output (gitignored)
│
└── package.json
```

### Core Utilities

**Running the shim:**

```typescript
interface RunOptions {
  prompt: string;
  model?: string;
  args?: string[];
  timeout?: number;
  signal?: { type: "SIGINT" | "SIGTERM"; afterMs: number };
  fixtures?: Record<string, string>; // files to create before run
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  messages: Message[];
  parseErrors: string[];
  duration: number;
  workspace: string; // path to test directory
}

async function runShim(options: RunOptions): Promise<RunResult>;
```

**Assertions with context:**

```typescript
function assert(condition: boolean, message: string, context?: object): void {
  if (!condition) {
    throw new AssertionError(message, context);
  }
}

// Usage
assert(result.exitCode === 0, "Expected exit code 0", {
  actual: result.exitCode,
  stdout: result.stdout.slice(0, 500),
});
```

**File verification:**

```typescript
async function assertFileExists(workspace: string, path: string): Promise<void>;
async function assertFileContains(
  workspace: string,
  path: string,
  content: string
): Promise<void>;
async function assertFileMatches(
  workspace: string,
  path: string,
  pattern: RegExp
): Promise<void>;
```

### Test Implementation Pattern

Each test is a function that:

1. Sets up fixtures if needed
2. Runs the shim
3. Makes assertions
4. Returns a result object

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

async function testSimpleResponse(config: ShimConfig): Promise<TestResult> {
  const testName = "simple-response";
  const startTime = Date.now();

  try {
    const result = await runShim({
      prompt: "Say hello",
      model: config.model,
      timeout: 30000,
    });

    // Assertions
    assert(result.exitCode === 0, "Expected exit code 0");
    assert(result.messages.length >= 3, "Expected at least 3 messages");
    assert(result.messages[0].type === "system", "First message must be system");
    // ... more assertions

    return {
      name: testName,
      passed: true,
      duration: Date.now() - startTime,
      logs: { stdout: result.stdout, stderr: result.stderr, workspace: result.workspace },
    };

  } catch (error) {
    return {
      name: testName,
      passed: false,
      duration: Date.now() - startTime,
      error: {
        message: error.message,
        expected: error.expected,
        actual: error.actual,
        context: error.context,
      },
      logs: { ... },
    };
  }
}
```

### Report Generation

The report should be readable by both humans and AI agents trying to fix issues.

````markdown
# Evaluation Report

**Shim:** gemini-cli-shim
**Model:** gemini-2.5-pro
**Date:** 2024-12-17T17:30:00Z
**Duration:** 2m 34s

## Summary

✅ 12 passed
❌ 2 failed
⏭️ 1 skipped

## Failed Tests

### ❌ test-tool-workflow

**Duration:** 8.3s

**What went wrong:**
Tool use message has `name: "unknown"` instead of actual tool name.

**Expected:** tool_use.name to be "Write" or "Read"
**Actual:** tool_use.name is "unknown"

**Log files:**

- `runs/2024-12-17T17-30-00/tests/tool-workflow/output.jsonl`
- `runs/2024-12-17T17-30-00/tests/tool-workflow/stderr.txt`

**Relevant output (line 3 of output.jsonl):**

```json
{
  "type": "assistant",
  "message": {
    "content": [
      { "type": "tool_use", "id": "toolu_xyz", "name": "unknown", "input": {} }
    ]
  }
}
```
````

**Where to look:**
This usually means the tool name isn't being extracted from the SDK event.
Check `src/agent/events.ts` where tool_use messages are created.
Log the raw SDK event to see what field contains the tool name.

---

## Passed Tests

<details>
<summary>12 tests passed</summary>

| Test               | Duration |
| ------------------ | -------- |
| simple-response    | 4.2s     |
| multi-turn-context | 6.1s     |
| ...                | ...      |

</details>
```

### CLI Interface

```bash
# Run all tests
shim-eval --shim gemini-cli-shim --model gemini-2.5-pro

# Run specific test
shim-eval --shim codex-shim --test tool-workflow

# Run category
shim-eval --shim opencode-shim --category core

# Keep test directories for debugging
shim-eval --shim gemini-cli-shim --preserve

# Output report to file
shim-eval --shim gemini-cli-shim -o report.md
```

---

## Exit Codes

| Code | Meaning                                    |
| ---- | ------------------------------------------ |
| 0    | All tests passed                           |
| 1    | One or more tests failed                   |
| 2    | Configuration error (shim not found, etc.) |

---

## Testing the Eval Suite During Development

While building this eval suite, you can test against `claude` (the Claude Code CLI) which is installed and available on the system. This provides a known-working reference to verify your tests behave correctly.

**Run claude with these parameters:**

```bash
echo "Your prompt here" | claude \
  --dangerously-skip-permissions \
  --model sonnet \
  --permission-mode bypassPermissions \
  -p \
  --output-format stream-json \
  --verbose
```

**Parameters explained:**

- `--dangerously-skip-permissions` - Auto-approves all permissions (required for headless operation)
- `--model sonnet` - Uses Claude Sonnet model
- `--permission-mode bypassPermissions` - Bypasses permission checks
- `-p` - Indicates prompt via stdin (optional but explicit)
- `--output-format stream-json` - Outputs JSONL format (same as shims)
- `--verbose` - Required for stream-json with -p

**Note:** The evaluation suite automatically passes `--debug-dir <workspace>/.shim-debug` to all shim invocations. This ensures shims don't create debug folders in unexpected locations. Compliant shims should only write debug logs and session data when this parameter is provided.

**Example test during development:**

```typescript
// Test your eval harness against claude first
const result = await runCommand("claude", {
  args: [
    "--dangerously-skip-permissions",
    "--model",
    "sonnet",
    "--permission-mode",
    "bypassPermissions",
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
  ],
  stdin: "Say hello",
});

// Verify your parsing works
assert(result.messages[0].type === "system");
assert(result.messages[result.messages.length - 1].type === "result");
```

**Why this helps:**

1. Verify your JSONL parsing is correct
2. Confirm your assertions match real output format
3. Test file verification logic with a working implementation
4. Debug test failures (is it your test or the shim?)

Once tests pass against `claude`, you can confidently test shims knowing any failures are shim bugs, not eval bugs.

---

## Implementation Order

### Phase 1: Infrastructure

- [ ] CLI argument parsing
- [ ] Shim process spawning with stdin/stdout capture
- [ ] Workspace (temp directory) management
- [ ] Basic JSONL parsing
- [ ] Log file writing

### Phase 2: Core Tests

- [ ] simple-response
- [ ] message-ordering
- [ ] id-formats
- [ ] empty-prompt

### Phase 3: Tool Tests

- [ ] tool-workflow (combined write/read test)
- [ ] bash-command
- [ ] complex-workflow

### Phase 4: Signal & Session Tests

- [ ] sigint-handling
- [ ] sigterm-handling
- [ ] session-resume-invalid
- [ ] session-resume-valid

### Phase 5: Edge Cases & Reporting

- [ ] premature-completion
- [ ] permission-handling
- [ ] Markdown report generation
- [ ] Full failure context in reports
