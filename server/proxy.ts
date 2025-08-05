#!/usr/bin/env bun

import {
  type ClaudeApiRequest,
  claudeApiRequestSchema,
} from "./types/claude-session-schema";

interface LLMProxyRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  claudeRequestData?: ClaudeApiRequest;
}

interface LLMProxyResponse {
  status: number;
  headers: Record<string, string>;
  body?: string | ReadableStream;
}

interface LLMTransport {
  forward(request: LLMProxyRequest): Promise<LLMProxyResponse>;
}

interface LLMProxyMiddleware {
  processRequest?(request: LLMProxyRequest): Promise<LLMProxyRequest>;
  processResponse?(response: LLMProxyResponse): Promise<LLMProxyResponse>;
}

class HttpTransport implements LLMTransport {
  constructor(private baseUrl: string) {}

  async forward(req: LLMProxyRequest): Promise<LLMProxyResponse> {
    const targetUrl = `${this.baseUrl}${req.url}`;

    console.log(`🔄 Forwarding ${req.method} to ${targetUrl}`);

    try {
      const forwardHeaders = { ...req.headers };
      const urlParts = new URL(this.baseUrl);
      forwardHeaders.host = urlParts.host;

      const response = await fetch(targetUrl, {
        method: req.method,
        headers: forwardHeaders,
        body: req.body,
      });

      console.log(`📥 Response: ${response.status}`);

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      const isStreaming =
        responseHeaders["content-type"]?.includes("text/event-stream") ||
        responseHeaders["transfer-encoding"] === "chunked";

      return {
        status: response.status,
        headers: responseHeaders,
        body: isStreaming ? response.body || undefined : await response.text(),
      };
    } catch (error) {
      console.error(`❌ Fetch error to ${targetUrl}:`, error);
      throw error;
    }
  }
}

// =============================================================================
// Built-in Middleware
// =============================================================================

class LoggingMiddleware implements LLMProxyMiddleware {
  async processRequest(req: LLMProxyRequest): Promise<LLMProxyRequest> {
    const timestamp = new Date().toISOString();
    console.log(`🔀 [${timestamp}] ${req.method} ${req.url}`);

    if (req.body) {
      if (req.claudeRequestData) {
        const { model, max_tokens, stream } = req.claudeRequestData;
        const messageCount = req.claudeRequestData.messages?.length || 0;
        console.log(
          `🔀 [${timestamp}] claude Request: model=${model}, messages=${messageCount}, max_tokens=${max_tokens}, stream=${stream}`
        );
      } else {
        const truncatedBody =
          req.body.length > 500
            ? `${req.body.substring(0, 500)}...[truncated]`
            : req.body;
        console.log(`Body:`, truncatedBody);
      }
    }
    console.log("---");
    return req;
  }

  async processResponse(res: LLMProxyResponse): Promise<LLMProxyResponse> {
    const timestamp = new Date().toISOString();
    console.log(`🔀 [${timestamp}] Response: ${res.status}`);
    console.log("---");
    return res;
  }
}

// sample middleware that actually does something

export class DoubleMaxTokens implements LLMProxyMiddleware {
  async processRequest(req: LLMProxyRequest): Promise<LLMProxyRequest> {
    if (req.claudeRequestData?.max_tokens) {
      const originalMaxTokens = req.claudeRequestData.max_tokens;
      req.claudeRequestData.max_tokens = originalMaxTokens * 2;

      console.log(
        `🔢 MaxTokens doubled: ${originalMaxTokens} → ${req.claudeRequestData.max_tokens}`
      );

      // Update the body with the modified request data
      req.body = JSON.stringify(req.claudeRequestData);
    }

    return req;
  }
}

// =============================================================================
// Proxy Class
// =============================================================================

class LLMProxy {
  private middleware: LLMProxyMiddleware[] = [];

  constructor(
    public transport: LLMTransport,
    middleware: LLMProxyMiddleware[] = []
  ) {
    this.middleware = middleware;
  }

  addMiddleware(middleware: LLMProxyMiddleware): void {
    this.middleware.push(middleware);
  }

  async processRequest(request: Request, pathname: string): Promise<Response> {
    try {
      // Convert Request to ProxyRequest
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });

      const body =
        request.method !== "GET" && request.method !== "HEAD"
          ? await request.text()
          : undefined;

      let claudeRequestData: ClaudeApiRequest | undefined;

      if (body) {
        try {
          // let's go for a gentle parse here - never know what might come in
          const { success, data } = claudeApiRequestSchema.safeParse(
            JSON.parse(body)
          );
          if (!success) {
            console.warn("Unrecognizable Claude API request body:", body);
          } else {
            claudeRequestData = data;
          }
        } catch (error) {
          // just in case the body is not valid JSON or smth
          console.warn("Failed to parse Claude API request body:", body, error);
        }
      }

      let proxyReq: LLMProxyRequest = {
        method: request.method,
        url: pathname,
        headers,
        body,
        claudeRequestData,
      };

      // Apply request middleware
      for (const middleware of this.middleware) {
        if (middleware.processRequest) {
          proxyReq = await middleware.processRequest(proxyReq);
        }
      }

      // Forward request through transport
      let proxyRes = await this.transport.forward(proxyReq);

      // Apply response middleware
      for (const middleware of [...this.middleware].reverse()) {
        if (middleware.processResponse) {
          proxyRes = await middleware.processResponse(proxyRes);
        }
      }

      return new Response(proxyRes.body, {
        status: proxyRes.status,
        headers: proxyRes.headers,
      });
    } catch (error) {
      console.error("Proxy processing error:", error);
      return new Response("Proxy Error", { status: 500 });
    }
  }
}

export function createPassthroughProxy(
  {
    proxyToUrl,
    enableLogging,
  }: { proxyToUrl: string; enableLogging: boolean } = {
    proxyToUrl: "https://api.anthropic.com",
    enableLogging: true,
  }
): LLMProxy {
  const middleware = [...(enableLogging ? [new LoggingMiddleware()] : [])];

  return new LLMProxy(new HttpTransport(proxyToUrl), middleware);
}

// =============================================================================
// Proxy Runner
// =============================================================================

export class BunProxyRunner {
  private server?: Bun.Server;

  constructor(
    private proxy: "passthrough",
    private port: number,
    private proxyToUrl: string
  ) {}

  get proxyUrl(): string {
    return `http://localhost:${this.port}`;
  }

  start(): string {
    if (this.proxy !== "passthrough") {
      throw new Error(
        "Unsupported proxy type. Only 'passthrough' is supported."
      );
    }

    const proxy = createPassthroughProxy({
      proxyToUrl: this.proxyToUrl,
      enableLogging: true,
    });

    this.server = Bun.serve({
      port: this.port,
      async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const pathname = url.pathname + url.search;

        // Health check endpoint
        if (pathname === "/health" || pathname === "/") {
          return new Response("Generic Proxy OK", {
            status: 200,
            headers: { "Content-Type": "text/plain" },
          });
        }

        return proxy.processRequest(request, pathname);
      },
    });

    const proxyUrl = `http://localhost:${this.port}`;

    console.log(`🚀 LLM Proxy running on port ${this.port}`);
    console.log(`   Health check: ${proxyUrl}/health`);

    return proxyUrl;
  }

  stop(): void {
    if (this.server) {
      this.server.stop();
      console.log("🛑 Proxy server stopped");
    }
  }
}
