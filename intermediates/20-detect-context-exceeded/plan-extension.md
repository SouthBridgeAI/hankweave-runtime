# Execution Plan: Context Exceeded Error Detection Extension

## Overview
This plan extends the existing context exceeded error detection to handle cases where the tadpole server is NOT using the LLM proxy. When proxy is disabled (via `--without-proxy` flag), we need to detect context exceeded errors by parsing Claude log messages directly.

## Context
The original implementation (see `plan.md` in this directory) handles context exceeded errors when they're detected by the LLM proxy via HTTP error responses. This extension adds detection for scenarios where:
1. Server is running with `--without-proxy` flag
2. Claude Code returns synthetic error messages in the log
3. Errors appear in result messages at session end

## Error Patterns to Detect

Based on examples from the extension document, two patterns exist in Claude logs:

### Pattern 1: Synthetic Assistant Message (terminated)
```json
{
  "type": "assistant",
  "message": {
    "id": "92543df9-1a77-4605-bec0-3cea4ce9f51f",
    "model": "<synthetic>",
    "role": "assistant",
    "stop_reason": "stop_sequence",
    "stop_sequence": "",
    "type": "message",
    "usage": {
      "input_tokens": 0,
      "output_tokens": 0,
      "cache_creation_input_tokens": 0,
      "cache_read_input_tokens": 0,
      "server_tool_use": {"web_search_requests": 0},
      "service_tier": null
    },
    "content": [{"type": "text", "text": "API Error: terminated"}]
  },
  "parent_tool_use_id": null,
  "session_id": "983b8c3c-7336-4ef9-8d38-f564e81f551e"
}
```

### Pattern 2: Result Message (output token limit)
```json
{
  "type": "result",
  "subtype": "success",
  "is_error": true,
  "duration_ms": 370393,
  "duration_api_ms": 371414,
  "num_turns": 18,
  "result": "API Error: Claude's response exceeded the 32000 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.",
  "session_id": "89273bda-141c-4842-ba54-96d1eab913a0",
  "total_cost_usd": 0.7717817000000001,
  "usage": {
    "input_tokens": 6,
    "cache_creation_input_tokens": 71382,
    "cache_read_input_tokens": 75580,
    "output_tokens": 32008,
    "server_tool_use": {"web_search_requests": 0},
    "service_tier": "standard"
  }
}
```

**Key distinction:**
- Pattern 1: Detects when input context is exceeded (similar to LLM proxy errors)
- Pattern 2: Detects when OUTPUT token limit is exceeded (different error type)

## Implementation Plan

### 1. Add Type Guard for Context Exceeded Messages

**File:** `server/types/types.ts`

**Action:** Add a single helper function to detect context exceeded errors in Claude logs.

**Location:** After line 580 (after `isSyntheticTimeout`)

**Code to add:**

```typescript
/**
 * Type guard to check if a log message indicates a context exceeded error.
 * Detects two patterns:
 * - Pattern 1: Synthetic assistant message with "API Error: terminated"
 * - Pattern 2: Result message with "exceeded the...output token maximum"
 */
export function isContextExceeded(msg: ClaudeLogMessage): boolean {
  // Pattern 1: Synthetic assistant message with "API Error: terminated"
  if (msg.type === "assistant") {
    const assistantMsg = msg as AssistantMessage;
    return (
      assistantMsg.message.model === "<synthetic>" &&
      Array.isArray(assistantMsg.message.content) &&
      assistantMsg.message.content.length === 1 &&
      assistantMsg.message.content[0].type === "text" &&
      assistantMsg.message.content[0].text === "API Error: terminated"
    );
  }

  // Pattern 2: Result message with output token limit exceeded
  if (msg.type === "result") {
    const resultMsg = msg as ResultMessage;
    return (
      resultMsg.is_error === true &&
      typeof resultMsg.result === "string" &&
      resultMsg.result.includes("exceeded the") &&
      resultMsg.result.includes("output token maximum")
    );
  }

  return false;
}
```

**Rationale:**
- Single function handles both patterns for simplicity
- Follow existing pattern from `isSyntheticTimeout` for consistency
- Returns boolean (no need for complex type narrowing since handling is the same)
- Pattern 1 checks for exact match on synthetic model + "API Error: terminated"
- Pattern 2 checks result messages for output token limit text

**Import updates needed:**
Add `ResultMessage` import at the top of the file:
```typescript
import type { ResultMessage } from "./claude-session-schema.js";
```

### 2. Handle Context Exceeded in Tadpole Server

**File:** `server/tadpole-server.ts`

**Action:** Add context exceeded detection in the log parsing logic, similar to how `isSyntheticTimeout` is used. For now, just log the error.

**Current location of synthetic timeout handling:** Line 1941

**Location:** In the message parsing logic where `isSyntheticTimeout` is checked, add a check right after it (after line 1977).

**Code to add:**

```typescript
// Check for context exceeded errors
// Only check when proxy is disabled to avoid double-handling
if (this.config.withoutProxy && isContextExceeded(msg as ClaudeLogMessage)) {
  this.logger.log(
    `[TADPOLE-SERVER] Context exceeded error detected for phase ${phaseId}`,
    "error"
  );
  // Additional handling will be added in future work
}
```

**Import updates needed:**

Add to imports at top of file:
```typescript
import { ClientMode, isSyntheticTimeout, isContextExceeded } from "./types/types.js";
```

**Key design decisions:**
1. **Only check when proxy disabled:** Use `this.config.withoutProxy` guard to prevent double-handling errors (LLM proxy already handles these when enabled)
2. **Similar pattern to timeout:** Follow exact same pattern as `isSyntheticTimeout` for consistency
3. **Simple logging only:** As requested, just log the error for now
4. **Single check handles both patterns:** The unified `isContextExceeded` function handles both message types

