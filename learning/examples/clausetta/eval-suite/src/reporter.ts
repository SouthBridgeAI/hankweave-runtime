import type { TestSuiteResult, TestResult, ShimConfig } from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import { readFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";

/**
 * Helper to read log file content if it exists
 */
async function readLogFile(runDir: string, testName: string, filename: string): Promise<string> {
  const filePath = join(runDir, "tests", testName, filename);
  try {
    if (existsSync(filePath)) {
      return await readFile(filePath, "utf-8");
    }
  } catch {
    // Ignore read errors
  }
  return "";
}

// Test descriptions for documentation
const TEST_DESCRIPTIONS: Record<string, { purpose: string; verifies: string[]; specRef?: string }> = {
  "simple-response": {
    purpose: "Tests the most basic flow: prompt in → text response out → clean exit",
    verifies: [
      "Exit code is 0 for successful completion",
      "First message is system init with valid session_id (UUID v4)",
      "At least one assistant message with text content",
      "Last message is result with is_error: false",
      "Response contains relevant content",
    ],
    specRef: "Section 3.2 (Message Types), Section 3.7 (Exit Codes)",
  },
  "multi-turn-context": {
    purpose: "Verifies the agent maintains context within a single prompt",
    verifies: [
      "Agent processes the full prompt",
      "Agent can recall information from earlier in the prompt",
    ],
  },
  "valid-jsonl": {
    purpose: "Ensures all output is valid JSONL format",
    verifies: [
      "Every line of stdout parses as valid JSON",
      "No blank lines in output",
      "UTF-8 encoding is correct",
    ],
    specRef: "Section 3.1 (Format: JSONL)",
  },
  "message-ordering": {
    purpose: "Verifies correct message ordering in output stream",
    verifies: [
      "First message is type 'system' with subtype 'init'",
      "Last message is type 'result'",
      "Exactly one system init message",
      "Exactly one result message",
    ],
    specRef: "Section 3.2 (Message Types)",
  },
  "premature-completion": {
    purpose: "Catches shims that exit too early (e.g., on initial 'idle' status)",
    verifies: [
      "Shim waits for actual work to complete",
      "Response contains all expected content",
      "Usage tokens > 0 (work was actually done)",
    ],
    specRef: "Section 4.2 (Completion Detection)",
  },
  "tool-workflow": {
    purpose: "Tests multiple tool operations: Write, Read, and file verification",
    verifies: [
      "Files are actually created with correct content",
      "Tool calls include Write and Read tools",
      "Every tool_use has a matching tool_result",
      "Tool IDs are in valid format (toolu_*)",
      "Agent reports what it read from files",
    ],
    specRef: "Section 4.5 (Tool System)",
  },
  "bash-command": {
    purpose: "Verifies shell command execution and output capture",
    verifies: [
      "Bash/shell tool is used",
      "Command output is captured correctly",
      "Agent can use command output in subsequent operations",
    ],
  },
  "tool-completion-waiting": {
    purpose: "Ensures shim waits for slow tool operations to complete",
    verifies: [
      "Duration is at least as long as the slow operation (3s sleep)",
      "Tool output is captured after completion",
    ],
  },
  "complex-workflow": {
    purpose: "Tests a realistic multi-step workflow with various tool types",
    verifies: [
      "Directory creation works",
      "Multiple file creation works",
      "File reading works",
      "Multiple tool types are used",
      "All tool_use/tool_result pairs match",
      "Agent maintains context across operations",
    ],
  },
  "permission-handling": {
    purpose: "Verifies tool operations don't hang waiting for permissions",
    verifies: [
      "Operations complete within timeout (not blocked)",
      "Files are created successfully",
      "No permission prompts block execution",
    ],
    specRef: "Section 4.6 (Permission Handling)",
  },
  "sigint-handling": {
    purpose: "Tests graceful handling of SIGINT (Ctrl+C)",
    verifies: [
      "Process exits cleanly (doesn't hang)",
      "Exit code is valid (0, 1, 130, or 143)",
    ],
    specRef: "Section 4.3 (Signal Handling)",
  },
  "sigterm-handling": {
    purpose: "Tests graceful handling of SIGTERM",
    verifies: [
      "Process exits cleanly (doesn't hang)",
      "Exit code is valid (0, 1, 130, or 143)",
    ],
    specRef: "Section 4.3 (Signal Handling)",
  },
  "invalid-session-resume": {
    purpose: "Tests error handling when resuming a non-existent session",
    verifies: [
      "Exit code is 1 (error)",
      "stderr contains helpful error message about session not found",
      "Doesn't hang or crash",
    ],
    specRef: "Section 2.5 (Error Handling)",
  },
  "valid-session-resume": {
    purpose: "Tests session continuation maintains context across invocations",
    verifies: [
      "First run establishes context successfully",
      "Second run with --resume retrieves that context",
      "Session ID is reused (same as first run)",
      "Agent remembers information from first session",
    ],
    specRef: "Section 4.7 (Session Management)",
  },
  "empty-prompt": {
    purpose: "Tests handling of empty stdin",
    verifies: [
      "Exit code is 0 (clean exit)",
      "No JSONL output (stdout is empty)",
    ],
    specRef: "Section 2.4 (Standard Input)",
  },
  "large-file-handling": {
    purpose: "Tests ability to handle larger files (10,000 lines)",
    verifies: [
      "File can be read without crashing",
      "Agent correctly reports file statistics",
      "No timeout or memory issues",
    ],
  },
  "unicode-handling": {
    purpose: "Tests non-ASCII character handling in files",
    verifies: [
      "Unicode content is preserved correctly",
      "Output JSONL is valid UTF-8",
      "Agent can read and report unicode content",
    ],
  },
};

// Detailed failure hints with code examples
const FAILURE_HINTS: Record<string, string> = {
  "simple-response": `
**Possible causes:**

1. **Agent not starting:** Check if the agent process starts correctly
   \`\`\`typescript
   // Add debug logging
   console.error('Starting agent...');
   const agent = await startAgent();
   console.error('Agent started:', agent.status);
   \`\`\`

2. **Invalid JSONL output:** Each line must be valid JSON
   \`\`\`typescript
   // Correct
   console.log(JSON.stringify({ type: "system", ... }));

   // Wrong - will break parsing
   console.log("Starting...");  // Not JSON!
   \`\`\`

3. **Missing system init:** First message MUST be system init
   \`\`\`typescript
   // Emit this FIRST, before any agent processing
   emit({ type: "system", subtype: "init", session_id: uuid(), ... });
   \`\`\``,

  "message-ordering": `
**Possible causes:**

1. **System init emitted too late:** Must be FIRST, before any agent work
   \`\`\`typescript
   // Do this immediately after argument parsing
   emit({ type: "system", subtype: "init", ... });
   // THEN start agent work
   \`\`\`

2. **Result emitted too early:** Must be LAST, after all work is done
   \`\`\`typescript
   // Wait for completion
   await waitForAgentCompletion();
   // THEN emit result
   emit({ type: "result", ... });
   \`\`\`

3. **Multiple system/result messages:** Check for duplicate emissions`,

  "tool-workflow": `
**Possible causes:**

1. **Tool name not extracted:** Check SDK event structure
   \`\`\`typescript
   // Log the raw event to see its structure
   console.error('Tool event:', JSON.stringify(event, null, 2));

   // Extract name from correct field
   const toolName = event.tool?.name || event.toolName || 'unknown';
   \`\`\`

2. **Tool ID format wrong:** Must be toolu_* or call_*
   \`\`\`typescript
   function generateToolId(): string {
     return \`toolu_\${Date.now().toString(36)}\${Math.random().toString(36).slice(2)}\`;
   }
   \`\`\`

3. **Missing tool_result:** Every tool_use needs a matching tool_result
   \`\`\`typescript
   // Track pending tool calls
   const pendingTools = new Map<string, ToolUse>();

   // On tool_use: store it
   pendingTools.set(toolUse.id, toolUse);

   // On completion: emit tool_result
   emit({ type: "user", message: { content: [{
     type: "tool_result",
     tool_use_id: toolUse.id,
     content: result
   }]}});
   \`\`\``,

  "premature-completion": `
**Possible causes:**

1. **Completing on initial "idle":** Agents often emit idle on connect
   \`\`\`typescript
   let workStarted = false;

   // Set this when actual work begins
   agent.on('text_delta', () => { workStarted = true; });
   agent.on('tool_use', () => { workStarted = true; });

   // Only complete if work has started
   agent.on('idle', () => {
     if (workStarted) {
       complete();
     }
     // Otherwise, keep waiting
   });
   \`\`\`

2. **Completion timer too aggressive:** Reset timer on activity
   \`\`\`typescript
   let completionTimer: Timer | null = null;

   function resetCompletionTimer() {
     if (completionTimer) clearTimeout(completionTimer);
     completionTimer = setTimeout(complete, 5000);
   }

   // Reset on any activity
   agent.on('text_delta', resetCompletionTimer);
   agent.on('tool_use', resetCompletionTimer);
   \`\`\``,

  "invalid-session-resume": `
**Possible causes:**

1. **Not handling session lookup failure:** Check for missing session
   \`\`\`typescript
   const session = await lookupSession(sessionId);
   if (!session) {
     console.error(\`Error: Session not found: \${sessionId}\`);
     process.exit(1);
   }
   \`\`\`

2. **Wrong error handling:** Should print to stderr, exit 1`,

  "valid-session-resume": `
**Possible causes:**

1. **Session not persisted:** Check session storage path
   \`\`\`typescript
   // Sessions should be stored in working directory
   const sessionPath = path.join(process.cwd(), '.my-shim', 'sessions');
   \`\`\`

2. **Session ID not reused:** When resuming, use the SAME session ID
   \`\`\`typescript
   // On resume, use the provided session ID
   const sessionId = args.resume; // Don't generate a new one!
   emit({ type: "system", subtype: "init", session_id: sessionId, ... });
   \`\`\`

3. **Different working directories:** Both runs must use same cwd`,

  "permission-handling": `
**Possible causes:**

1. **Permissions blocking:** Must auto-approve, never prompt
   \`\`\`typescript
   // Launch with permissions pre-granted
   const agent = await startAgent({
     permissions: 'bypass',  // or equivalent flag
     dangerouslySkipPermissions: true,
   });
   \`\`\`

2. **Not handling permission events:** Auto-approve immediately
   \`\`\`typescript
   agent.on('permission_request', (request) => {
     // Always approve - no user to ask
     request.approve();
   });
   \`\`\``,

  "empty-prompt": `
**Possible causes:**

1. **Not handling empty stdin:** Should exit cleanly
   \`\`\`typescript
   const prompt = await readStdin();
   if (!prompt.trim()) {
     // Exit silently with code 0
     process.exit(0);
   }
   \`\`\``,
};

/**
 * Generate a comprehensive Markdown report from test results
 */
export async function generateMarkdownReport(results: TestSuiteResult, config?: ShimConfig): Promise<string> {
  const lines: string[] = [];

  // Header with full context
  lines.push("# Shim Evaluation Report");
  lines.push("");
  lines.push("> **This report is designed for AI agents to debug and fix shim implementations.**");
  lines.push("> All relevant information (prompts, outputs, errors) is included inline or in referenced files.");
  lines.push("");

  // Run Information
  lines.push("## Run Information");
  lines.push("");
  lines.push("| Property | Value |");
  lines.push("| -------- | ----- |");
  lines.push(`| **Shim** | \`${results.shim}\` |`);
  lines.push(`| **Model** | \`${results.model}\` |`);
  lines.push(`| **Date** | ${results.date} |`);
  lines.push(`| **Duration** | ${formatDuration(results.duration)} |`);
  lines.push(`| **Run Directory** | \`${results.runDir}\` |`);
  lines.push("");

  // How the test was invoked
  lines.push("### How This Test Was Run");
  lines.push("");
  lines.push("```bash");
  if (config) {
    const args = [config.command, ...config.baseArgs, "-p", "--model", config.model].join(" ");
    lines.push(`echo "<prompt>" | ${args}`);
  } else {
    lines.push(`echo "<prompt>" | ${results.shim} -p --model ${results.model}`);
  }
  lines.push("```");
  lines.push("");

  // Summary with visual emphasis
  lines.push("## Summary");
  lines.push("");
  const total = results.passed + results.failed + results.skipped;
  const passRate = total > 0 ? Math.round((results.passed / total) * 100) : 0;

  if (results.failed === 0) {
    lines.push(`### ✅ All ${results.passed} tests passed!`);
  } else {
    lines.push(`### ⚠️ ${results.failed} of ${total} tests failed (${passRate}% pass rate)`);
  }
  lines.push("");
  lines.push(`| Status | Count |`);
  lines.push(`| ------ | ----- |`);
  lines.push(`| ✅ Passed | ${results.passed} |`);
  if (results.failed > 0) {
    lines.push(`| ❌ Failed | ${results.failed} |`);
  }
  if (results.skipped > 0) {
    lines.push(`| ⏭️ Skipped | ${results.skipped} |`);
  }
  lines.push("");

  // Failed Tests - detailed section
  const failedTests = results.results.filter((r) => !r.passed && !r.skipped);
  if (failedTests.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("## ❌ Failed Tests");
    lines.push("");
    lines.push("These tests failed and need to be fixed. Each section includes:");
    lines.push("- What the test checks");
    lines.push("- What went wrong");
    lines.push("- Where to find logs");
    lines.push("- Debugging suggestions");
    lines.push("");

    for (const test of failedTests) {
      lines.push(`### ❌ ${test.name}`);
      lines.push("");

      // Test description
      const desc = TEST_DESCRIPTIONS[test.name];
      if (desc) {
        lines.push(`**Purpose:** ${desc.purpose}`);
        lines.push("");
        lines.push("**This test verifies:**");
        for (const v of desc.verifies) {
          lines.push(`- ${v}`);
        }
        if (desc.specRef) {
          lines.push("");
          lines.push(`**Spec Reference:** ${desc.specRef}`);
        }
        lines.push("");
      }

      lines.push(`**Duration:** ${(test.duration / 1000).toFixed(1)}s`);
      lines.push("");

      // Error details
      if (test.error) {
        lines.push("#### What Went Wrong");
        lines.push("");
        lines.push("```");
        lines.push(test.error.message);
        lines.push("```");
        lines.push("");

        if (test.error.expected || test.error.actual) {
          lines.push("| | Value |");
          lines.push("|-|-------|");
          if (test.error.expected) {
            lines.push(`| **Expected** | ${test.error.expected} |`);
          }
          if (test.error.actual) {
            lines.push(`| **Actual** | ${test.error.actual} |`);
          }
          lines.push("");
        }

        if (test.error.context && Object.keys(test.error.context).length > 0) {
          lines.push("**Additional Context:**");
          lines.push("");
          lines.push("```json");
          lines.push(JSON.stringify(test.error.context, null, 2));
          lines.push("```");
          lines.push("");
        }
      }

      // Log files
      lines.push("#### Log Files");
      lines.push("");
      lines.push(`All test artifacts are in the \`tests/${test.name}/\` directory:`);
      lines.push("");
      lines.push("| File | Description |");
      lines.push("| ---- | ----------- |");
      lines.push(`| \`tests/${test.name}/output.jsonl\` | Raw JSONL output from shim |`);
      lines.push(`| \`tests/${test.name}/stderr.txt\` | Stderr output (errors, debug logs) |`);
      lines.push(`| \`tests/${test.name}/input.txt\` | Prompt that was sent |`);
      lines.push(`| \`tests/${test.name}/workspace/\` | Test workspace directory |`);
      lines.push("");

      // Include actual output snippets inline for easier debugging
      // Read from disk if not available in test result
      let stdout = test.logs.stdout;
      let stderr = test.logs.stderr;

      if (!stdout && !stderr && results.runDir) {
        stdout = await readLogFile(results.runDir, test.name, "output.jsonl");
        stderr = await readLogFile(results.runDir, test.name, "stderr.txt");
      }

      if (stdout || stderr) {
        lines.push("#### Captured Output");
        lines.push("");

        if (stderr && stderr.trim()) {
          lines.push("**stderr (first 2000 chars):**");
          lines.push("");
          lines.push("```");
          lines.push(stderr.slice(0, 2000));
          if (stderr.length > 2000) {
            lines.push(`... (${stderr.length - 2000} more characters, see stderr.txt)`);
          }
          lines.push("```");
          lines.push("");
        }

        if (stdout && stdout.trim()) {
          lines.push("**stdout (first 3000 chars):**");
          lines.push("");
          lines.push("```json");
          lines.push(stdout.slice(0, 3000));
          if (stdout.length > 3000) {
            lines.push(`... (${stdout.length - 3000} more characters, see output.jsonl)`);
          }
          lines.push("```");
          lines.push("");
        }
      }

      // Debugging hints
      const hints = FAILURE_HINTS[test.name];
      if (hints) {
        lines.push("#### How to Debug");
        lines.push("");
        lines.push(hints.trim());
        lines.push("");
      }

      lines.push("---");
      lines.push("");
    }
  }

  // Passed Tests - collapsible with descriptions
  const passedTests = results.results.filter((r) => r.passed && !r.skipped);
  if (passedTests.length > 0) {
    lines.push("## ✅ Passed Tests");
    lines.push("");
    lines.push("<details>");
    lines.push(`<summary>Click to expand ${passedTests.length} passed tests</summary>`);
    lines.push("");
    lines.push("| Test | Duration | Purpose |");
    lines.push("| ---- | -------- | ------- |");
    for (const test of passedTests) {
      const desc = TEST_DESCRIPTIONS[test.name];
      const purpose = desc?.purpose || "";
      lines.push(`| ✅ ${test.name} | ${(test.duration / 1000).toFixed(1)}s | ${purpose} |`);
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  // Skipped Tests
  const skippedTests = results.results.filter((r) => r.skipped);
  if (skippedTests.length > 0) {
    lines.push("## ⏭️ Skipped Tests");
    lines.push("");
    lines.push("These tests were skipped (usually because they don't apply to this shim configuration):");
    lines.push("");
    for (const test of skippedTests) {
      lines.push(`- **${test.name}**`);
    }
    lines.push("");
  }

  // Reference section
  lines.push("---");
  lines.push("");
  lines.push("## Reference");
  lines.push("");
  lines.push("### Understanding the Output Format");
  lines.push("");
  lines.push("Your shim should output JSONL (one JSON object per line) to stdout:");
  lines.push("");
  lines.push("```jsonl");
  lines.push('{"type":"system","subtype":"init","session_id":"uuid-here","cwd":"/path","tools":[...],"model":"..."}');
  lines.push('{"type":"assistant","message":{"id":"msg_...","role":"assistant","content":[{"type":"text","text":"..."}]}}');
  lines.push('{"type":"result","subtype":"success","is_error":false,"duration_ms":1234,"num_turns":1}');
  lines.push("```");
  lines.push("");
  lines.push("### Key Requirements");
  lines.push("");
  lines.push("1. **First message** must be `type: \"system\"` with `subtype: \"init\"`");
  lines.push("2. **Last message** must be `type: \"result\"`");
  lines.push("3. **All output** must be valid JSON (one object per line)");
  lines.push("4. **Diagnostic output** goes to stderr, never stdout");
  lines.push("5. **Flush stdout** before exiting");
  lines.push("");
  lines.push("### Run Directory Structure");
  lines.push("");
  lines.push("```");
  lines.push(`${results.runDir.split("/").pop()}/`);
  lines.push("├── report.md           # This report");
  lines.push("├── summary.json        # Machine-readable results");
  lines.push("└── tests/");
  lines.push("    ├── test-name-1/");
  lines.push("    │   ├── input.txt       # Prompt that was sent");
  lines.push("    │   ├── output.jsonl    # Raw JSONL output");
  lines.push("    │   ├── stderr.txt      # Stderr output");
  lines.push("    │   └── workspace/      # Test working directory");
  lines.push("    └── test-name-2/");
  lines.push("        └── ...");
  lines.push("```");
  lines.push("");
  lines.push("### For More Information");
  lines.push("");
  lines.push("- See the full shim specification: `shim-spec-v2/spec.md`");
  lines.push("- See the eval suite specification: `shim-eval-suite/SPEC.md`");
  lines.push("");

  return lines.join("\n");
}

/**
 * Generate a JSON summary for machine consumption
 */
export function generateJsonSummary(results: TestSuiteResult): string {
  return JSON.stringify(
    {
      shim: results.shim,
      model: results.model,
      date: results.date,
      duration_ms: results.duration,
      run_dir: results.runDir,
      summary: {
        total: results.passed + results.failed + results.skipped,
        passed: results.passed,
        failed: results.failed,
        skipped: results.skipped,
        pass_rate: results.passed / (results.passed + results.failed + results.skipped) || 0,
      },
      tests: results.results.map((r) => ({
        name: r.name,
        passed: r.passed,
        skipped: r.skipped || false,
        duration_ms: r.duration,
        error: r.error ? {
          message: r.error.message,
          expected: r.error.expected,
          actual: r.error.actual,
          context: r.error.context,
        } : null,
        logs: r.logs,
        description: TEST_DESCRIPTIONS[r.name]?.purpose || null,
      })),
    },
    null,
    2
  );
}

/**
 * Write reports to the run directory
 */
export async function writeReports(
  results: TestSuiteResult,
  workspace: WorkspaceManager,
  config?: ShimConfig
): Promise<void> {
  const markdown = generateMarkdownReport(results, config);
  const json = generateJsonSummary(results);

  await workspace.writeReport("report.md", markdown);
  await workspace.writeReport("summary.json", json);
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${seconds}s`;
}
