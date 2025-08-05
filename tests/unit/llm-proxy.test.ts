import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { BunProxyRunner, createPassthroughProxy } from "../../server/proxy";

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

describe("createPassthroughProxy", () => {
  test("creates a proxy instance", () => {
    const proxy = createPassthroughProxy();
    expect(proxy).toBeDefined();
    expect(typeof proxy.processRequest).toBe("function");
    expect(typeof proxy.addMiddleware).toBe("function");
  });

  test("accepts custom configuration", () => {
    const proxy = createPassthroughProxy({
      proxyToUrl: "https://api.example.com",
      enableLogging: false,
    });
    expect(proxy).toBeDefined();
  });

  test("proxy can process requests", async () => {
    // Mock a successful response
    const mockResponseData = '{"result": "success"}';
    const mockResponse = {
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      text: mock().mockResolvedValue(mockResponseData),
    };
    mockFetch.mockResolvedValue(mockResponse);

    const proxy = createPassthroughProxy({
      proxyToUrl: "https://api.anthropic.com",
      enableLogging: false,
    });

    const request = new Request("http://localhost:3000/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
      },
      body: JSON.stringify({
        model: "claude-3-sonnet-20240229",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 100,
      }),
    });

    const response = await proxy.processRequest(request, "/v1/messages");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(mockResponseData);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          authorization: "Bearer test-key",
          host: "api.anthropic.com",
        }),
      }),
    );
  });

  test("proxy handles errors gracefully", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));

    const proxy = createPassthroughProxy({
      proxyToUrl: "https://api.anthropic.com",
      enableLogging: false,
    });

    const request = new Request("http://localhost:3000/test", {
      method: "GET",
    });

    const response = await proxy.processRequest(request, "/test");
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Proxy Error");
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

describe("BunProxyRunner", () => {
  test("creates BunProxyRunner instance", () => {
    const runner = new BunProxyRunner("passthrough", 8080, "https://api.anthropic.com");
    expect(runner).toBeDefined();
    expect(runner.proxyUrl).toBe("http://localhost:8080");
  });

  test("only supports passthrough proxy type", () => {
    // TypeScript enforces that only "passthrough" is valid,
    // so we just verify that passthrough works
    const runner = new BunProxyRunner("passthrough", 8080, "https://api.anthropic.com");
    expect(runner).toBeDefined();
    expect(runner.proxyUrl).toBe("http://localhost:8080");
  });

  test("provides correct proxy URL", () => {
    const runner = new BunProxyRunner("passthrough", 9000, "https://api.anthropic.com");
    expect(runner.proxyUrl).toBe("http://localhost:9000");
  });

  test("can be stopped", () => {
    const runner = new BunProxyRunner("passthrough", 8080, "https://api.anthropic.com");
    expect(() => runner.stop()).not.toThrow();
  });
});