### 3. Add Tests

**File:** `tests/unit/types.test.ts` (or create new test file)

**Action:** Add tests for the new type guard function.

**Tests to add:**

```typescript
import { describe, test, expect } from "bun:test";
import { isContextExceeded } from "../../server/types/types";

describe("isContextExceeded", () => {
  test("detects Pattern 1: synthetic terminated message", () => {
    const msg = {
      type: "assistant",
      message: {
        id: "92543df9-1a77-4605-bec0-3cea4ce9f51f",
        model: "<synthetic>",
        role: "assistant",
        stop_reason: "stop_sequence",
        stop_sequence: "",
        type: "message",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        content: [{ type: "text", text: "API Error: terminated" }],
      },
      parent_tool_use_id: null,
      session_id: "983b8c3c-7336-4ef9-8d38-f564e81f551e",
    };

    expect(isContextExceeded(msg)).toBe(true);
  });

  test("detects Pattern 2: output token maximum exceeded in result message", () => {
    const msg = {
      type: "result",
      subtype: "success",
      is_error: true,
      duration_ms: 370393,
      duration_api_ms: 371414,
      num_turns: 18,
      result:
        "API Error: Claude's response exceeded the 32000 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.",
      session_id: "89273bda-141c-4842-ba54-96d1eab913a0",
      total_cost_usd: 0.7717817000000001,
      usage: {
        input_tokens: 6,
        cache_creation_input_tokens: 71382,
        cache_read_input_tokens: 75580,
        output_tokens: 32008,
      },
    };

    expect(isContextExceeded(msg)).toBe(true);
  });

  test("does not detect regular assistant messages", () => {
    const msg = {
      type: "assistant",
      message: {
        id: "msg_123",
        model: "claude-sonnet-4-20250514",
        role: "assistant",
        type: "message",
        content: [{ type: "text", text: "Hello!" }],
        stop_reason: "end_turn",
        stop_sequence: null,
      },
    };

    expect(isContextExceeded(msg)).toBe(false);
  });

  test("does not detect synthetic timeout messages", () => {
    const msg = {
      type: "assistant",
      message: {
        id: "msg_timeout",
        model: "<synthetic>",
        role: "assistant",
        type: "message",
        content: "API Error: Request timed out.",
        stop_reason: null,
        stop_sequence: null,
      },
    };

    expect(isContextExceeded(msg)).toBe(false);
  });

  test("does not detect successful result messages", () => {
    const msg = {
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 12000,
      duration_api_ms: 11500,
      num_turns: 5,
      result: "Task completed successfully",
      session_id: "session-123",
    };

    expect(isContextExceeded(msg)).toBe(false);
  });

  test("does not detect error result with different message", () => {
    const msg = {
      type: "result",
      subtype: "error",
      is_error: true,
      duration_ms: 5000,
      duration_api_ms: 4500,
      num_turns: 2,
      result: "API Error: Invalid API key",
      session_id: "session-456",
    };

    expect(isContextExceeded(msg)).toBe(false);
  });
});
```

**Rationale:**
- Test both Pattern 1 (synthetic assistant) and Pattern 2 (result message)
- Test negative cases to ensure no false positives
- Ensure we don't confuse with synthetic timeout messages
- Use exact examples from the extension document

## Summary of Changes

### Files to Modify:
1. **server/types/types.ts** - Add `isContextExceeded()` helper function
2. **server/tadpole-server.ts** - Add simple context exceeded detection with logging
3. **tests/unit/types.test.ts** - Add comprehensive tests for the type guard

### New Exports:
- `isContextExceeded()` function (from `types.ts`)

### Key Design Decisions:

1. **Single unified helper:** One function handles both error patterns for simplicity
2. **Proxy guard:** Only detect in logs when `withoutProxy` is true to prevent double-handling
3. **Two detection patterns:**
   - Pattern 1: Synthetic assistant message with "API Error: terminated"
   - Pattern 2: Result message with output token limit text
4. **Consistent with timeout handling:** Follow exact same pattern as `isSyntheticTimeout`
5. **Simple logging only:** Just log the error for now, additional handling will be added later
6. **Reuse existing infrastructure:** Leverages existing `ContextExceededError` class from LLM proxy implementation

## Integration with Existing Code

This extension complements the existing LLM proxy-based detection:

- **With proxy enabled:** Errors detected via HTTP transport (see `plan.md`)
- **With proxy disabled:** Errors detected via log parsing (this extension)
- **Never both:** The `withoutProxy` guard ensures no double-handling

## Testing Strategy:

1. **Unit tests:** Test type guard with exact message formats from examples
2. **Negative tests:** Ensure we don't false-positive on similar messages (especially timeout messages)

## Notes for Implementation:

1. **Location in tadpole-server.ts:** Add the check in the same area where `isSyntheticTimeout` is checked (around line 1977)
2. **Logging format:** Use `[TADPOLE-SERVER]` prefix to match existing logging patterns
3. **Testing coordination:** New unit tests should NOT be placed in `tests/test-area` per project instructions (rule #1)

## Related Work:

- Original implementation: `intermediates/20-detect-context-exceeded/plan.md` (LLM proxy detection)
- Extension request: `intermediates/20-detect-context-exceeded/2-extension.md`
- Existing pattern: `isSyntheticTimeout()` in `server/types/types.ts` (lines 574-580)
- Error handling: Context exceeded handling in `server/tadpole-server.ts` (via LLM proxy, lines 386-401)
