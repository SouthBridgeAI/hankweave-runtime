# LLM Proxy System

## Overview

The LLM Proxy system provides a flexible middleware-based architecture for intercepting and modifying requests to Large Language Model services. It operates as a transparent HTTP proxy that can inspect, transform, and log requests passing through to external LLM services like Claude's API.

The proxy is built around three core concepts: **Middleware** for request/response processing, **Transport** for forwarding requests, and the **Proxy** class that orchestrates the entire pipeline.

## Architecture

### Core Components

#### LLMProxyRequest and LLMProxyResponse

These interfaces define the standardized format for requests and responses within the proxy system:

```typescript
interface LLMProxyRequest {
  method: string;                    // HTTP method (GET, POST, etc.)
  url: string;                       // Request URL path and query parameters  
  headers: Record<string, string>;   // HTTP headers as key-value pairs
  body?: string;                     // Request body content
  claudeRequestData?: ClaudeApiRequest; // Parsed Claude API request if valid
}

interface LLMProxyResponse {
  status: number;                    // HTTP status code
  headers: Record<string, string>;   // Response headers as key-value pairs
  body?: string | ReadableStream;    // Response body (string or stream)
}
```

#### LLMTransport Interface

The transport layer handles the actual forwarding of requests to target LLM services:

```typescript
interface LLMTransport {
  forward(request: LLMProxyRequest): Promise<LLMProxyResponse>;
}
```

The built-in `HttpTransport` implementation forwards requests via HTTP to external services, automatically handling streaming responses and header management.

#### LLMProxyMiddleware Class

Middleware provides the extensibility mechanism for the proxy. The abstract base class defines the contract:

```typescript
abstract class LLMProxyMiddleware {
  protected async handleRequest(
    request: LLMProxyRequestWithoutBody,
    body?: string
  ): Promise<LLMProxyRequestWithoutBody>;

  protected async handleResponse(
    response: LLMProxyResponse
  ): Promise<LLMProxyResponse>;

  public async processRequest(request: LLMProxyRequest): Promise<LLMProxyRequest>;
  public async processResponse(response: LLMProxyResponse): Promise<LLMProxyResponse>;
}
```

**Key Design Features:**

- **Body Isolation**: Middleware receives the request body separately from the main request object to prevent accidental modification
- **Claude Request Data**: When the body contains valid Claude API JSON, it's parsed and made available as `claudeRequestData`
- **Automatic Sync**: Changes to `claudeRequestData` are automatically synchronized back to the request body
- **Method Override**: Subclasses override `handleRequest` and/or `handleResponse` for custom logic

### Built-in Middleware

#### LoggingMiddleware

Provides comprehensive logging of requests and responses for debugging and monitoring:

- Logs request method, URL, and parsed Claude API parameters (model, token limits, message counts)
- Truncates large request bodies to prevent log spam
- Logs response status codes
- Uses structured logging with `[LOGGING-MIDDLEWARE]` prefix

#### DoubleMaxTokens (Sample Middleware)

A demonstration middleware that doubles the `max_tokens` parameter in Claude API requests. This serves as an example for implementing:
- Token limits and controls
- Cost management features  
- Request parameter modifications

## Request Processing Pipeline

The proxy processes each request through a structured pipeline:

```
1. HTTP Request → LLMProxyRequest conversion
2. Request middleware processing (in order)
3. Transport layer forwarding
4. Response middleware processing (in order)  
5. Final HTTP Response
```

### Detailed Flow

1. **Request Conversion**: Incoming HTTP requests are converted to the internal `LLMProxyRequest` format, including header extraction and body parsing.

2. **Claude Request Parsing**: If the request body contains valid JSON matching the Claude API schema, it's parsed and made available as `claudeRequestData` for middleware processing.

3. **Middleware Chain**: Each middleware in the chain processes the request sequentially. Middleware can:
   - Modify headers and URL parameters
   - Transform Claude API parameters (model, tokens, messages, etc.)
   - Add logging, metrics, or authentication
   - Implement rate limiting or cost controls

4. **Transport Forwarding**: The `HttpTransport` forwards the processed request to the target LLM service, handling:
   - URL construction and host header updates
   - Streaming response detection
   - Error handling and retry logic

5. **Response Processing**: The response flows back through the middleware chain in the same order, allowing for:
   - Response logging and metrics
   - Content transformation
   - Error handling and fallbacks

## Usage Examples

### Creating a Passthrough Proxy

The simplest setup forwards all requests with basic logging:

```typescript
const proxy = createPassthroughProxy({
  proxyToUrl: "https://api.anthropic.com",
  logger: myLogger
});
```

### Custom Middleware Implementation

```typescript
class TokenLimitMiddleware extends LLMProxyMiddleware {
  constructor(private maxTokens: number) {
    super();
  }

  override async handleRequest(req: LLMProxyRequestWithoutBody): Promise<LLMProxyRequestWithoutBody> {
    if (req.claudeRequestData?.max_tokens > this.maxTokens) {
      req.claudeRequestData.max_tokens = this.maxTokens;
    }
    return req;
  }
}

// Usage
proxy.addMiddleware(new TokenLimitMiddleware(4000));
```

### Server Integration

The `ProxyRunner` class provides a complete HTTP server implementation:

```typescript
const runner = new ProxyRunner(
  "passthrough",           // Proxy type
  3001,                   // Port
  "https://api.anthropic.com", // Target URL
  logger                  // Logger instance  
);

const proxyUrl = runner.start(); // Returns "http://localhost:3001"
```

The server includes a health check endpoint at `/health` and routes all other requests through the proxy pipeline.

## Error Handling

The system includes comprehensive error handling:

- **Transport Errors**: Network failures, timeouts, and service errors are caught and logged
- **Parsing Errors**: Invalid JSON in request bodies is handled gracefully with debug logging
- **Middleware Errors**: Unhandled middleware errors result in 500 responses
- **Process Lifecycle**: Proper cleanup of resources and graceful shutdown

## Integration with Strandweave

Within the Strandweave system, the LLM proxy serves as an optional component for:

- **Request Monitoring**: Logging all Claude API interactions for debugging
- **Cost Tracking**: Intercepting requests to track token usage and costs
- **Request Modification**: Implementing organization-specific policies (token limits, model restrictions)
- **Development Testing**: Providing a local endpoint for development and testing

The proxy is automatically started by the `StrandweaveServer` when proxy functionality is enabled, creating a transparent layer between Claude processes and the external API.