## Instructions for Implementers

### What You're Building

You are implementing a **shim**—a command-line executable that translates between a standardized interface and a specific coding agent. The shim receives prompts via stdin, communicates with the agent, and emits a structured JSONL event stream to stdout.

**Reference Implementation:** The Claude Code CLI (`claude`) serves as the reference implementation. When in doubt, match Claude Code's behavior.

### What You'll Be Provided

Along with this specification, you will receive:

1. **Agent Documentation** — Details about the specific coding agent you're wrapping (API docs, SDK reference, event formats, authentication)

2. **Shim Identity** — The name for your shim (e.g., `gemini-cli-shim`, `opencode-shim`), which determines:

   - Package name and binary name
   - Session storage directory (`.{shim-name}/`)
   - Environment variable prefix

3. **Working Context** — The directory where you'll create the shim, any existing code to reference, and specific requirements

### How to Use This Spec

**Read in this order:**

1. **Section 1 (Overview)** — Understand what a shim does and why
2. **Section 2 (Input Contract)** — What your shim receives
3. **Section 3 (Output Contract)** — What your shim produces
4. **Section 4 (Behavioral Contract)** — How your shim behaves
5. **Section 5 (Implementation Guide)** — How to build it
6. **Appendices** — Reference material (types, ID formats, ACP)

**Then implement in phases** as described in Section 5, testing each phase before moving on.

### Testing Your Implementation

A unified test suite exists at `eval-suite/` that validates shim compliance. To test your shim:

```bash
cd eval-suite
bun install

# Run all tests against your shim
bun run src/cli.ts --shim "bun /path/to/your-shim/index.js" --model your-model

# Run specific category
bun run src/cli.ts --shim /path/to/your-shim --category tools

# List available tests
bun run src/cli.ts --list
```

**Your shim is not complete until:**

- All tests pass
- You've tested with the real agent (not mocks)
- Tool operations complete without hanging

The test suite covers:

- Output format (JSONL, message structure, field presence)
- Message ordering (system first, result last)
- ID format validation (UUID, msg\_\*, toolu\_\*)
- Tool use/result pairing
- Session continuation
- Permission handling (no hangs)

### Key Success Criteria

| Criterion             | How to Verify                                             |
| --------------------- | --------------------------------------------------------- |
| Correct output format | `echo "Hi" \| ./shim --model X \| jq .` parses every line |
| System init first     | First line has `type: "system"`                           |
| Result last           | Last line has `type: "result"`                            |
| No hangs              | Tool operations complete within timeout                   |
| Real agent works      | E2E tests pass with actual API calls                      |

### Common Pitfalls (Read These Now)

Before you start, be aware of these frequent mistakes:

1. **Testing with mocks** — Mocks pass while real integration is broken. Always test with the real agent.

2. **Wrong protocol field names** — If your agent uses ACP, it expects `content` not `text`. Verify against the official protocol spec.

3. **Premature completion** — Agents emit "idle" on connect. Don't treat this as completion until work has started.

4. **Stdout not flushed** — Call flush before exit or lose the final message.

5. **Permission blocking** — No user to approve permissions. Auto-approve or hang forever.

6. **Empty tool inputs** — Agents often emit `pending` status with empty `input: {}` before the actual input is populated. Wait for `running` or `completed` status before emitting `tool_use`.

7. **Missing tool results** — Every `tool_use` must have a corresponding `tool_result`. Emit results when the agent reports `completed` or `error` status.

8. **Port conflicts** — If your shim uses a local server (e.g., SDK that spawns localhost server), **NEVER** use deterministic ports. Use dynamic port allocation (`findFreePort()`) to support parallel execution. See Section 1.4.

## 1. Overview

### 1.1 What is a Shim?

A **shim** is an executable process that acts as a translation layer between an **orchestrator** (a system managing coding workflows) and a **coding agent** (an AI that can read files, write code, execute commands).

```
┌──────────────────────────────────────────────────────────────────┐
│                     ORCHESTRATOR                                  │
│  Spawns shim → writes stdin → reads stdout → handles exit code   │
└──────────────────────────────────────────────────────────────────┘
                              │
                              │  Standard Interface (this spec)
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                         SHIM PROCESS                              │
│  Translates standard interface ↔ agent-specific interface         │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                       CODING AGENT                                │
└──────────────────────────────────────────────────────────────────┘
```

### 1.2 Shim Responsibilities

| Responsibility       | Description                                              |
| -------------------- | -------------------------------------------------------- |
| Input Translation    | Parse CLI arguments and stdin into agent-specific format |
| Lifecycle Management | Start, monitor, and stop the underlying agent            |
| Event Translation    | Convert agent events to standardized JSONL output        |
| Session Management   | Handle session creation, continuation, and persistence   |
| Error Handling       | Catch errors and emit synthetic error messages           |
| Signal Handling      | Respond gracefully to SIGINT/SIGTERM                     |

### 1.3 Data Flow

```
1. Orchestrator spawns shim with CLI arguments
2. Orchestrator writes prompt to stdin, then closes stdin
3. Shim emits SYSTEM INIT message (MUST be first)
4. Shim sends prompt to agent, translates events to stdout
5. Shim emits RESULT message (MUST be last)
6. Shim exits with appropriate exit code (0=success, 1=error)
```

### 1.4 Execution Isolation & Parallel Execution

