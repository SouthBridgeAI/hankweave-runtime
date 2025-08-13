import { type ClaudeApiRequest, claudeApiRequestSchema } from "./types/claude-session-schema";
import type { Logger } from "./utils.js";

/**
 * Represents an incoming request to the LLM proxy
 */
export interface LLMProxyRequest {
  /** HTTP method (GET, POST, etc.) */
  method: string;
  /** Request URL path and query parameters */
  url: string;
  /** HTTP headers as key-value pairs */
  headers: Record<string, string>;
  /** Request body content */
  body?: string;
  /** Parsed Claude API request data if the body contains a valid Claude request */
  claudeRequestData?: ClaudeApiRequest;
}

/**
 * LLMProxyRequest without the body field, used in middleware processing. Body is removed to avoid temptation to modify it directly.
 */
type LLMProxyRequestWithoutBody = Omit<LLMProxyRequest, "body">;

/**
 * Represents a response from the LLM proxy
 */
export interface LLMProxyResponse {
  /** HTTP status code */
  status: number;
  /** Response headers as key-value pairs */
  headers: Record<string, string>;
  /** Response body, either as string or streaming data */
  body?: string | ReadableStream;
}

/**
 * Interface for transport layers that handle forwarding requests to the target LLM service
 */
export interface LLMTransport {
  /**
   * Forward a proxy request to the target service
   * @param request - The request to forward
   * @returns Promise resolving to the response from the target service
   */
  forward(request: LLMProxyRequest): Promise<LLMProxyResponse>;
}

/**
 * Abstract base class for LLM proxy middleware
 *
 * Middleware can intercept and modify requests passing through the proxy.
 * Subclasses should override handleRequest and/or handleResponse to implement custom logic.
 */
abstract class LLMProxyMiddleware {
  /**
   * Handle incoming request processing
   * @param request - The request without body field
   * @param body - The request body as string
   * @returns Promise resolving to the processed request
   */
  protected async handleRequest(
    request: LLMProxyRequestWithoutBody,
    _body?: string,
  ): Promise<LLMProxyRequestWithoutBody> {
    return request;
  }

  /**
   * Handle outgoing response processing
   * @param response - The response to process
   * @returns Promise resolving to the processed response
   */
  protected async handleResponse(response: LLMProxyResponse): Promise<LLMProxyResponse> {
    return response;
  }

  /**
   * Process a request through this middleware
   * @param request - The complete request to process
   * @returns Promise resolving to the processed request
   */
  public async processRequest(request: LLMProxyRequest): Promise<LLMProxyRequest> {
    // let's make sure we can't modify body and Claude request data in different ways
    // middleware can only modify underlying claudeRequestData (when present)
    // any change to the to object will be synced back to the body
    const { body, ...requestWithoutBody } = request;
    const r = await this.handleRequest(requestWithoutBody, body);
    return Object.assign({}, r, {
      body: r.claudeRequestData ? JSON.stringify(r.claudeRequestData) : request.body,
    });
  }

  /**
   * Process a response through this middleware
   * @param response - The response to process
   * @returns Promise resolving to the processed response
   */
  public async processResponse(response: LLMProxyResponse): Promise<LLMProxyResponse> {
    return this.handleResponse(response);
  }
}

/**
 * HTTP transport implementation for forwarding requests to external LLM services
 */
class HttpTransport implements LLMTransport {
  /**
   * Create a new HTTP transport
   * @param baseUrl - Base URL of the target LLM service
   * @param logger - Logger instance for debugging and monitoring
   */
  constructor(
    private baseUrl: string,
    public logger: Logger,
  ) {}

  /**
   * Forward a request to the target LLM service via HTTP
   * @param req - The proxy request to forward
   * @returns Promise resolving to the response from the target service
   */
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

      return {
        status: response.status,
        headers: responseHeaders,
        body: isStreaming ? response.body || undefined : await response.text(),
      };
    } catch (error) {
      this.logger.log(
        `[PROXY-HTTP-TRANSPORT] Failed to fetch from ${targetUrl}: ${error}`,
        "error",
      );
      throw error;
    }
  }
}

