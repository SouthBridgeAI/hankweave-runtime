import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  createPassthroughProxy,
  DoubleMaxTokens,
} from "../../server/llm-proxy";
import type { Logger } from "../../server/utils";

// Mock fetch globally for tests
const originalFetch = globalThis.fetch;
const mockFetch = mock();

// Mock logger for tests
const mockLoggerLog = mock();
const mockLogger = {
  log: mockLoggerLog,
} as unknown as Logger;

beforeEach(() => {
  globalThis.fetch = mockFetch as any;
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
      })
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
      JSON.stringify(
        Object.assign({}, originalBody, { max_tokens: originalMaxTokens * 2 })
      )
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
