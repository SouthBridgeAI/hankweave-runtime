import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  createPassthroughProxy,
  DoubleMaxTokens,
  LLMProxy,
  type LLMProxyRequest,
  type LLMProxyResponse,
  type LLMTransport,
} from "../../server/llm-proxy";
import type { Logger } from "../../server/utils";

// Mock HTTP transport that can spy on requests and respond with streaming responses
class MockHttpTransport implements LLMTransport {
  public forwardCalls: LLMProxyRequest[] = [];
  private mockResponse: LLMProxyResponse;

  constructor(mockResponse?: LLMProxyResponse) {
    this.mockResponse = mockResponse || {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: new ReadableStream({
        start(controller) {
          // Simulate Claude API streaming response
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type": "message_start", "message": {"id": "msg_123"}}\n\n',
            ),
          );
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type": "content_block_delta", "delta": {"text": "Hello"}}\n\n',
            ),
          );
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type": "message_delta", "delta": {"stop_reason": "end_turn"}}\n\n',
            ),
          );
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
    };
  }

  async forward(request: LLMProxyRequest): Promise<LLMProxyResponse> {
    this.forwardCalls.push({ ...request });
    return this.mockResponse;
  }

  getLastRequest(): LLMProxyRequest | undefined {
    return this.forwardCalls[this.forwardCalls.length - 1];
  }

  clear(): void {
    this.forwardCalls = [];
  }
}

// Mock fetch globally for tests
const originalFetch = globalThis.fetch;
const mockFetch = mock();

// Mock logger for tests
const mockLoggerLog = mock();
const mockLogger = {
  log: mockLoggerLog,
} as unknown as Logger;

beforeEach(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  mockLoggerLog.mockClear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  mockFetch.mockClear();
});

describe("Passthrough LLM Proxy", () => {
  test("leaves request and response as is", async () => {
    const mockResponseData = '{"result": "success"}';
    const requestHeaders = {
      "content-type": "application/json",
      authorization: "Bearer test-key",
    };
    const requestBody = JSON.stringify({
      model: "claude-3-sonnet-20240229",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 100,
    });
    const mockResponse = {
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      text: mock().mockResolvedValue(mockResponseData),
    };
    const path = "/v1/messages";
    const proxyToUrl = "https://api.anthropic.com";
    mockFetch.mockResolvedValue(mockResponse);

    const proxy = createPassthroughProxy({
      proxyToUrl,
      logger: mockLogger,
    });

    const request = new Request(`http://localhost:3000${path}`, {
      method: "POST",
      headers: requestHeaders,
      body: requestBody,
    });

    const response = await proxy.processRequest(request, path);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(mockResponseData);
    expect(mockFetch).toHaveBeenCalledWith(
      `${proxyToUrl}${path}`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining(requestHeaders),
        body: requestBody,
      }),
    );
  });

  test("proxy processes streaming responses", async () => {
    const mockStream = new ReadableStream();
    const mockResponse = {
      status: 200,
      headers: new Map([["content-type", "text/event-stream"]]),
      body: mockStream,
    };
    mockFetch.mockResolvedValue(mockResponse);

    const proxy = createPassthroughProxy({
      proxyToUrl: "https://api.anthropic.com",
      logger: mockLogger,
    });

    const request = new Request("http://localhost:3000/v1/messages", {
      method: "POST",
      body: JSON.stringify({ stream: true }),
    });

    const response = await proxy.processRequest(request, "/v1/messages");
    expect(response.status).toBe(200);
    expect(response.body).toBeInstanceOf(ReadableStream);
  });

  test("uses logger for all logging", async () => {
    const mockResponseData = '{"result": "success"}';
    const mockResponse = {
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      text: mock().mockResolvedValue(mockResponseData),
    };
    mockFetch.mockResolvedValue(mockResponse);

    const proxy = createPassthroughProxy({
      proxyToUrl: "https://api.anthropic.com",
      logger: mockLogger,
    });

    const request = new Request("http://localhost:3000/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ test: "data" }),
    });

    await proxy.processRequest(request, "/v1/messages");

    // Verify logger was called multiple times (middleware logging + transport logging)
    expect(mockLoggerLog).toHaveBeenCalled();
    expect(mockLoggerLog.mock.calls.length).toBeGreaterThan(0);
  });
});

