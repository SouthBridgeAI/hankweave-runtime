import { describe, expect, test } from "bun:test";
import {
  classifyApiErrorText,
  resolveFailureAction,
  synthesizeMissingFailureReason,
} from "../../server/error-classification.js";

describe("classifyApiErrorText", () => {
  describe("transient errors are retriable", () => {
    const transientCases: Array<{
      name: string;
      text: string;
      expectedType: string;
    }> = [
      {
        name: "socket connection closed",
        text: "API Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
        expectedType: "api-error",
      },
      {
        name: "ECONNRESET",
        text: "read ECONNRESET",
        expectedType: "api-error",
      },
      { name: "EPIPE", text: "write EPIPE", expectedType: "api-error" },
      {
        name: "connection reset",
        text: "Connection reset by peer",
        expectedType: "api-error",
      },
      {
        // The embedded Pi agent's wording when it cannot reach a provider —
        // the exact text a Gemini codon produced during a live network outage
        // (2026-07-26, e2e-happy-path). Must classify as a transport fault,
        // not fall to the session-gated unknown bucket.
        name: "pi 'unable to connect' provider failure",
        text: "Unable to connect. Is the computer able to access the url?",
        expectedType: "api-error",
      },
      {
        // undici's generic network error under Bun/Node.
        name: "fetch failed",
        text: "TypeError: fetch failed",
        expectedType: "api-error",
      },
      {
        name: "DNS ENOTFOUND",
        text: "getaddrinfo ENOTFOUND generativelanguage.googleapis.com",
        expectedType: "api-error",
      },
      {
        name: "DNS EAI_AGAIN",
        text: "getaddrinfo EAI_AGAIN api.anthropic.com",
        expectedType: "api-error",
      },
      {
        name: "500 internal server error",
        text: "API Error: 500 Internal Server Error",
        expectedType: "api-error",
      },
      {
        name: "529 overloaded",
        text: "API Error: 529 overloaded_error: Overloaded",
        expectedType: "api-error",
      },
      {
        name: "stream error",
        text: "Stream terminated unexpectedly",
        expectedType: "api-error",
      },
      {
        name: "request timed out",
        text: "API Error: Request timed out.",
        expectedType: "timeout",
      },
      {
        name: "timeout with large number does not match 400",
        text: "Request timed out after 2400s",
        expectedType: "timeout",
      },
      {
        // A standalone duration would word-match hasCode("400") and be
        // misclassified as a permanent invalid request; the timeout check must
        // win so onFailure:"retry" is honored.
        name: "timeout with standalone 400 duration stays a timeout",
        text: "Request timed out after 400 seconds",
        expectedType: "timeout",
      },
      {
        name: "429 rate limit",
        text: "API Error: 429 rate_limit_error",
        expectedType: "rate-limit",
      },
      {
        name: "rate limit text",
        text: "Rate limit reached for requests",
        expectedType: "rate-limit",
      },
      {
        // A per-minute rate limit whose body also says "quota" must NOT be
        // swallowed by the broad billing/quota match — the worded rate-limit
        // signal wins.
        name: "429 rate_limit with per-minute quota wording",
        text: "API Error: 429 rate_limit_error: quota exceeded, retry after 60s",
        expectedType: "rate-limit",
      },
      {
        name: "unknown error text defaults to retriable",
        text: "Something completely unexpected happened",
        expectedType: "api-error",
      },
      { name: "empty text", text: "", expectedType: "api-error" },
    ];

    for (const { name, text, expectedType } of transientCases) {
      test(name, () => {
        const reason = classifyApiErrorText(text);
        expect(reason.retriable).toBe(true);
        expect(reason.type).toBe(expectedType as ReturnType<typeof classifyApiErrorText>["type"]);
        expect(reason.message).toBeDefined();
      });
    }
  });

  describe("permanent errors are not retriable", () => {
    const permanentCases: Array<{ name: string; text: string }> = [
      { name: "credit balance too low", text: "Credit balance is too low" },
      { name: "billing error", text: "API Error: billing issue detected" },
      {
        name: "insufficient credits",
        text: "Insufficient credits to complete request",
      },
      { name: "quota exceeded", text: "You exceeded your current quota" },
      { name: "insufficient_quota", text: "Error code: insufficient_quota" },
      {
        // OpenAI returns HTTP 429 for permanent quota exhaustion too; without a
        // worded rate-limit signal this must stay billing (permanent), not be
        // rescued by the bare-429 transient branch.
        name: "429 insufficient_quota (permanent, not a rate limit)",
        text: "Error code: 429 - insufficient_quota: You exceeded your current quota",
      },
      { name: "available balance", text: "Your available balance is $0.00" },
      {
        name: "out of budget",
        text: "Request rejected: you are out of budget",
      },
      { name: "monthly usage limit", text: "Monthly usage limit reached" },
      {
        name: "GoUsageLimitError (camelCase)",
        text: "GoUsageLimitError: plan exhausted",
      },
      { name: "FreeUsageLimitError (camelCase)", text: "FreeUsageLimitError" },
      { name: "401 unauthorized", text: "API Error: 401 Unauthorized" },
      { name: "403 forbidden", text: "API Error: 403 Forbidden" },
      {
        name: "authentication failure",
        text: "authentication_error: invalid x-api-key",
      },
      { name: "invalid api key", text: "API Error: invalid API key provided" },
      { name: "oauth failure", text: "OAuth token has expired" },
      {
        name: "400 invalid request",
        text: "API Error: 400 invalid_request_error",
      },
      {
        // The Claude SDK's normalization of Anthropic's input-overflow 400 —
        // the status code is stripped, so the wording itself must classify.
        // Retrying an over-long prompt fails identically. (In a terminateOn:
        // contextExceeded loop the completion path preempts this entirely.)
        name: "prompt is too long (input overflow, permanent)",
        text: "Prompt is too long",
      },
      {
        name: "invalid request text",
        text: "Invalid request: missing required field",
      },
    ];

    for (const { name, text } of permanentCases) {
      test(name, () => {
        const reason = classifyApiErrorText(text);
        expect(reason.retriable).toBe(false);
        expect(reason.type).toBe("api-error");
      });
    }
  });

  describe("message formatting", () => {
    test("billing errors keep the billing prefix used in runtime logs", () => {
      const reason = classifyApiErrorText("Credit balance is too low");
      expect(reason.message).toBe("API billing/usage error: Credit balance is too low");
    });

    test("unrecognized api errors keep the result prefix used in runtime logs", () => {
      // An error matching no known pattern, with a session established (default),
      // falls through to the retriable fallback and keeps the result prefix.
      const reason = classifyApiErrorText("API Error: something unexpected happened");
      expect(reason.message).toBe("API error in result: API Error: something unexpected happened");
    });

    test("transport faults get the transport prefix", () => {
      const reason = classifyApiErrorText(
        "API Error: The socket connection was closed unexpectedly",
      );
      expect(reason.message).toBe(
        "API transport error: API Error: The socket connection was closed unexpectedly",
      );
    });

    test("timeout messages are passed through verbatim", () => {
      const reason = classifyApiErrorText("API Error: Request timed out.");
      expect(reason.message).toBe("API Error: Request timed out.");
    });
  });
});

