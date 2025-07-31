#!/usr/bin/env bun

const CLAUDE_API_BASE = "https://api.anthropic.com";
const PROXY_PORT = 5555;

interface ProxyRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body?: string | ReadableStream;
}

function obfuscateHeaders(headers: Record<string, string>): Record<string, string> {
  const obfuscated = { ...headers };

  // Obfuscate sensitive headers
  const sensitiveHeaders = ["authorization", "x-api-key", "api-key", "auth-token"];

  for (const key of Object.keys(obfuscated)) {
    if (sensitiveHeaders.includes(key.toLowerCase())) {
      const value = obfuscated[key];
      if (value && value.length > 8) {
        obfuscated[key] = `${value.substring(0, 4)}***${value.substring(value.length - 4)}`;
      } else {
        obfuscated[key] = "***";
      }
    }
  }

  return obfuscated;
}

function logRequest(req: ProxyRequest): void {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.url}`);
  console.log(`Headers:`, JSON.stringify(obfuscateHeaders(req.headers), null, 2));
  if (req.body) {
    const truncatedBody =
      req.body.length > 500 ? req.body.substring(0, 500) + "...[truncated]" : req.body;
    console.log(`Body:`, truncatedBody);
  }
  console.log("---");
}

function logResponse(res: ProxyResponse): void {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Response: ${res.status}`);
  console.log(`Headers:`, JSON.stringify(res.headers, null, 2));
  console.log("---");
}

async function forwardRequest(req: ProxyRequest): Promise<ProxyResponse> {
  const targetUrl = `${CLAUDE_API_BASE}${req.url}`;

  console.log(`🔄 Forwarding ${req.method} to ${targetUrl}`);

  try {
    const forwardHeaders = { ...req.headers };
    forwardHeaders.host = "api.anthropic.com";

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

const _server = Bun.serve({
  port: PROXY_PORT,
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname + url.search;

      if (pathname === "/health" || pathname === "/") {
        return new Response("Claude API Proxy OK", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      }

      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });

      const body =
        request.method !== "GET" && request.method !== "HEAD" ? await request.text() : undefined;

      const proxyReq: ProxyRequest = {
        method: request.method,
        url: pathname,
        headers,
        body,
      };

      logRequest(proxyReq);

      const proxyRes = await forwardRequest(proxyReq);

      logResponse(proxyRes);

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
      console.error("Proxy error:", error);
      return new Response("Proxy Error", { status: 500 });
    }
  },
});

console.log(`🔄 Claude API Proxy running on port ${PROXY_PORT}`);
console.log(`   Forwarding requests to: ${CLAUDE_API_BASE}`);
console.log(`   Access via: http://localhost:${PROXY_PORT}`);