// =============================================================================
// Built-in Middleware
// =============================================================================

/**
 * Middleware that logs request and response information for debugging and monitoring
 */
class LoggingMiddleware extends LLMProxyMiddleware {
  /**
   * Create a new logging middleware
   * @param logger - Logger instance to use for output
   */
  constructor(private logger: Logger) {
    super();
  }

  /**
   * Log request details including Claude API parameters when available
   * @param req - The request without body
   * @param body - The request body
   * @returns Promise resolving to the unmodified request
   */
  override async handleRequest(
    req: LLMProxyRequestWithoutBody,
    body?: string,
  ): Promise<LLMProxyRequest> {
    this.logger.log(`[LOGGING-MIDDLEWARE] Received request ${req.method} ${req.url}`);

    if (body) {
      if (req.claudeRequestData) {
        const { model, max_tokens, stream } = req.claudeRequestData;
        const messageCount = req.claudeRequestData.messages?.length || 0;
        this.logger.log(
          `[LOGGING-MIDDLEWARE] Claude request - model=${model}, messages=${messageCount}, max_tokens=${max_tokens}, stream=${stream}`,
        );
      } else {
        const truncatedBody = body.length > 500 ? `${body.substring(0, 500)}...[truncated]` : body;
        this.logger.log(`[LOGGING-MIDDLEWARE] Request body: ${truncatedBody}`);
      }
    }

    this.logger.log("---");
    return req;
  }

  /**
   * Log response status information
   * @param res - The response to log
   * @returns Promise resolving to the unmodified response
   */
  override async handleResponse(res: LLMProxyResponse): Promise<LLMProxyResponse> {
    this.logger.log(`[LOGGING-MIDDLEWARE] Response status: ${res.status}`);
    this.logger.log("---");
    return res;
  }
}

/**
 * Sample middleware that doubles the max_tokens parameter in Claude API requests
 *
 * This is a demonstration middleware showing how to modify Claude request parameters.
 * In production, you might use similar patterns to implement token limits, cost controls, or other request modifications.
 */
export class DoubleMaxTokens extends LLMProxyMiddleware {
  /**
   * Modify the request to double the max_tokens parameter if present
   * @param req - The request to modify
   * @returns Promise resolving to the modified request
   */
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

/**
 * Main LLM proxy class that orchestrates request/response processing through middleware and transport
 *
 * The proxy processes requests through the following pipeline:
 * 1. Convert incoming Request to LLMProxyRequest
 * 2. Apply request middleware in order
 * 3. Forward request through transport layer
 * 4. Apply response middleware in order
 * 5. Return final Response
 */
export class LLMProxy {
  private middleware: LLMProxyMiddleware[] = [];

  /**
   * Create a new LLM proxy
   * @param transport - Transport layer for forwarding requests
   * @param middleware - Array of middleware to apply
   * @param logger - Logger instance for debugging
   * @param logMiddlewareCalls - Whether to log middleware calls (default: false)
   */
  constructor(
    public transport: LLMTransport,
    middleware: LLMProxyMiddleware[] = [],
    private logger: Logger,
    private logMiddlewareCalls: boolean = false,
  ) {
    this.middleware = middleware;
  }

  /**
   * Log the LLM proxy request for debugging
   * @param request - The LLM proxy request to log
   */
  logLLMProxyRequest = (request: LLMProxyRequest) => {
    const content = request.claudeRequestData
      ? JSON.stringify(request.claudeRequestData, null, 2)
      : request.body || "";

    this.logger.log(`[LLM-PROXY] ${request.method} ${request.url}\n\n${content}`, "debug");
  };

  /**
   * Add middleware to the processing pipeline
   * @param middleware - Middleware instance to add
   */
  addMiddleware(middleware: LLMProxyMiddleware): void {
    this.middleware.push(middleware);
  }

  /**
   * Remove a specific middleware instance from the pipeline
   * @param middleware - Middleware instance to remove
   * @returns True if middleware was found and removed, false otherwise
   */
  removeMiddleware(middleware: LLMProxyMiddleware): boolean {
    const index = this.middleware.indexOf(middleware);
    if (index === -1) {
      return false;
    }
    this.middleware.splice(index, 1);
    return true;
  }