describe("classifyApiErrorText session-established gating", () => {
  test("unrecognized text + sessionEstablished:false -> non-retriable (local setup)", () => {
    const reason = classifyApiErrorText("spawn /bad/path/claude ENOENT", {
      sessionEstablished: false,
    });
    expect(reason).toMatchObject({ type: "api-error", retriable: false });
    expect(reason.message).toContain("no session established");
  });

  test("unrecognized text defaults to retriable when no opts (sessionEstablished defaults true)", () => {
    expect(classifyApiErrorText("spawn /bad/path/claude ENOENT")).toMatchObject({
      retriable: true,
    });
  });

  test("unrecognized text + sessionEstablished:true -> retriable (live conversation)", () => {
    expect(
      classifyApiErrorText("Claude Code process exited with code 1", {
        sessionEstablished: true,
      }),
    ).toMatchObject({ retriable: true });
  });

  test("known transient patterns stay retriable even when no session established", () => {
    // The gate only flips the UNKNOWN fallback. High-confidence transient signals
    // (server 5xx, socket/transport, 429) remain retriable regardless.
    expect(
      classifyApiErrorText("API Error: 500 Internal Server Error", {
        sessionEstablished: false,
      }),
    ).toMatchObject({ retriable: true });
    expect(
      classifyApiErrorText("API Error: The socket connection was closed unexpectedly", {
        sessionEstablished: false,
      }),
    ).toMatchObject({ retriable: true });
    expect(
      classifyApiErrorText("API Error: 429 Too Many Requests", {
        sessionEstablished: false,
      }),
    ).toMatchObject({ retriable: true });
    // A network outage at codon start fails BEFORE the session establishes.
    // Connection failures are transient regardless of session state — without
    // an explicit transport match, these would fall to the gated unknown
    // bucket and be classified permanent, silently bypassing onFailure:"retry".
    expect(
      classifyApiErrorText("Unable to connect. Is the computer able to access the url?", {
        sessionEstablished: false,
      }),
    ).toMatchObject({ retriable: true });
    expect(
      classifyApiErrorText("TypeError: fetch failed", {
        sessionEstablished: false,
      }),
    ).toMatchObject({ retriable: true });
  });

  test("known permanent patterns stay non-retriable regardless of session signal", () => {
    expect(
      classifyApiErrorText("Credit balance is too low", {
        sessionEstablished: true,
      }),
    ).toMatchObject({ retriable: false });
  });
});

