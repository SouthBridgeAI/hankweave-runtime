#!/usr/bin/env bun

interface LLMProxyRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
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
  private obfuscateHeaders(
    headers: Record<string, string>
  ): Record<string, string> {
    const obfuscated = { ...headers };
    const sensitiveHeaders = [
      "authorization",
      "x-api-key",
      "api-key",
      "auth-token",
    ];

    for (const key of Object.keys(obfuscated)) {
      if (sensitiveHeaders.some((h) => h.toLowerCase() === key.toLowerCase())) {
        const value = obfuscated[key];
        if (value && value.length > 8) {
          obfuscated[key] = `${value.substring(0, 4)}***${value.substring(
            value.length - 4
          )}`;
        } else {
          obfuscated[key] = "***";
        }
      }
    }

    return obfuscated;
  }

  async processRequest(req: LLMProxyRequest): Promise<LLMProxyRequest> {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.url}`);
    console.log(
      `Headers:`,
      JSON.stringify(this.obfuscateHeaders(req.headers), null, 2)
    );
    if (req.body) {
      const truncatedBody =
        req.body.length > 500
          ? req.body.substring(0, 500) + "...[truncated]"
          : req.body;
      console.log(`Body:`, req.body);
    }
    console.log("---");
    return req;
  }

  async processResponse(res: LLMProxyResponse): Promise<LLMProxyResponse> {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] Response: ${res.status}`);
    console.log(`Headers:`, JSON.stringify(res.headers, null, 2));
    console.log("---");
    return res;
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

      let proxyReq: LLMProxyRequest = {
        method: request.method,
        url: pathname,
        headers,
        body,
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

      if (proxyRes.body instanceof ReadableStream) {
        return new Response(proxyRes.body, {
          status: proxyRes.status,
          headers: proxyRes.headers,
        });
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

// =============================================================================
// Proxy Runner
// =============================================================================

class BunProxyRunner {
  private server?: Bun.Server;

  constructor(private proxy: LLMProxy) {}

  start(port: number = 5555): void {
    const proxy = this.proxy;

    this.server = Bun.serve({
      port,
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

    console.log(`🚀 Generic Proxy running on port ${port}`);
    console.log(`   Health check: http://localhost:${port}/health`);
  }

  stop(): void {
    if (this.server) {
      this.server.stop();
      console.log("🛑 Proxy server stopped");
    }
  }
}

function createPassthroughProxy(
  {
    proxyToUrl,
    enableLogging,
  }: {
    proxyToUrl: string;
    enableLogging: boolean;
  } = { proxyToUrl: "https://api.anthropic.com", enableLogging: true }
): LLMProxy {
  return new LLMProxy(
    new HttpTransport(proxyToUrl),
    enableLogging ? [new LoggingMiddleware()] : []
  );
}

const proxyRunner = new BunProxyRunner(createPassthroughProxy());
proxyRunner.start(5555);

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n🔄 Shutting down proxy...");
  proxyRunner.stop();
  process.exit(0);
});