  /**
   * Process an incoming HTTP request through the proxy pipeline
   * @param request - The incoming HTTP request
   * @param pathname - URL pathname and query parameters
   * @returns Promise resolving to the HTTP response
   */
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
            this.logger.log(`[LLM-PROXY] Unrecognizable Claude API request body: ${body}`, "debug");
          } else {
            claudeRequestData = data;
          }
        } catch (error) {
          // just in case the body is not valid JSON or something
          this.logger.log(
            `[LLM-PROXY] Failed to parse Claude API request body: ${body} - ${error}`,
            "debug",
          );
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
          const middlewareName = middleware.constructor.name;

          if (this.logMiddlewareCalls) {
            this.logger.log(`[LLM-PROXY] Applying request middleware: ${middlewareName}`);
            this.logLLMProxyRequest(proxyReq);
          }

          proxyReq = await middleware.processRequest(proxyReq);

          if (this.logMiddlewareCalls) {
            // TODO: maybe show diff here instead of dumping the whole request payload?
            this.logger.log(`[LLM-PROXY] ${middlewareName} middleware applied`);
            this.logLLMProxyRequest(proxyReq);
          }
        }
      }

      // Forward request through transport
      let proxyRes = await this.transport.forward(proxyReq);

      // Apply response middleware
      for (const middleware of this.middleware) {
        if (middleware.processResponse) {
          const middlewareName = middleware.constructor.name;

          // TODO: figure out how to log response body

          if (this.logMiddlewareCalls) {
            this.logger.log(`[LLM-PROXY] Applying response middleware: ${middlewareName}`);
          }

          proxyRes = await middleware.processResponse(proxyRes);

          if (this.logMiddlewareCalls) {
            this.logger.log(
              `[LLM-PROXY] After ${middlewareName} response middleware - status: ${proxyRes.status}`,
            );
          }
        }
      }

      return new Response(proxyRes.body, {
        status: proxyRes.status,
        headers: proxyRes.headers,
      });
    } catch (error) {
      this.logger.log(`[LLM-PROXY] Request processing error: ${error}`, "error");
      return new Response("Proxy Error", { status: 500 });
    }
  }
}

/**
 * Factory function to create a passthrough proxy with default logging middleware
 * @param config - Configuration object
 * @param config.proxyToUrl - Target URL to proxy requests to
 * @param config.logger - Logger instance for debugging and monitoring
 * @returns Configured LLMProxy instance with HTTP transport and logging middleware
 */
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

/**
 * Bun server runner for the LLM proxy
 *
 * Handles server lifecycle management and HTTP request routing for the proxy.
 * Currently supports only "passthrough" proxy mode.
 */
export class BunProxyRunner {
  private server?: Bun.Server;

  /**
   * Create a new Bun proxy runner
   * @param proxy - Proxy type, currently only "passthrough" is supported
   * @param port - Port number to listen on
   * @param proxyToUrl - Target URL to proxy requests to
   * @param logger - Logger instance for debugging and monitoring
   */
  constructor(
    private proxy: "passthrough",
    private port: number,
    private proxyToUrl: string,
    private logger: Logger,
  ) {}

  /**
   * Get the local proxy URL
   * @returns The URL where the proxy server is running
   */
  get proxyUrl(): string {
    return `http://localhost:${this.port}`;
  }

  /**
   * Start the proxy server
   * @returns The proxy URL where the server is listening
   * @throws Error if unsupported proxy type is used
   */
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
          return new Response("Tadpole Proxy OK", {
            status: 200,
            headers: { "Content-Type": "text/plain" },
          });
        }

        return proxy.processRequest(request, pathname);
      },
    });

    const proxyUrl = `http://localhost:${this.port}`;

    console.log(`BunProxyRunner: LLM Proxy server started on port ${this.port}`);
    console.log(`   Health check: ${proxyUrl}/health`);

    return proxyUrl;
  }

  /**
   * Stop the proxy server
   */
  stop(): void {
    if (this.server) {
      this.server.stop();
      console.log("BunProxyRunner: Proxy server stopped");
    }
  }
}