describe("resolveFailureAction", () => {
  test("socket drop + onFailure=retry resolves to retry", () => {
    // The 2026-06-12 incident: analyze codon configured onFailure="retry",
    // retryConfig.maxAttempts=2, died on a socket drop with zero retries
    // because the error was classified non-retriable.
    const reason = classifyApiErrorText(
      "API Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
    );
    const action = resolveFailureAction({
      onFailure: "retry",
      retriable: reason.retriable,
      attempts: 0,
      maxAttempts: 2,
    });
    expect(action).toBe("retry");
  });

  test("retry: exhausted attempts shut down", () => {
    expect(
      resolveFailureAction({
        onFailure: "retry",
        retriable: true,
        attempts: 2,
        maxAttempts: 2,
      }),
    ).toBe("shutdown");
  });

  test("retry: permanent error shuts down immediately", () => {
    const reason = classifyApiErrorText("Credit balance is too low");
    expect(
      resolveFailureAction({
        onFailure: "retry",
        retriable: reason.retriable,
        attempts: 0,
        maxAttempts: 2,
      }),
    ).toBe("shutdown");
  });

  test("abort: retriable errors stay active, permanent ones shut down", () => {
    expect(
      resolveFailureAction({
        onFailure: "abort",
        retriable: true,
        attempts: 0,
        maxAttempts: 3,
      }),
    ).toBe("stay-active");
    expect(
      resolveFailureAction({
        onFailure: "abort",
        retriable: false,
        attempts: 0,
        maxAttempts: 3,
      }),
    ).toBe("shutdown");
  });

  test("ignore: always continues", () => {
    expect(
      resolveFailureAction({
        onFailure: "ignore",
        retriable: false,
        attempts: 0,
        maxAttempts: 3,
      }),
    ).toBe("continue");
  });
});