Multiple shim instances **MUST** be able to run concurrently without conflicts. This is a hard requirement for orchestrators that run tests or tasks in parallel.

**Port Allocation Rules (for server-based agents):**

| Rule                 | Requirement                                                |
| -------------------- | ---------------------------------------------------------- |
| Port assignment      | **MUST** be dynamic/random, NOT deterministic              |
| Concurrent instances | **MUST** support multiple instances running simultaneously |
| Port conflicts       | **MUST** handle gracefully (retry with different port)     |
| Cleanup              | **MUST** release ports on shutdown                         |

**Implementation:**

```typescript
// ❌ WRONG: Deterministic port causes conflicts
const port = hashFromCwd(config.cwd); // Same cwd = same port = EADDRINUSE

// ✅ CORRECT: Dynamic port allocation
const port = await findFreePort(); // Each instance gets unique port
```

**Why not deterministic ports?**

- Two tests in same workspace = same port = conflict
- Parallel test runners spawn multiple shim instances simultaneously
- Orchestrators may run multiple agents concurrently

> **Spec Requirement:** Shims that use local servers **MUST** dynamically allocate ports to support parallel execution. Shims that cannot run in parallel due to external constraints (e.g., singleton SDK instances) **MUST** document this limitation prominently.

## 1.5 Design Philosophy & Intent

### Why This Spec Exists

The spec optimizes for **predictability over flexibility**. An orchestrator spawning shims needs to know exactly what to expect—same inputs produce same output structure, every time, regardless of which agent is underneath.

**Key design decisions:**

| Decision               | Rationale                                                                     |
| ---------------------- | ----------------------------------------------------------------------------- |
| JSONL not JSON         | Stream processing; orchestrator can act on messages as they arrive            |
| UUID for sessions      | Universal format; agents use various internal formats (ULIDs, sequential IDs) |
| snake_case tool inputs | Downstream systems expect it; agents often use camelCase                      |
| Flush before exit      | Piped stdout is buffered; final message can be lost without explicit flush    |
| Permission bypass      | No user present to approve; blocking = infinite hang                          |

### Spirit of the Spec

When the spec is ambiguous, follow these principles:

1. **Match Claude Code behavior.** When in doubt, do what `claude` does.
2. **Fail loudly, not silently.** Emit synthetic errors rather than swallowing exceptions.
3. **Preserve information.** Pass through unknown fields rather than dropping them.
4. **Be defensive.** Check for null/undefined; agents have quirks.
5. **Orchestrator is in control.** The shim doesn't make policy decisions—it translates.

---

## 1.6 For AI Implementers

### Before Writing Any Code

1. **Read this entire spec first.** Understand the contracts before implementing.

2. **Study your target agent's documentation:**

   - Official API/SDK docs
   - Event types and formats
   - Session management model
   - Permission system

3. **Research external protocols.** If your agent uses ACP, MCP, or similar:

   - Find the official spec (e.g., agentclientprotocol.com)
   - Verify exact field names (`content` vs `text`)
   - Search GitHub for known issues

4. **Create working documents:**
   ```
   NOTES.md      # Discoveries about agent behavior
   DECISIONS.md  # Why you made non-obvious choices
   ISSUES.md     # Known limitations/workarounds
   ```

### Implementation Order (Detailed)

```
□ Set up project (package.json, tsconfig, tsup)
□ Argument parser with all flags
□ Stdin reader (read until EOF, trim)
□ JSONL emitter (console.log + JSON.stringify)
□ ID generators (UUID, msg_*, toolu_*)
□ Model resolver (shortnames → full specs)
✓ TEST: Parse args, read stdin, emit valid JSON
```

```
□ Agent detection (verify binary/SDK exists)
□ Agent connection (server startup if needed)
□ Session creation (fresh)
□ Session resumption (--resume)
□ Session persistence
□ Prompt sending
✓ TEST: Create session, send prompt, get any response
```

```
□ System init emission
□ Text handling with deduplication
□ Tool call emission with deduplication
□ Tool result emission
□ Usage/token tracking
□ Completion detection (timers + work-started latch)
□ Result emission
✓ TEST: Full conversation with tools works
```

```
□ Signal handlers (SIGINT/SIGTERM → clean exit)
□ Error handling (synthetic errors)
□ Permission auto-approval
□ Stdout flush before exit
□ Verbose logging (to stderr only)
□ --self-test implementation
✓ TEST: All E2E tests pass with real agent
```

### Critical Mistakes to Avoid

**❌ Testing with mocks instead of the real agent**

```typescript
// This proves nothing:
const mockAgent = { send: () => ({ text: "Hello" }) };
expect(shimWithMock(mockAgent)).toBeDefined(); // Passes but shim is broken

// This proves it works:
const result = await runRealShim("Say hello", { model: "gemini-2.5-flash" });
expect(result.messages).toContainEqual(
  expect.objectContaining({ type: "assistant" })
);
```

**❌ Assuming field names without checking the protocol spec**

```typescript
// Caused hours of debugging [object Object] errors:
return { result: { text: content } }; // ❌ WRONG for ACP
return { result: { content: content } }; // ✅ RIGHT for ACP
```

**❌ Treating initial idle as completion**

```typescript
// Agent emits idle immediately on connect—this completes with 0 tokens:
if (event.status === "idle") complete(); // ❌ WRONG

// Wait for work to start first:
if (event.status === "idle" && workStarted) complete(); // ✅ RIGHT
```

