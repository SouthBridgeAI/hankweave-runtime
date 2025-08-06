#!/usr/bin/env bun

import { type ClaudeApiRequest, claudeApiRequestSchema } from "./types/claude-session-schema";
import type { Logger } from "./utils.js";

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

abstract class LLMProxyMiddleware {
  protected async handleRequest(request: LLMProxyRequest): Promise<LLMProxyRequest> {
    return request;
  }
  protected async handleResponse(response: LLMProxyResponse): Promise<LLMProxyResponse> {
    return response;
  }

  public async processRequest(request: LLMProxyRequest): Promise<LLMProxyRequest> {
    const r = await this.handleRequest(request);
    if (r.claudeRequestData) {
      // Update in case claudeRequestData was modified
      r.body = JSON.stringify(r.claudeRequestData);
    }
    return r;
  }
  public async processResponse(response: LLMProxyResponse): Promise<LLMProxyResponse> {
    return this.handleResponse(response);
  }
}

class HttpTransport implements LLMTransport {
  constructor(
    private baseUrl: string,
    public logger: Logger,
  ) {}

  async forward(req: LLMProxyRequest): Promise<LLMProxyResponse> {
    const targetUrl = `${this.baseUrl}${req.url}`;

    this.logger.log(`🔄 Forwarding ${req.method} to ${targetUrl}`);

    try {
      const forwardHeaders = { ...req.headers };
      const urlParts = new URL(this.baseUrl);
      forwardHeaders.host = urlParts.host;

      const response = await fetch(targetUrl, {
        method: req.method,
        headers: forwardHeaders,
        body: req.body,
      });

      this.logger.log(`📥 Response: ${response.status}`);

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
      this.logger.log(`❌ Fetch error to ${targetUrl}: ${error}`, "error");
      throw error;
    }
  }
}

// =============================================================================
// Built-in Middleware
// =============================================================================

class LoggingMiddleware extends LLMProxyMiddleware {
  constructor(private logger: Logger) {
    super();
  }

  override async processRequest(req: LLMProxyRequest): Promise<LLMProxyRequest> {
    const timestamp = new Date().toISOString();
    const requestMessage = `🔀 [${timestamp}] ${req.method} ${req.url}`;

    this.logger.log(requestMessage);

    if (req.body) {
      if (req.claudeRequestData) {
        const { model, max_tokens, stream } = req.claudeRequestData;
        const messageCount = req.claudeRequestData.messages?.length || 0;
        const claudeMessage = `🔀 [${timestamp}] claude Request: model=${model}, messages=${messageCount}, max_tokens=${max_tokens}, stream=${stream}`;
        this.logger.log(claudeMessage);
      } else {
        const truncatedBody =
          req.body.length > 500 ? `${req.body.substring(0, 500)}...[truncated]` : req.body;
        const bodyMessage = `Body: ${truncatedBody}`;
        this.logger.log(bodyMessage);
      }
    }

    this.logger.log("---");
    return req;
  }

  override async processResponse(res: LLMProxyResponse): Promise<LLMProxyResponse> {
    this.logger.log(`🔀 [${new Date().toISOString()}] Response: ${res.status}`);
    this.logger.log("---");
    return res;
  }
}

// sample middleware that actually does something

export class DoubleMaxTokens extends LLMProxyMiddleware {
  override async handleRequest(req: LLMProxyRequest): Promise<LLMProxyRequest> {
    if (req.claudeRequestData?.max_tokens) {
      const originalMaxTokens = req.claudeRequestData.max_tokens;
      req.claudeRequestData.max_tokens = originalMaxTokens * 2;
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
    middleware: LLMProxyMiddleware[] = [],
    private logger: Logger,
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
        request.method !== "GET" && request.method !== "HEAD" ? await request.text() : undefined;

      let claudeRequestData: ClaudeApiRequest | undefined;

      if (body) {
        try {
          // let's go for a gentle parse here - never know what might come in
          const { success, data } = claudeApiRequestSchema.safeParse(JSON.parse(body));
          if (!success) {
            this.logger.log(`Unrecognizable Claude API request body: ${body}`, "debug");
          } else {
            claudeRequestData = data;
          }
        } catch (error) {
          // just in case the body is not valid JSON or something
          this.logger.log(`Failed to parse Claude API request body: ${body} - ${error}`, "debug");
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
          if (proxyReq.claudeRequestData) {
            // Update body if claudeRequestData was modified
            proxyReq.body = JSON.stringify(proxyReq.claudeRequestData);
          }
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
      this.logger.log(`Proxy processing error: ${error}`, "error");
      return new Response("Proxy Error", { status: 500 });
    }
  }
}

export function createPassthroughProxy({
  proxyToUrl,
  logger,
}: {
  proxyToUrl: string;
  logger: Logger;
}): LLMProxy {
  return new LLMProxy(
    new HttpTransport(proxyToUrl, logger),
    [new LoggingMiddleware(logger)],
    logger,
  );
}

// =============================================================================
// Proxy Runner
// =============================================================================

export class BunProxyRunner {
  private server?: Bun.Server;

  constructor(
    private proxy: "passthrough",
    private port: number,
    private proxyToUrl: string,
    private logger: Logger,
  ) {}

  get proxyUrl(): string {
    return `http://localhost:${this.port}`;
  }

  start(): string {
    if (this.proxy !== "passthrough") {
      throw new Error("Unsupported proxy type. Only 'passthrough' is supported.");
    }

    const proxy = createPassthroughProxy({
      proxyToUrl: this.proxyToUrl,
      logger: this.logger,
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