describe("synthesizeMissingFailureReason", () => {
  // The shim-generalization gap: every shim (gemini shim.ts:593, pi index.ts:452,
  // opencode shim.ts:462/486) can exit non-zero on an early/pre-init API error
  // WITHOUT emitting a result message. The Claude SDK can likewise crash without
  // a terminal result. Those exits reach handleCodonComplete with no classified
  // failure reason; without synthesis they default to {retriable:false} and
  // silently bypass onFailure:retry.

  test("non-zero exit with no result -> bounded-retriable api-error", () => {
    const reason = synthesizeMissingFailureReason({
      isForceStopping: false,
      isContextExceeded: false,
      exitCode: 1,
    });
    expect(reason).toMatchObject({ type: "api-error", retriable: true });
  });

  test("the synthesized reason flows through onFailure:retry to a retry", () => {
    const reason = synthesizeMissingFailureReason({
      isForceStopping: false,
      isContextExceeded: false,
      exitCode: 1,
    });
    expect(reason).toBeDefined();
    const action = resolveFailureAction({
      onFailure: "retry",
      retriable: reason?.retriable === true,
      attempts: 0,
      maxAttempts: 2,
    });
    expect(action).toBe("retry");
  });

  test("clean exit (code 0) with no result is still treated as retriable", () => {
    // exit 0 but no result message is anomalous (the process ended without
    // reporting an outcome) — treat as transient, not a silent success.
    const reason = synthesizeMissingFailureReason({
      isForceStopping: false,
      isContextExceeded: false,
      exitCode: 0,
    });
    expect(reason).toMatchObject({ retriable: true });
  });

  test("force-stop is intentional -> no synthesized reason (not retried)", () => {
    expect(
      synthesizeMissingFailureReason({
        isForceStopping: true,
        isContextExceeded: false,
        exitCode: 1,
      }),
    ).toBeUndefined();
  });

  test("context-exceeded is handled elsewhere -> no synthesized reason", () => {
    expect(
      synthesizeMissingFailureReason({
        isForceStopping: false,
        isContextExceeded: true,
        exitCode: 1,
      }),
    ).toBeUndefined();
  });

  test("exited before establishing a session -> non-retriable (local setup)", () => {
    const reason = synthesizeMissingFailureReason({
      isForceStopping: false,
      isContextExceeded: false,
      exitCode: 1,
      sessionEstablished: false,
    });
    expect(reason).toMatchObject({ type: "api-error", retriable: false });
    expect(reason?.message).toContain("before establishing a session");
  });

  test("exited after establishing a session -> retriable (transient)", () => {
    expect(
      synthesizeMissingFailureReason({
        isForceStopping: false,
        isContextExceeded: false,
        exitCode: 1,
        sessionEstablished: true,
      }),
    ).toMatchObject({ retriable: true });
  });
});