**❌ Forgetting to flush stdout**

```typescript
emit(resultMessage);
process.exit(0); // ❌ May lose final message

emit(resultMessage);
await new Promise(
  (r) => process.stdout.write("", r) || process.stdout.once("drain", r)
);
process.exit(0); // ✅ Waits for flush
```

### When You Get Stuck

**"Agent events aren't what I expected"**
→ Log everything: `console.error(JSON.stringify(event, null, 2))`
→ Read agent source code if available
→ Test with simple prompts and observe

**"Completion detection isn't working"**
→ Log state transitions
→ Check work-started latch
→ Verify timers reset on activity

**"Tests pass but real usage fails"**
→ You're probably using mocks
→ Run E2E tests with real API calls
→ Test the exact invocation the orchestrator uses

**"I don't understand why X is required"**
→ Check the rationale in "Design Philosophy"
→ The requirement exists because someone hit a real bug without it

### How to Know You're Done

**Checklist:**

```
□ All arguments parse correctly (including edge cases)
□ --self-test works and reports agent status
□ Simple prompt → text response works
□ Tool use → tool result pairing works
□ Session continuation (--resume) works
□ Invalid inputs produce helpful errors (not crashes)
□ E2E tests pass with REAL agent (not mocks)
□ Can run via npx/bunx without installation
□ README explains usage
□ ALL eval-suite tests pass (see below)
```

**The shim is NOT done until:**

1. You've run it against the real agent with real API calls
2. You've tested error paths (invalid model, bad session ID)
3. Someone else can use it without asking you questions
4. **ALL tests in the eval-suite pass**

### Run the Eval Suite Often!

**CRITICAL:** Run the eval-suite frequently during development, not just at the end:

```bash
# Run validation tests after every significant change
cd eval-suite && bun dist/cli.js --shim /path/to/your-shim --model your-model --category validation

# Run all tests before considering the shim complete
cd eval-suite && bun dist/cli.js --shim /path/to/your-shim --model your-model

# Tests run in parallel by default (5 at a time) for faster feedback
# Use --parallel 1 if you encounter rate limiting or server conflicts
```

**When to run tests:**

| Development Phase                | Tests to Run                                       |
| -------------------------------- | -------------------------------------------------- |
| After basic JSONL output works   | `--test valid-jsonl --test message-ordering`       |
| After tool handling added        | `--category validation`                            |
| After completion detection tuned | `--test premature-completion --test tool-workflow` |
| Before considering shim "done"   | All tests (no category flag)                       |
| After any bug fix                | Full test run to catch regressions                 |

**Interpreting test failures:**

- If validation tests fail → your shim has spec compliance bugs
- If tool tests fail but validation passes → completion detection or agent integration issues
- If agentic tests fail but others pass → likely model/agent behavior, not shim bugs

**Don't skip tests!** A shim that "seems to work" but fails tests will break orchestrators that depend on spec compliance.

### Asking for Help

If you need to ask another AI or human for help, provide:

```
1. What you're trying to do
2. What you expected
3. What actually happened
4. Relevant code (minimal reproduction)
5. Full error message or output
6. What you've already tried
```

Example:

```
I'm implementing a shim for Gemini. When I send a prompt, I get
system init but then silence.

Expected: Text streaming events, then result
Actual: Only system init, nothing else

Code: await client.chat(sessionId, { content: prompt });

No errors in stderr. I've verified the session exists and the
prompt is non-empty. Waited 60 seconds.
```

---

## 2. Input Contract

### 2.1 Command-Line Arguments

#### Required Arguments

| Argument          | Description                                                             |
| ----------------- | ----------------------------------------------------------------------- |
| `--model <model>` | **REQUIRED.** Model identifier (shortname, provider/model, or full ID). |

#### Optional Arguments

| Argument                        | Default | Description                                                                             |
| ------------------------------- | ------- | --------------------------------------------------------------------------------------- |
| `-p`                            | false   | Indicates prompt via stdin (optional, stdin always read).                               |
| `--resume <session_id>`         | None    | Session ID to continue.                                                                 |
| `--verbose`                     | false   | Enable verbose logging to stderr.                                                       |
| `--append-system-prompt <text>` | None    | Additional system prompt to append.                                                     |
| `--debug-dir <path>`            | None    | Directory for debug logs and session data. If not provided, no debug files are written. |
| `--self-test`                   | false   | Run environment verification (skip normal operation).                                   |
| `--version`                     | false   | Print version and exit.                                                                 |
| `--help`                        | false   | Print help and exit.                                                                    |

#### Argument Rules

- Ignore unknown arguments (forward compatibility)
- Support both `--arg value` and `--arg=value` forms
- Last value wins for repeated arguments
- `-p` flag is optional—always read stdin regardless

### 2.2 Model Resolution

**Accepted formats:**

| Format         | Example                    | Resolution                                   |
| -------------- | -------------------------- | -------------------------------------------- |
| Shortname      | `sonnet`                   | Maps to `anthropic/claude-sonnet-4-20250514` |
| Provider/model | `google/gemini-2.5-flash`  | Used as-is                                   |
| Full ID        | `claude-sonnet-4-20250514` | Assumes default provider                     |

**Precedence (highest to lowest):**

