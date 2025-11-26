# Execution Plan: Context Exceeded Error Detection

## Overview
Implement detection and handling of "Context Exceeded" errors from Claude's API in the LLMProxy system. This will allow tadpole server to identify when token limits are exceeded and handle them appropriately.

## Error Patterns to Detect
Based on the examples provided, we need to detect these error patterns:
1. `"input length and \`max_tokens\` exceed context limit: X + Y > Z"`
2. `"prompt is too long: X tokens > Y maximum"`

Both errors have:
- `type: "error"`
- `error.type: "invalid_request_error"`
- `error.message` containing the patterns above

## Implementation Plan

### 1. Create ContextExceededError Class

**File:** `server/types/error-types.ts`

**Action:** Add a new error class following the existing TadpoleError pattern:

```typescript
export class ContextExceededError extends TadpoleError {
  constructor(
    message: string,
    public readonly originalError: unknown,
    context?: Record<string, unknown>
  ) {
    super(message, ErrorSeverity.PHASE, "CONTEXT_EXCEEDED_ERROR", context);
    this.name = "ContextExceededError";
  }
}
```

**Rationale:**
- Extends `TadpoleError` for consistency with existing error hierarchy
- Uses `PHASE` severity since this is a phase-level issue (like `APITimeoutError`)
- Includes `originalError` field to preserve the full error response from Claude's API
- Provides context object for additional metadata

### 2. Add Error Detection Logic to HttpTransport

**File:** `server/llm-proxy.ts`

**Action:** Modify the `HttpTransport` class to accept an error handler and call it when errors are detected, then still throw the error to maintain error propagation.

**Current code location:** Lines 123-168

**Import needed:** Add to imports:
```typescript
import { ContextExceededError, TadpoleError } from "./types/error-types.js";
```

**Changes needed:**

1. Add helper function to detect context exceeded errors:
```typescript
/**
 * Check if an error response indicates a context exceeded error
 */
function isContextExceededError(responseBody: string): boolean {
  try {
    const parsed = JSON.parse(responseBody);

    if (parsed.type === "error" &&
        parsed.error?.type === "invalid_request_error" &&
        typeof parsed.error?.message === "string") {
      const message = parsed.error.message.toLowerCase();

      // Check for both error patterns
      return message.includes("exceed context limit") ||
             message.includes("prompt is too long") ||
             message.includes("max_tokens");
    }
    return false;
  } catch {
    // Not JSON or parsing failed
    return false;
  }
}
```

2. Update `HttpTransport` constructor to accept error handler:

```typescript
class HttpTransport implements LLMTransport {
  constructor(
    private baseUrl: string,
    public logger: Logger,
    private errorHandler?: LLMProxyErrorHandler,
  ) {}

  // ... rest of class
}
```

3. Update the `forward()` method to call error handler before throwing error:

```typescript
async forward(req: LLMProxyRequest): Promise<LLMProxyResponse> {
  const targetUrl = `${this.baseUrl}${req.url}`;

  this.logger.log(`[PROXY-HTTP-TRANSPORT] Forwarding ${req.method} request to ${targetUrl}`);

  try {
    const forwardHeaders = { ...req.headers };
    const urlParts = new URL(this.baseUrl);
    forwardHeaders.host = urlParts.host;

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: forwardHeaders,
      body: req.body,
    });

    this.logger.log(`[PROXY-HTTP-TRANSPORT] Received response with status ${response.status}`);

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    const isStreaming =
      responseHeaders["content-type"]?.includes("text/event-stream") ||
      responseHeaders["transfer-encoding"] === "chunked";

    const responseBody = isStreaming ? response.body || undefined : await response.text();

    if (response.status !== 200) {
      this.logger.log(`[PROXY-HTTP-TRANSPORT] error: ${responseBody}`, "error");

      // Check if this is a context exceeded error (only for non-streaming responses)
      if (typeof responseBody === "string" && isContextExceededError(responseBody) && this.errorHandler) {
        const parsedError = JSON.parse(responseBody);
        this.errorHandler(new ContextExceededError(
          parsedError.error.message,
          parsedError,
          {
            status: response.status,
            requestUrl: targetUrl,
          }
        ));
      }
    }

    return {
      status: response.status,
      headers: responseHeaders,
      body: responseBody,
    };
  } catch (error) {
    this.logger.log(
      `[PROXY-HTTP-TRANSPORT] Failed to fetch from ${targetUrl}: ${error}`,
      "error",
    );
    throw error;
  }
}
```

**Note:** Error handler is called immediately when error is detected, then error is thrown to maintain normal error propagation flow.