describe("classifyApiErrorText — AWS Bedrock failures are permanent with remediation", () => {
  const cases: Array<{ name: string; text: string; remedyMentions: string }> = [
    {
      name: "AccessDeniedException (model/region access)",
      text: "AccessDeniedException: You don't have access to the model with the specified model ID.",
      remedyMentions: "IAM policy",
    },
    {
      name: "UnrecognizedClientException (bad credentials)",
      text: "UnrecognizedClientException: The security token included in the request is invalid.",
      remedyMentions: "AWS_BEARER_TOKEN_BEDROCK",
    },
    {
      name: "ExpiredTokenException (stale SSO session)",
      text: "ExpiredTokenException: The security token included in the request is expired",
      remedyMentions: "aws sso login",
    },
    {
      name: "invalid/missing Identity Center session (SSO wording, no ExpiredTokenException)",
      text: "The SSO session token associated with profile=acme was not found or is invalid",
      remedyMentions: "aws sso login",
    },
    {
      name: "missing credentials entirely",
      text: "Could not load credentials from any providers",
      remedyMentions: "AWS_BEARER_TOKEN_BEDROCK",
    },
    {
      name: "pi applyAuth gate (no AWS env markers on the pi route)",
      text: "Provider is not configured: amazon-bedrock",
      remedyMentions: "AWS_BEARER_TOKEN_BEDROCK",
    },
    {
      name: "bare on-demand id needs an inference profile",
      text: "ValidationException: Invocation of model ID anthropic.claude-haiku-4-5-20251001-v1:0 with on-demand throughput isn't supported. Retry your request with the ID or ARN of an inference profile that contains this model.",
      remedyMentions: "us.",
    },
    {
      name: "ResourceNotFoundException (wrong region)",
      text: "ResourceNotFoundException: The provided model identifier is invalid.",
      remedyMentions: "AWS_REGION",
    },
    {
      name: "wrong region surfaced through pi's ValidationException prefix",
      text: "Validation error: The provided model identifier is invalid.",
      remedyMentions: "AWS_REGION",
    },
    {
      name: "InvalidSignatureException (wrong secret key)",
      text: "InvalidSignatureException: The request signature we calculated does not match the signature you provided. Check your AWS Secret Access Key and signing method.",
      remedyMentions: "AWS_SECRET_ACCESS_KEY",
    },
    {
      name: "SignatureDoesNotMatch wording without the exception name",
      text: "The request signature we calculated does not match the signature you provided.",
      remedyMentions: "AWS_SECRET_ACCESS_KEY",
    },
    {
      name: "STS assume-role denial (bare AccessDenied, no status)",
      text: "AccessDenied: User: arn:aws:iam::123456789012:user/dev is not authorized to perform: sts:AssumeRole on resource: arn:aws:iam::123456789012:role/bedrock-invoke",
      remedyMentions: "role_arn",
    },
    {
      name: "AccessDeniedException on sts:AssumeRole still gets the role remedy",
      text: "AccessDeniedException: not authorized to perform: sts:AssumeRole",
      remedyMentions: "trust",
    },
  ];

  for (const { name, text, remedyMentions } of cases) {
    test(`${name} → non-retriable with actionable message`, () => {
      const result = classifyApiErrorText(text, { sessionEstablished: true });
      expect(result.retriable).toBe(false);
      expect(result.type).toBe("api-error");
      expect(result.message).toContain(remedyMentions);
    });
  }

  test("a 'timed out' error mentioning bedrock still classifies as timeout, not permanent", () => {
    const result = classifyApiErrorText(
      "Request to bedrock-runtime.us-east-1.amazonaws.com timed out after 60 seconds",
      { sessionEstablished: true },
    );
    expect(result.type).toBe("timeout");
    expect(result.retriable).toBe(true);
  });

  test("Bedrock ThrottlingException stays transient (rate limiting, not auth)", () => {
    const result = classifyApiErrorText(
      "ThrottlingException: Too many requests, please wait before trying again.",
      { sessionEstablished: true },
    );
    expect(result.retriable).toBe(true);
  });

  test("signature error carrying AWS's canonical-string dump stays permanent despite embedded 'timeout' header text", () => {
    // Real shape from a live run: AWS appends the full canonical request to
    // SignatureDoesNotMatch, and its header lines include
    // "x-stainless-timeout:600" — which must NOT flip the classification to a
    // retriable timeout (it did: 4 wasted attempts on a hopeless secret).
    const text = [
      "Failed to authenticate. API Error: 403 The request signature we calculated does not match the signature you provided. Check your AWS Secret Access Key and signing method. Consult the service documentation for details.",
      "",
      "The Canonical String for this request should have been",
      "'POST",
      "/model/us.anthropic.claude-haiku-4-5-20251001-v1%3A0/invoke-with-response-stream",
      "host:bedrock-runtime.us-east-1.amazonaws.com",
      "x-stainless-timeout:600",
      "'",
    ].join("\n");
    const result = classifyApiErrorText(text, { sessionEstablished: true });
    expect(result.retriable).toBe(false);
    expect(result.type).toBe("api-error");
    expect(result.message).toContain("AWS_SECRET_ACCESS_KEY");
  });

  test("pi's bare Validation error prefix is a permanent invalid request (DeepSeek-R1 no tool use)", () => {
    const result = classifyApiErrorText("Validation error: This model doesn't support tool use.", {
      sessionEstablished: true,
    });
    expect(result.retriable).toBe(false);
    expect(result.type).toBe("api-error");
    expect(result.message).toContain("invalid request");
  });

  test("ValidationException without a 400 in the text is a permanent invalid request", () => {
    const result = classifyApiErrorText(
      "ValidationException: The value at inferenceConfig.maxTokens is invalid.",
      { sessionEstablished: true },
    );
    expect(result.retriable).toBe(false);
    expect(result.type).toBe("api-error");
  });
});