1. CLI specific model (e.g., `anthropic/claude-sonnet-4-20250514`)
2. Environment variable `MODEL`
3. CLI generic default (e.g., `sonnet`)
4. Hardcoded default

**Do NOT validate model names strictly.** New models appear frequently; let the API error if invalid.

### 2.3 Environment Variables

Each shim defines its own prefix (e.g., `MYSHIM_`) for configuration variables. API keys (`ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, etc.) are passed through to the agent.

### 2.4 Standard Input

Read stdin until EOF, trim whitespace. If empty after trimming, exit silently with code 0 (no output). This allows piping empty input without error.

### 2.5 Error Handling

#### Startup/Configuration Errors (exit 1, stderr only)

For errors that occur before the shim can meaningfully start:

| Condition          | Behavior                      |
| ------------------ | ----------------------------- |
| Invalid session ID | Print error to stderr, exit 1 |
| Missing API key    | Print error to stderr, exit 1 |
| Agent not found    | Print error to stderr, exit 1 |

#### Runtime Errors (exit 1, WITH JSONL)

For errors after successful initialization, emit: system init → synthetic error → result with `is_error: true`.

| Condition                 | Synthetic Error Prefix |
| ------------------------- | ---------------------- |
| API authentication failed | `API Error: ...`       |
| Rate limit, timeout, etc. | `API Error: ...`       |
| Agent crash               | `Agent Error: ...`     |

### 2.6 Self-Test Mode

When `--self-test` is passed, verify environment and output JSON (not JSONL):

```json
{
  "shim": { "name": "myshim", "version": "1.0.0" },
  "agent": { "name": "agent", "version": "X.Y.Z", "found": true },
  "checks": [
    { "name": "agent_found", "passed": true, "message": "..." },
    { "name": "api_key", "passed": true, "message": "..." }
  ],
  "overall": { "passed": true, "message": "All checks passed" }
}
```

Exit 0 if all pass, 1 if any fail.

---

## 3. Output Contract

### 3.1 Format: JSONL

- Each line is a complete, valid JSON object
- Lines terminated by single `\n`
- UTF-8 encoded
- Diagnostic output goes to stderr, never stdout
- **Flush stdout before exit** (critical!)

### 3.2 Message Types

| Type        | Cardinality      | Purpose                                   |
| ----------- | ---------------- | ----------------------------------------- |
| `system`    | Exactly 1, first | Session initialization                    |
| `assistant` | 0 or more        | AI responses (text, thinking, tool calls) |
| `user`      | 0 or more        | Tool results                              |
| `result`    | Exactly 1, last  | Final outcome                             |

### 3.3 System Init Message

**MUST be first message.** Schema:

```typescript
{
  type: "system",
  subtype: "init",
  cwd: string,                    // Working directory (absolute path)
  session_id: string,             // UUID v4 format
  tools: string[],                // ["Read", "Write", "Edit", "Bash", ...]
  model: string,                  // Resolved model identifier
  permissionMode: "bypassPermissions" | "requestPermissions",
  apiKeySource: "ANTHROPIC_API_KEY" | "env" | "none",
  mcp_servers?: unknown[]         // Optional, default []
}
```

#### Tools Array Validation

The `tools` array **MUST** only contain valid, known tool names. Do not include:

- Placeholder values like `"invalid"` or `"unknown"`
- Empty strings
- Internal/debug tool names not intended for external use

```typescript
// ✅ CORRECT
tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "LS"];

// ❌ WRONG - contains invalid entries
tools: ["invalid", "Bash", "Read", "unknown"];
```

### 3.4 Assistant Message

```typescript
{
  type: "assistant",
  message: {
    id: string,                   // msg_* or UUID format
    type: "message",
    role: "assistant",
    model: string,
    content: ContentBlock[] | string,
    usage?: { input_tokens, output_tokens, cache_creation_input_tokens?, cache_read_input_tokens? },
    stop_reason?: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null
  }
}
```

**Content block types:**

```typescript
// Text
{ type: "text", text: string }

// Thinking
{ type: "thinking", thinking: string }

// Tool use
{ type: "tool_use", id: string, name: string, input?: Record<string, unknown> }
```

**Synthetic error messages** use `model: "<synthetic>"` and content prefixed with `API Error:` or `Agent Error:`.

### 3.5 User Message (Tool Results)

```typescript
{
  type: "user",
  message: {
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: string,        // Must match tool_use id
      content: string | { is_error: true, error: string }
    }]
  }
}
```

#### Tool Result Content Requirements

Tool results **MUST** contain meaningful content:

| Operation Type | Required Content                         |
| -------------- | ---------------------------------------- |
| Read file      | File contents (or error message)         |
| Write file     | Confirmation or file path                |
| Bash command   | Command stdout/stderr output             |
| List directory | Directory listing                        |
| Error          | Error message describing what went wrong |

**Empty tool results are a bug.** If the agent returned data, the shim must capture and emit it.

```typescript
// ❌ WRONG - empty result hides what happened
{ "type": "tool_result", "tool_use_id": "toolu_xyz", "content": "" }

// ✅ CORRECT - captures actual output
{ "type": "tool_result", "tool_use_id": "toolu_xyz", "content": "File written: data.txt" }
{ "type": "tool_result", "tool_use_id": "toolu_abc", "content": "hello_from_bash\n" }
```

#### Message Ordering: Tool Use Before Tool Result

Tool results **MUST** appear after their corresponding tool_use in the message stream. The shim must emit:

1. `assistant` message containing `tool_use`
2. `user` message containing `tool_result` with matching `tool_use_id`

```jsonl
// ✅ CORRECT ORDER
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Read",...}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"file contents"}]}}