4. Update `createPassthroughProxy` to pass handler to HttpTransport:
```typescript
export function createPassthroughProxy({
  proxyToUrl,
  logger,
  onError,
}: {
  proxyToUrl: string;
  logger: Logger;
  onError?: LLMProxyErrorHandler;
}): LLMProxy {
  return new LLMProxy(
    new HttpTransport(proxyToUrl, logger, onError),  // Pass handler to transport
    [new LoggingMiddleware(logger)],
    logger,
    false
  );
}
```

### 5. Update BunProxyRunner to Support Error Handler

**File:** `server/llm-proxy.ts`

**Action:** Modify `BunProxyRunner` to accept and pass through the error handler.

**Changes needed:**

```typescript
export class BunProxyRunner {
  private server?: Bun.Server;
  private errorHandler?: LLMProxyErrorHandler;

  constructor(
    private proxy: "passthrough",
    private port: number,
    private proxyToUrl: string,
    private logger: Logger,
    onError?: LLMProxyErrorHandler,
  ) {
    this.errorHandler = onError;
  }

  start(): string {
    if (this.proxy !== "passthrough") {
      throw new Error("Unsupported proxy type. Only 'passthrough' is supported.");
    }

    const proxy = createPassthroughProxy({
      proxyToUrl: this.proxyToUrl,
      logger: this.logger,
      onError: this.errorHandler,
    });

    // ... rest of start() method unchanged ...
  }
}
```

### 6. Add Handler to Tadpole Server

**File:** `server/tadpole-server.ts`

**Action:** Add error handler when creating the proxy runner.

**Current code location:** Lines 380-386

**Changes needed:**

```typescript
if (!this.config.withoutProxy) {
  const proxyPort = this.config.port + 1;
  this.logger.log(`Starting proxy server on port ${proxyPort}`);

  // Define generic error handler for LLM proxy
  const handleProxyError = (error: TadpoleError) => {
    if (error instanceof ContextExceededError) {
      this.logger.log(
        `[TADPOLE-SERVER] Context exceeded error detected: ${error.message}`,
        "error"
      );
      this.logger.log(
        `[TADPOLE-SERVER] Original error: ${JSON.stringify(error.originalError, null, 2)}`,
        "error"
      );
    } else {
      this.logger.log(
        `[TADPOLE-SERVER] LLM Proxy error (${error.name}): ${error.message}`,
        "error"
      );
    }
  };

  this.proxyRunner = new BunProxyRunner(
    "passthrough",
    proxyPort,
    this.config.anthropicBaseURL || "https://api.anthropic.com",
    this.logger,
    handleProxyError,
  );
  this.proxyRunner.start();
} else {
  this.logger.log("Proxy server disabled");
}
```

**Imports needed:** Add to imports from `llm-proxy.js`:
- `LLMProxyErrorHandler` type

**Imports needed:** Add to imports from `error-types.ts`:
- `ContextExceededError` class
- `TadpoleError` class

### 7. Add Tests for LLMProxy

**File:** `tests/unit/llm-proxy.test.ts`

**Action:** Add test cases for context exceeded error detection and handling.

**Import needed:** Add to imports:
```typescript
import { ContextExceededError } from "../../server/types/error-types";
```

**Tests to add:**

**Note:** Test error messages use exact examples from `intermediates/20-detect-context-exceeded/1-prompt.md`

