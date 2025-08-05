import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createPassthroughProxy } from "../../server/proxy";

// Mock fetch globally for tests
const originalFetch = globalThis.fetch;
const mockFetch = mock();

beforeEach(() => {
  globalThis.fetch = mockFetch as any;
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
      enableLogging: false,
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
      enableLogging: false,
    });

    const request = new Request("http://localhost:3000/v1/messages", {
      method: "POST",
      body: JSON.stringify({ stream: true }),
    });

    const response = await proxy.processRequest(request, "/v1/messages");
    expect(response.status).toBe(200);
    expect(response.body).toBe(mockStream);
  });
});