// ❌ WRONG - result before use
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"..."}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Read",...}]}}
```

### 3.6 Result Message

**MUST be last message.** Schema:

```typescript
{
  type: "result",
  subtype: "success" | "error",
  is_error: boolean,              // Must match subtype
  duration_ms: number,
  duration_api_ms: number,
  num_turns: number,
  result: string,                 // Human-readable summary
  session_id?: string,
  total_cost_usd?: number,
  usage?: { input_tokens?, output_tokens?, cache_creation_input_tokens?, cache_read_input_tokens? }
}
```

### 3.7 Exit Codes

| Code | Meaning | Result Message                 |
| ---- | ------- | ------------------------------ |
| 0    | Success | Emitted with `is_error: false` |
| 1    | Error   | Emitted with `is_error: true`  |

On SIGINT/SIGTERM, exit cleanly (code 0) after completing current operation if possible, or exit immediately.

### 3.8 Model Output Formatting

- **Anthropic models:** Output without prefix (`claude-sonnet-4-20250514`)
- **Other providers:** Output with prefix (`google/gemini-2.5-flash`)

---

## 4. Behavioral Contract

### 4.1 Lifecycle State Machine

```
STARTUP → INITIALIZING → PROCESSING → COMPLETE
    ↓          ↓              ↓
EARLY_ERROR  INIT_ERROR     ERROR
```

### 4.2 Completion Detection

Agents signal completion differently. Use these strategies in priority order:

1. **Explicit completion event** from agent (if available) → complete immediately
2. **Step finish with `reason: stop`** → start 5s completion timer
3. **Inactivity timeout** (~30s) → complete as fallback
4. **Work-started latch** → ignore initial "idle" status until work begins

**Work-started triggers:** text delta, tool call, step start, reasoning.

### 4.3 Signal Handling

On SIGINT or SIGTERM:

1. Set interrupted flag (prevent double-handling)
2. Attempt graceful shutdown of agent session
3. Exit cleanly (code 0 if possible, or current state's code)

Note: Unlike some specs that require exit code 130, shims should exit cleanly to match Claude Code behavior.

### 4.4 Text Stream Management

**Problem:** Agents often emit both streaming deltas AND aggregated text, causing duplication.

**Solution:** Track `hasReceivedDeltas` per turn:

- If delta event → set flag, emit delta
- If aggregated text AND flag is set → skip
- On step finish → reset flag

### 4.5 Tool System

#### Standard Tool Names

Normalize agent tool names to these standards:

| Standard | Common Aliases                     |
| -------- | ---------------------------------- |
| `Read`   | `read`, `file_read`, `readFile`    |
| `Write`  | `write`, `file_write`, `writeFile` |
| `Edit`   | `edit`, `str_replace_editor`       |
| `Bash`   | `bash`, `shell`, `execute_bash`    |
| `Glob`   | `glob`, `find_files`               |
| `Grep`   | `grep`, `search_files`             |
| `LS`     | `ls`, `list`, `list_directory`     |

Pass through unknown tool names unchanged.

#### Tool Input Keys

Convert from camelCase to snake_case (top-level only):

- `filePath` → `file_path`
- `maxResults` → `max_results`

#### Tool Input Standardization

Tool inputs **MUST** use standard parameter schemas, not raw agent-specific formats:

| Tool  | Standard Input                          | Not This                         |
| ----- | --------------------------------------- | -------------------------------- |
| Read  | `{ file_path: "path" }`                 | `{ command: "cat path" }`        |
| Write | `{ file_path: "path", content: "..." }` | `{ command: "echo ... > path" }` |
| Bash  | `{ command: "..." }`                    | Raw command string               |

If the underlying agent uses shell commands, translate them to standard tool inputs when possible. This enables orchestrators to understand what tools are doing without parsing shell syntax.

```typescript
// ❌ WRONG - agent-specific leakage
{ "type": "tool_use", "name": "Read", "input": { "command": "/bin/zsh -lc 'cat docs/README.md'" } }

// ✅ CORRECT - standard schema
{ "type": "tool_use", "name": "Read", "input": { "file_path": "docs/README.md" } }
```

#### Tool Lifecycle

| Agent Event                 | Shim Action                            |
| --------------------------- | -------------------------------------- |
| `pending` event             | **Skip** — input not yet populated     |
| First `running` event       | Generate `toolu_*` ID, emit `tool_use` |
| Subsequent `running` events | Skip (deduplicate)                     |
| `completed` or `error`      | Emit `tool_result`                     |

**Critical:** Many agents emit a `pending` status before `running`. The `pending` event typically has **empty input** (`{}`). Wait for `running` or `completed` status when input is populated before emitting `tool_use`.

Track emitted tool IDs in a map to prevent duplicates.

#### Shell Environment Isolation

Tool results **MUST NOT** contain shell initialization output or environment pollution. When executing commands:

```bash
# ❌ WRONG - shell init leaks into output
/opt/homebrew/.../shellenv.sh: line 18: /bin/ps: Operation not permitted
actual command output here