```typescript
describe("Context Exceeded Error Detection", () => {
  test("detects context exceeded error with input + max_tokens pattern", async () => {
    // Using exact error from intermediates/20-detect-context-exceeded/1-prompt.md
    const errorResponse = {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "input length and `max_tokens` exceed context limit: 142778 + 64000 > 200000, decrease input length or `max_tokens` and try again"
      },
      request_id: "req_011CUzgMtQukQG5c6M3BCwzY"
    };

    const mockResponse = {
      status: 400,
      headers: new Map([["content-type", "application/json"]]),
      text: mock().mockResolvedValue(JSON.stringify(errorResponse)),
    };
    mockFetch.mockResolvedValue(mockResponse);

    const handlerMock = mock();
    const proxy = createPassthroughProxy({
      proxyToUrl: "https://api.anthropic.com",
      logger: mockLogger,
      onError: handlerMock,
    });

    const request = new Request("http://localhost:3000/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-3-sonnet-20240229",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 64000,
      }),
    });

    const response = await proxy.processRequest(request, "/v1/messages");

    // Verify handler was called
    expect(handlerMock).toHaveBeenCalledTimes(1);
    const errorArg = handlerMock.mock.calls[0][0];
    expect(errorArg).toBeInstanceOf(ContextExceededError);
    expect(errorArg.message).toContain("exceed context limit");
    expect(errorArg.originalError).toEqual(errorResponse);

    // Verify response
    expect(response.status).toBe(400);
    const responseBody = await response.json();
    expect(responseBody).toEqual(errorResponse);
  });

  test("detects context exceeded error with prompt too long pattern", async () => {
    // Using exact error from intermediates/20-detect-context-exceeded/1-prompt.md
    const errorResponse = {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "prompt is too long: 209335 tokens > 200000 maximum"
      },
      request_id: "req_011CUzrJhQTRJaFygPAZJQdi"
    };

    const mockResponse = {
      status: 400,
      headers: new Map([["content-type", "application/json"]]),
      text: mock().mockResolvedValue(JSON.stringify(errorResponse)),
    };
    mockFetch.mockResolvedValue(mockResponse);

    const handlerMock = mock();
    const proxy = createPassthroughProxy({
      proxyToUrl: "https://api.anthropic.com",
      logger: mockLogger,
      onError: handlerMock,
    });

    const request = new Request("http://localhost:3000/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-3-sonnet-20240229",
        messages: [{ role: "user", content: "A".repeat(300000) }],
        max_tokens: 1000,
      }),
    });

    const response = await proxy.processRequest(request, "/v1/messages");

    // Verify handler was called
    expect(handlerMock).toHaveBeenCalledTimes(1);
    const errorArg = handlerMock.mock.calls[0][0];
    expect(errorArg).toBeInstanceOf(ContextExceededError);
    expect(errorArg.message).toContain("prompt is too long");

    // Verify response
    expect(response.status).toBe(400);
  });

  test("does not trigger handler for other API errors", async () => {
    const errorResponse = {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Invalid API key"
      }
    };

    const mockResponse = {
      status: 401,
      headers: new Map([["content-type", "application/json"]]),
      text: mock().mockResolvedValue(JSON.stringify(errorResponse)),
    };
    mockFetch.mockResolvedValue(mockResponse);

    const handlerMock = mock();
    const proxy = createPassthroughProxy({
      proxyToUrl: "https://api.anthropic.com",
      logger: mockLogger,
      onError: handlerMock,
    });

    const request = new Request("http://localhost:3000/v1/messages", {
      method: "POST",
      body: JSON.stringify({ test: "data" }),
    });

    await proxy.processRequest(request, "/v1/messages");

    // Handler should not be called for non-context-exceeded errors
    expect(handlerMock).not.toHaveBeenCalled();
  });

  test("works without handler registered", async () => {
    const errorResponse = {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "prompt is too long: 209335 tokens > 200000 maximum"
      }
    };

    const mockResponse = {
      status: 400,
      headers: new Map([["content-type", "application/json"]]),
      text: mock().mockResolvedValue(JSON.stringify(errorResponse)),
    };
    mockFetch.mockResolvedValue(mockResponse);

    // No handler provided
    const proxy = createPassthroughProxy({
      proxyToUrl: "https://api.anthropic.com",
      logger: mockLogger,
    });

    const request = new Request("http://localhost:3000/v1/messages", {
      method: "POST",
      body: JSON.stringify({ test: "data" }),
    });

    // Should not throw even without handler
    const response = await proxy.processRequest(request, "/v1/messages");
    expect(response.status).toBe(400);
  });
});
```

## Summary of Changes

### Files to Modify:
1. **server/types/error-types.ts** - Add `ContextExceededError` class
2. **server/llm-proxy.ts** - Add error detection, handler callback, and error propagation
3. **server/tadpole-server.ts** - Add handler for context exceeded errors
4. **tests/unit/llm-proxy.test.ts** - Add comprehensive tests

### New Exports:
- `ContextExceededError` class (from `error-types.ts`)
- `LLMProxyErrorHandler` type (from `llm-proxy.ts`)

### Key Design Decisions:
1. **Generic error handler**: Using `LLMProxyErrorHandler` instead of specific `ContextExceededHandler` to support future error types with a single handler interface
2. **Error thrown in transport layer**: Errors are detected and thrown as `ContextExceededError` in `HttpTransport.forward()` where we have access to the raw error response
3. **Original error preserved**: The full error response is stored in `originalError` for debugging and analysis
4. **Optional handler**: Handler is optional to maintain backward compatibility
5. **Error response forwarded**: The original error response is returned to the client so Claude client sees the actual API error
6. **Phase-level severity**: Using `PHASE` severity since context exceeded is a phase-level issue like API timeouts
7. **TadpoleError base class**: Handler accepts `TadpoleError` instances, making it extensible for other error types in the future

## Testing Strategy:
1. Unit tests for error detection patterns (both error message formats)
2. Unit tests for handler invocation
3. Unit tests for behavior without handler
4. Unit tests for other errors (should not trigger handler)

## Integration Points:
- The handler in tadpole server currently just logs the error