describe("LLMProxy", () => {
  test("can add and remove middleware dynamically", async () => {
    const mockTransport = new MockHttpTransport();
    const proxy = new LLMProxy(mockTransport, [], mockLogger);
    const originalMaxTokens = 100;

    const claudeRequestBody = {
      model: "claude-3-sonnet-20240229",
      messages: [{ role: "user" as const, content: "Hello" }],
      max_tokens: originalMaxTokens,
    };

    const createRequest = () =>
      new Request("http://localhost:3000/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(claudeRequestBody),
      });

    // Test 1: Request goes as-is without middleware
    await proxy.processRequest(createRequest(), "/v1/messages");

    let lastRequest = mockTransport.getLastRequest();
    expect(lastRequest).toBeTruthy();
    expect(lastRequest?.claudeRequestData?.max_tokens).toBe(originalMaxTokens);

    // Test 2: Add DoubleMaxTokens middleware, confirm max_tokens doubles
    const doubleMaxTokensMiddleware = new DoubleMaxTokens();
    proxy.addMiddleware(doubleMaxTokensMiddleware);

    mockTransport.clear();
    await proxy.processRequest(createRequest(), "/v1/messages");

    lastRequest = mockTransport.getLastRequest();
    expect(lastRequest?.claudeRequestData?.max_tokens).toBe(originalMaxTokens * 2);

    // Test 3: Remove middleware, confirm max_tokens count is back to normal
    const wasRemoved = proxy.removeMiddleware(doubleMaxTokensMiddleware);
    expect(wasRemoved).toBe(true);

    mockTransport.clear();
    await proxy.processRequest(createRequest(), "/v1/messages");

    lastRequest = mockTransport.getLastRequest();
    expect(lastRequest?.claudeRequestData?.max_tokens).toBe(originalMaxTokens); // Back to original

    // Test 4: Trying to remove non-existent middleware returns false
    const wasRemovedAgain = proxy.removeMiddleware(doubleMaxTokensMiddleware);
    expect(wasRemovedAgain).toBe(false);
  });
});

describe("DoubleMaxTokens Middleware", () => {
  test("doubles max_tokens when present in claudeRequestData", async () => {
    const middleware = new DoubleMaxTokens();
    const originalMaxTokens = 100;
    const originalBody = {
      model: "claude-3-sonnet-20240229",
      messages: [{ role: "user" as const, content: "Hello" }],
      max_tokens: originalMaxTokens,
    };

    const result = await middleware.processRequest({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(originalBody),
      claudeRequestData: originalBody,
    });

    expect(result.claudeRequestData?.max_tokens).toBe(originalMaxTokens * 2);
    expect(result.body).toBe(
      JSON.stringify(Object.assign({}, originalBody, { max_tokens: originalMaxTokens * 2 })),
    );
  });

  test("handles requests without max_tokens gracefully", async () => {
    const middleware = new DoubleMaxTokens();

    const mockRequest = {
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-3-sonnet-20240229",
        messages: [{ role: "user" as const, content: "Hello" }],
      }),
      claudeRequestData: {
        model: "claude-3-sonnet-20240229",
        messages: [{ role: "user" as const, content: "Hello" }],
      },
    };

    const result = await middleware.processRequest(mockRequest);

    expect(result).toEqual(mockRequest);
  });

  test("handles requests without claudeRequestData gracefully", async () => {
    const middleware = new DoubleMaxTokens();

    const mockRequest = {
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json" },
      body: "some non-claude data",
    };

    const result = await middleware.processRequest(mockRequest);

    expect(result).toEqual(mockRequest);
  });
});