# ✅ CORRECT - only command output
actual command output here
```

**Solutions:**

1. Use non-interactive shells: `bash -c` instead of `bash -l` or `zsh -l`
2. Suppress shell init: `BASH_ENV= bash -c "command"`
3. Use `sh` for simple commands (no init scripts)
4. Filter shell init errors from output

### 4.6 Permission Handling

**CRITICAL:** The shim runs headlessly with no user to approve permissions.

1. **Launch agent with all permissions pre-granted** (agent-specific flag)
2. **Auto-approve any runtime permission requests** immediately
3. **Never block waiting for user input**
4. **Never emit permission events to orchestrator**

### 4.7 Session Management

#### Fresh Session

1. Generate new UUID v4
2. Create agent session
3. Persist session to storage
4. Emit system init with UUID

#### Session Continuation (`--resume <id>`)

1. Look up session from storage
2. If not found → print error to stderr, exit 1
3. Resume the existing session
4. Emit system init with the **same session ID** (reused)

**Note:** When resuming, use the same session ID that was passed in. The session is reused, not duplicated.

#### Session Storage

**Session persistence location depends on `--debug-dir`:**

| `--debug-dir` provided? | Session storage location                                                 |
| ----------------------- | ------------------------------------------------------------------------ |
| Yes                     | Store in `<debug-dir>/sessions/`                                         |
| No                      | Use agent's native session storage (if available) OR hold in memory only |

**CRITICAL:** Shims **MUST NOT** create their own session directories (like `.my-shim/sessions/`) in the working directory unless `--debug-dir` is explicitly provided. This prevents unexpected files from appearing in user projects.

If the underlying agent has its own session persistence (e.g., Gemini CLI's built-in session management), the shim may rely on that. For session continuation (`--resume`), either use the agent's native sessions or require `--debug-dir` for shim-managed persistence.

---

## 5. Implementation Guide

### 5.1 Project Structure

```
my-shim/
├── src/
│   ├── index.ts          # Entry point
│   ├── shim.ts           # Core logic
│   ├── agent/            # Agent-specific code
│   └── utils/            # ID generation, tool mapping, etc.
├── tests/
├── package.json
├── tsconfig.json
└── tsup.config.ts        # Bundle for npx/bunx execution
```

### 5.2 Package Configuration

```json
{
  "bin": { "my-shim": "./dist/index.js" },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "prepublishOnly": "bun run build && bun test"
  }
}
```

Add shebang in tsup config:

```typescript
banner: {
  js: "#!/usr/bin/env node";
}
```

### 5.3 Implementation Order

**Phase 1: Foundation**

- Argument parsing (including --self-test, --version, --help)
- Stdin reading
- JSONL output helper
- ID generation utilities

**Phase 2: Agent Integration**

- Agent detection (verify exists before connecting)
- Connection/server startup
- Session creation and resumption

**Phase 3: Event Translation**

- Text handling (with deduplication)
- Tool handling (with deduplication)
- Completion detection
- Error handling

**Phase 4: Polish**

- Signal handling
- Verbose logging
- Session persistence
- **Build test suite**

### 5.4 Critical Anti-Patterns

❌ **Never skip testing with the real agent.** Mocked tests prove nothing about real behavior.

❌ **Never use mock data in production code.** Generate real IDs, resolve real models.

❌ **Never assume protocol field names without checking.** ACP uses `content`, not `text`. Always verify against official specs.

❌ **Never skip error handling.** Wrap all agent calls in try/catch.

❌ **Never block on permissions.** Auto-approve immediately or hang forever.

❌ **Never treat initial idle as completion.** Wait for work-started latch.

❌ **Never create debug/log folders without `--debug-dir`.** Shims must not pollute the working directory with `.my-shim/`, `debug/`, or similar folders. Only write files when the orchestrator explicitly requests it via `--debug-dir`.

### 5.5 Common Bugs and Fixes

| Bug                               | Cause                                  | Fix                                        |
| --------------------------------- | -------------------------------------- | ------------------------------------------ |
| 0 tokens, immediate exit          | Premature idle detection               | Implement work-started latch               |
| Duplicated text                   | Processing deltas AND aggregated       | Track `hasReceivedDeltas`                  |
| Duplicate tool_use                | Multiple "running" events              | Track emitted tool IDs                     |
| Hangs forever                     | Permission blocking                    | Auto-approve with pre-granted mode         |
| `[object Object]` in errors       | Wrong field names or bad serialization | Use `err.message`, not `${err}`            |
| Session continuation fails        | Session not found                      | Check session storage path                 |
| Exit 0 but is_error: true         | Exit code logic wrong                  | Match exit code to is_error                |
| Empty tool_use input `{}`         | Emitting on `pending` before input set | Wait for `running` status                  |
| Empty tool_result content         | Not capturing agent's tool output      | Log raw events, find output field          |
| Missing tool_result messages      | Not emitting results when tool done    | Emit on `completed`/`error` status         |
| `"invalid"` in tools array        | Including debug/placeholder values     | Filter to standard tools only              |
| tool_result before tool_use       | Emitting results out of order          | Buffer results until use is emitted        |
| Shell init in tool output         | Using login shells (`-l` flag)         | Use `bash -c` or `sh -c` instead           |
| Tool name is `"unknown"`          | Not extracting name from agent event   | Log raw event, find name field             |
| Agent says "I will..." then stops | Premature completion detection         | Wait for actual completion signal          |
| Unexpected `.shim/` folders       | Creating debug dirs without permission | Only write files if `--debug-dir` provided |

### 5.6 Raw Agent Data Logging

**CRITICAL:** Shims **MUST NOT** create debug folders, log files, or session data files unless the `--debug-dir <path>` argument is explicitly provided. This prevents shims from polluting the working directory or creating files in unexpected locations.

**When `--debug-dir` IS provided:**

Save the original data from the underlying agent in its native format for debugging within the specified directory:

```
<debug-dir>/
├── session-abc123.json          # Session metadata
├── session-abc123.raw.jsonl     # Raw agent events (native format)
└── session-abc123.raw.log       # Raw stderr from agent process
```

**When `--debug-dir` is NOT provided:**

- No files should be written to disk for debugging purposes
- Session data should be held in memory only (or use agent's native session storage)
- Verbose output goes to stderr only

**Why this matters:**

1. **No surprise files** — Users control where debug data goes; no `.my-shim/` folders appearing unexpectedly
2. **Clean working directories** — Shims don't pollute project directories with internal state
3. **Orchestrator control** — The orchestrator decides if/where debugging data is stored
4. **Debugging when needed** — When troubleshooting, pass `--debug-dir /tmp/shim-debug` to capture everything

**Implementation:**

```typescript
// Only write debug files if --debug-dir is specified
if (args.debugDir) {
  const debugPath = path.join(args.debugDir, `${sessionId}.raw.jsonl`);
  fs.mkdirSync(args.debugDir, { recursive: true });

  // On every agent event
  fs.appendFileSync(debugPath, JSON.stringify(rawAgentEvent) + "\n");

  // On stderr from agent process
  agentProcess.stderr.on("data", (chunk) => {
    fs.appendFileSync(path.join(args.debugDir, `${sessionId}.raw.log`), chunk);
  });
}
// If no --debug-dir, verbose output goes to stderr only
```

### 5.7 Debugging Protocol

1. Enable verbose logging: `VERBOSE=true echo "Test" | ./shim --model sonnet 2>debug.log`
2. Validate each message: `echo "Test" | ./shim --model sonnet | jq .`
3. Check first/last messages are system/result
4. Verify tool_use/tool_result pairing
5. Check exit code matches is_error
6. **Compare raw agent logs to shim output** — Are events being dropped or mistranslated?

---

## 6. Testing Requirements

### 6.1 Test Priority

| Priority              | Tests                                                                              | Status        |
| --------------------- | ---------------------------------------------------------------------------------- | ------------- |
| **P0 (Must Pass)**    | Output format, message ordering, ID formats, permission handling, graceful failure | All required  |
| **P1 (Should Pass)**  | Tool execution, session continuation, error message quality                        | Most required |
| **P2 (Nice to Have)** | Performance benchmarks                                                             | Optional      |

### 6.2 Critical Tests

#### The "Silence" Test

Verify `result.usage.input_tokens > 0`. Catches premature idle.

#### The "Permission" Test (CRITICAL)

Verify tool operations complete within 30s, no hangs. Catches permission blocking.

#### The "Stutter" Test

Check for repeated phrases in output. Catches text duplication.

#### The "Tool Duplicate" Test

Verify unique tool_use IDs. Catches duplicate emissions.

#### Graceful Failure Tests

- Invalid model → helpful error
- Missing API key → helpful error
- Invalid session ID → helpful error (stderr)
- All errors exit 1

### 6.3 E2E Test Requirements

**Always test with the REAL agent.** Use cheap models for E2E tests:

- `google/gemini-2.5-flash`
- `anthropic/claude-3-haiku`
- `openai/gpt-3.5-turbo`

**Always use unique temp directories per test** to avoid session conflicts and port collisions.

### 6.4 Minimum Test Matrix

- [ ] Simple prompt completion
- [ ] Tool use (read, write)
- [ ] Invalid session ID (exit 1, stderr error)
- [ ] Session continuation (--resume)
- [ ] Multiple models

---

## Appendix A: Type Definitions

### Complete TypeScript Types

```typescript
// ============================================
// INPUT TYPES
// ============================================

interface ShimArguments {
  model: string;
  resume?: string;
  verbose: boolean;
  appendSystemPrompt?: string;
  debugDir?: string; // Directory for debug logs/session data; if not provided, no files written
  selfTest: boolean;
}

interface ModelSpec {
  providerID: string;
  modelID: string;
}

// ============================================
// OUTPUT MESSAGE TYPES
// ============================================

interface SystemMessage {
  type: "system";
  subtype: "init";
  cwd: string;
  session_id: string;
  tools: string[];
  model: string;
  permissionMode: "bypassPermissions" | "requestPermissions";
  apiKeySource: "ANTHROPIC_API_KEY" | "env" | "none";
  mcp_servers?: unknown[];
}

interface AssistantMessage {
  type: "assistant";
  message: {
    id: string;
    type: "message";
    role: "assistant";
    model: string;
    content: ContentBlock[] | string;
    usage?: TokenUsage;
    stop_reason?:
      | "end_turn"
      | "max_tokens"
      | "stop_sequence"
      | "tool_use"
      | null;
  };
}

interface UserMessage {
  type: "user";
  message: {
    role: "user";
    content: ToolResultContent[];
  };
}

interface ResultMessage {
  type: "result";
  subtype: "success" | "error";
  is_error: boolean;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  result: string;
  session_id?: string;
  total_cost_usd?: number;
  usage?: TokenUsage;
}

// ============================================
// CONTENT TYPES
// ============================================

type ContentBlock = TextContent | ThinkingContent | ToolUseContent;

interface TextContent {
  type: "text";
  text: string;
}

interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

interface ToolUseContent {
  type: "tool_use";
  id: string; // toolu_* format
  name: string; // Normalized: Read, Write, etc.
  input?: Record<string, unknown>;
}

interface ToolResultContent {
  type: "tool_result";
  tool_use_id: string; // Must match tool_use id
  content: string | { is_error: true; error: string };
}

interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

type ShimOutputMessage =
  | SystemMessage
  | AssistantMessage
  | UserMessage
  | ResultMessage;
```

### Helper Functions

```typescript
function generateSessionUUID(): string {
  const hex = () => Math.floor(Math.random() * 16).toString(16);
  const section = (n: number) =>
    Array(n)
      .fill(0)
      .map(() => hex())
      .join("");
  return `${section(8)}-${section(4)}-4${section(3)}-${
    ["8", "9", "a", "b"][Math.floor(Math.random() * 4)]
  }${section(3)}-${section(12)}`;
}

function generateMessageId(): string {
  return `msg_${Date.now().toString(36)}${Math.random()
    .toString(36)
    .substring(2, 10)}`;
}

function generateToolUseId(): string {
  return `toolu_${Date.now().toString(36)}${Math.random()
    .toString(36)
    .substring(2, 12)}`;
}

function emit(message: ShimOutputMessage): void {
  console.log(JSON.stringify(message));
}

function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
```

---

## Appendix B: ID Format Reference

### Session ID (UUID v4)

```
Format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
        (version 4 ^)  (variant ^ = 8,9,a,b)

Valid:   550e8400-e29b-41d4-a716-446655440000
Invalid: 550e8400-e29b-51d4-a716-446655440000  (version 5)
Invalid: 550e8400-e29b-41d4-c716-446655440000  (wrong variant)

Validation: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
```

### Message ID

```
Format: msg_[alphanumeric]+
        OR UUID (alternative)

Valid:   msg_01a2b3c4d5e6f7
Valid:   550e8400-e29b-41d4-a716-446655440000

Validation: /^(msg_[a-zA-Z0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
```

### Tool Use ID

```
Format: toolu_[alphanumeric]+
        OR call_[hex]+ (alternative)

Valid:   toolu_01a2b3c4d5e6f7g8h9
Valid:   call_abc123def456

Validation: /^(toolu_[a-zA-Z0-9]+|call_[a-fA-F0-9]+)$/
```

### Synthetic Error ID

Use nil UUID for synthetic error messages:

```
00000000-0000-0000-0000-000000000000
```

---

## Appendix C: ACP Filesystem RPC

Some agents (notably those using Agent Client Protocol) expect the shim to handle filesystem operations via RPC.

### When This Applies

If your agent sends `fs/read_text_file` or `fs/write_text_file` JSON-RPC requests, implement these handlers.

### Required Methods

#### fs/read_text_file

**Request:**

```json
{
  "method": "fs/read_text_file",
  "params": { "path": "...", "sessionId": "..." }
}
```

**Response (ACP-compliant):**

```json
{ "result": { "content": "file contents" } }
```

**ENOENT handling:** For Gemini CLI compatibility, return empty content instead of error:

```json
{ "result": { "content": "" } }
```

#### fs/write_text_file

**Request:**

```json
{
  "method": "fs/write_text_file",
  "params": { "path": "...", "content": "...", "sessionId": "..." }
}
```

**Response:**

```json
{ "result": {} }
```

### Critical: Field Names

**ACP uses `content`, NOT `text`.** Using `text` causes `[object Object]` bugs.

```typescript
// ❌ WRONG
this.sendResponse(id, { text: fileContent });

// ✅ CORRECT
this.sendResponse(id, { content: fileContent });
```

### Error Serialization

```typescript
// ❌ WRONG - produces [object Object]
`Error: ${err}`;

// ✅ CORRECT
err instanceof Error ? err.message : String(err);
```

---

## Quick Reference Card

### Minimum Output Sequence

```jsonl
{"type":"system","subtype":"init","session_id":"...","cwd":"...","tools":[...],"model":"...","permissionMode":"bypassPermissions","apiKeySource":"env"}
{"type":"assistant","message":{"id":"msg_...","type":"message","role":"assistant","model":"...","content":[{"type":"text","text":"..."}]}}
{"type":"result","subtype":"success","is_error":false,"duration_ms":1234,"num_turns":1,"result":"..."}
```

### Exit Code Summary

| Exit | Meaning | Result Message |
| ---- | ------- | -------------- |
| 0    | Success | ✅ Emitted     |
| 1    | Error   | ✅ Emitted     |

### Must-Have Behaviors

- [ ] System init is first message
- [ ] Result is last message
- [ ] Flush stdout before exit
- [ ] Auto-approve permissions (never hang)
- [ ] Deduplicate text streams
- [ ] Deduplicate tool emissions
- [ ] Map tool names to standard set
- [ ] Convert tool input keys to snake_case
- [ ] Generate valid UUID/msg\_\*/toolu\_\* IDs

---
