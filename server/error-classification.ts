import type { FailureReason } from "./types/types.js";

/**
 * Pure decision core of the failure policy.
 *
 * - abort: retriable errors leave the server active for manual retry,
 *   permanent ones shut the run down.
 * - retry: retriable errors retry until maxAttempts is exhausted; permanent
 *   errors shut down immediately.
 * - ignore: always continue to the next codon.
 */
export function resolveFailureAction(params: {
  onFailure: "abort" | "retry" | "ignore";
  retriable: boolean;
  attempts: number;
  maxAttempts: number;
}): "shutdown" | "stay-active" | "retry" | "continue" {
  switch (params.onFailure) {
    case "abort":
      return params.retriable ? "stay-active" : "shutdown";
    case "retry":
      if (!params.retriable) return "shutdown";
      return params.attempts < params.maxAttempts ? "retry" : "shutdown";
    case "ignore":
      return "continue";
  }
}

/**
 * Upper bound on any single retry wait (computed backoff or provider
 * Retry-After): a long hint must not silently park an unattended run — better
 * to retry early and fail fast than to look hung.
 */
export const MAX_RETRY_DELAY_MS = 60_000;

/**
 * Largest Retry-After we treat as a real hint rather than noise. Values above
 * this are ignored entirely (rather than clamped) because a multi-hour window
 * means the run is not going to succeed within its retry budget anyway, and
 * clamping would misrepresent the provider's answer as "wait a minute".
 */
const MAX_PLAUSIBLE_RETRY_AFTER_MS = 3_600_000;

/**
 * Extract a provider-supplied retry delay from error text, in milliseconds.
 * No single form is canonical across providers, so this matches the common
 * surface shapes: header/JSON style (`retry-after: 30`, `"retry_after": 30`),
 * worded forms (`retry after 60s`, `try again in 2 minutes`), and millisecond
 * units (`retry after 500ms`).
 *
 * Bare header/JSON values are seconds (RFC 9110 delay-seconds), but only when
 * no word follows on the same line: an untranslated unit ("2 hours", "500
 * centiseconds") must yield NO hint rather than read the digits as seconds.
 * HTTP-date Retry-After is deliberately not parsed (needs a clock comparison;
 * a misparse is worse than falling back to backoff).
 *
 * Returns undefined when no plausible hint is present.
 */
export function parseRetryAfterMs(text: string): number | undefined {
  if (typeof text !== "string" || text.length === 0) return undefined;
  const lower = text.toLowerCase();

  // Ordered most-specific first: a unit-bearing match ("retry after 500ms")
  // must win over the bare-seconds header form, which would otherwise read
  // the same digits as 500 seconds.
  const patterns: Array<{ re: RegExp; unitMs: number }> = [
    // Key-suffixed millisecond forms (`retry-after-ms: 30000`, `retryAfterMs:
    // 30000` lowercased): the unit lives in the KEY, so none of the
    // value-suffixed patterns below can match them.
    { re: /retry[-_ ]?after[-_ ]?ms["'\s:]*(\d+(?:\.\d+)?)(?![.\d]|[,:/-]\d)/, unitMs: 1 },
    {
      re: /retry[-_ ]?after["'\s:]*(\d+(?:\.\d+)?)\s*(?:ms|msecs?|milliseconds?)\b/,
      unitMs: 1,
    },
    { re: /retry[-_ ]?after["'\s:]*(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?)\b/, unitMs: 1000 },
    { re: /retry[-_ ]?after["'\s:]*(\d+(?:\.\d+)?)\s*(?:m|min|mins|minutes?)\b/, unitMs: 60_000 },
    // Bare header/JSON value with no unit — delay-seconds per RFC 9110. The
    // trailing-word lookahead is same-line only ([ \t], not \s) so a following
    // header line in a multi-line dump doesn't disqualify a legitimate bare
    // value. The (?![.\d]) guard forces the capture to be the WHOLE number:
    // without it, rejecting "30h" backtracks to capture "3" with "0"
    // satisfying the not-a-letter check. [,:/-]\d rejects digits that continue
    // a larger token — "1,000" (thousands), "07:30" (clock time), "2026-07-30"
    // and "07/30" (dates) — whose leading group is not a duration; a separator
    // NOT followed by a digit (`"retry_after": 30, "code": ...`) stays valid.
    {
      re: /retry[-_ ]?after["'\s:]+(\d+(?:\.\d+)?)(?![.\d]|[,:/-]\d)(?![ \t]*[a-z])/,
      unitMs: 1000,
    },
    // Worded forms: "retry in 30s", "try again in 2 minutes", "wait 500ms".
    {
      re: /(?:retry|try again|wait)(?:\s+\w+){0,3}?\s+(\d+(?:\.\d+)?)\s*(?:ms|msecs?|milliseconds?)\b/,
      unitMs: 1,
    },
    {
      re: /(?:retry|try again|wait)(?:\s+\w+){0,3}?\s+(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?)\b/,
      unitMs: 1000,
    },
    {
      re: /(?:retry|try again|wait)(?:\s+\w+){0,3}?\s+(\d+(?:\.\d+)?)\s*(?:m|min|mins|minutes?)\b/,
      unitMs: 60_000,
    },
  ];

  for (const { re, unitMs } of patterns) {
    const match = re.exec(lower);
    if (!match?.[1]) continue;
    const value = Number.parseFloat(match[1]);
    if (!Number.isFinite(value) || value < 0) continue;
    const ms = Math.round(value * unitMs);
    // 0 is a legitimate "retry immediately"; only implausibly long waits are
    // discarded (see MAX_PLAUSIBLE_RETRY_AFTER_MS).
    if (ms > MAX_PLAUSIBLE_RETRY_AFTER_MS) return undefined;
    return ms;
  }

  return undefined;
}

/**
 * Compute how long to wait before a retry attempt.
 *
 * A provider-supplied Retry-After wins outright (it reflects the actual limit
 * window; backoff is a guess); otherwise exponential backoff
 * (`baseDelayMs * 2^attempts`). Both paths are clamped to maxDelayMs. No
 * random jitter: codons run sequentially within a run, so there is no
 * self-contended thundering herd, and a deterministic delay keeps retry
 * timing reproducible.
 *
 * @param attempts Retries already made (0 on the first retry).
 */
export function computeRetryDelayMs(params: {
  baseDelayMs: number;
  attempts: number;
  retryAfterMs?: number;
  maxDelayMs?: number;
}): number {
  const maxDelayMs = params.maxDelayMs ?? MAX_RETRY_DELAY_MS;
  const clamp = (ms: number): number => Math.max(0, Math.min(ms, maxDelayMs));

  if (params.retryAfterMs !== undefined && Number.isFinite(params.retryAfterMs)) {
    return clamp(params.retryAfterMs);
  }

  const base = Number.isFinite(params.baseDelayMs) ? Math.max(0, params.baseDelayMs) : 0;
  const attempts = Number.isFinite(params.attempts) ? Math.max(0, Math.floor(params.attempts)) : 0;
  // Cap the exponent before multiplying so a large attempts value cannot
  // overflow to Infinity on the way to the clamp.
  const factor = 2 ** Math.min(attempts, 30);
  return clamp(base * factor);
}

/**
 * AWS Bedrock failures that are permanent and operator-fixable, matched on
 * AWS's error names / SDK wordings (all AWS-idiomatic strings — collision
 * risk with other providers' error text is negligible). Remediation text is
 * appended to the classified message; AWS retired the console "Model access"
 * page (serverless models auto-enable on first invoke), so access problems
 * are IAM/SCP, the Anthropic use-case form, or Marketplace first-invoke.
 */
const BEDROCK_PERMANENT_FAILURES: Array<{
  matches: (lower: string) => boolean;
  remedy: string;
}> = [
  {
    // STS role assumption denied: often surfaced as bare "AccessDenied" (no
    // "Exception" suffix), e.g. "AccessDenied: User arn:… is not authorized
    // to perform: sts:AssumeRole on resource …" — no 403 in the text. Listed
    // before the generic AccessDeniedException matcher so an assume-role
    // denial gets the role remedy, not the model-access one.
    matches: (l) =>
      l.includes("sts:assumerole") && (l.includes("accessdenied") || l.includes("not authorized")),
    remedy:
      "The configured role can't be assumed. Check the profile's role_arn, the role's trust " +
      "policy (does it trust your source identity?), and any external_id/MFA requirement.",
  },
  {
    matches: (l) => l.includes("accessdeniedexception"),
    remedy:
      "AWS credentials can't invoke this model in this region. Check: (a) IAM policy / SCP " +
      "restrictions — cross-region 'us.' inference profiles need invoke permission on the " +
      "profile AND its underlying foundation models (simplest: allow bedrock:InvokeModel* on " +
      "Resource '*' for this principal); (b) first-time Anthropic use requires the use-case " +
      "form — open the model once in the Bedrock console playground; (c) Marketplace-served " +
      "models need one first invoke by a user with AWS Marketplace permissions.",
  },
  {
    matches: (l) =>
      l.includes("unrecognizedclientexception") ||
      l.includes("security token included in the request is invalid"),
    remedy:
      "AWS credentials are invalid. Check AWS_BEARER_TOKEN_BEDROCK / AWS_ACCESS_KEY_ID + " +
      "AWS_SECRET_ACCESS_KEY. Bedrock short-term API keys expire — generate a long-term key " +
      "(AWS Console → Bedrock → API keys).",
  },
  {
    // SigV4 signing failures surface the exception name or the SDK's stable
    // wording, with no HTTP status attached by pi.
    matches: (l) =>
      l.includes("invalidsignatureexception") ||
      l.includes("signaturedoesnotmatch") ||
      l.includes("signature we calculated does not match"),
    remedy:
      "Request signing failed — AWS_SECRET_ACCESS_KEY doesn't match AWS_ACCESS_KEY_ID (typo, " +
      "stale copy, or wrong account), or the system clock is badly skewed. Re-copy the secret " +
      "for this access key or generate a fresh key pair.",
  },
  {
    matches: (l) => l.includes("expiredtokenexception"),
    remedy:
      "AWS session credentials expired. Re-run `aws sso login --profile <profile>` (or " +
      "refresh your temporary credentials).",
  },
  {
    // Identity Center cache problems don't surface as ExpiredTokenException:
    // the SDK/CLI report "The SSO session token associated with profile=… was
    // not found or is invalid" (or "…has expired or is otherwise invalid").
    matches: (l) =>
      l.includes("sso session") &&
      (l.includes("not found") || l.includes("invalid") || l.includes("expired")),
    remedy:
      "The AWS SSO session for this profile is missing or expired. Re-run " +
      "`aws sso login --profile <profile>` to refresh the Identity Center token cache.",
  },
  {
    matches: (l) =>
      l.includes("could not load credentials") || l.includes("unable to locate credentials"),
    remedy:
      "No AWS credentials found. Quickest: set AWS_BEARER_TOKEN_BEDROCK (AWS Console → " +
      "Bedrock → API keys → long-term key). Enterprise: set AWS_PROFILE after `aws sso " +
      "login`, or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY. Also set AWS_REGION.",
  },
  {
    // pi-ai's applyAuth gate: thrown before any request when none of pi's
    // recognized AWS env markers is present. pi does not probe on-disk config
    // files or IMDS, so an env marker is required on the pi route.
    matches: (l) => l.includes("provider is not configured: amazon-bedrock"),
    remedy:
      "No AWS credentials visible to the embedded pi runtime. Set AWS_BEARER_TOKEN_BEDROCK " +
      "(AWS Console → Bedrock → API keys → long-term key), AWS_PROFILE after `aws sso login`, " +
      "or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY. Also set AWS_REGION. An on-disk default " +
      "profile or instance role alone is not detected on this route.",
  },
  {
    matches: (l) => /on-demand throughput isn.t supported/.test(l),
    remedy:
      "This model needs an inference profile on Bedrock. Prefix the model id with your " +
      "region group's cross-region profile prefix — 'us.', 'eu.', 'jp.', 'au.', or " +
      "'us-gov.' (e.g. amazon-bedrock/us.anthropic.claude-…) — or use a 'global.' profile " +
      "where available.",
  },
  {
    // AWS reports a wrong-region model as ResourceNotFoundException on some
    // paths and as ValidationException on others; pi surfaces the latter as
    // "Validation error: The provided model identifier is invalid" with no
    // exception name or HTTP status, so match the stable AWS wording too.
    matches: (l) =>
      l.includes("resourcenotfoundexception") ||
      l.includes("the provided model identifier is invalid"),
    remedy:
      "Model not found in this region. Set AWS_REGION to a region that serves it, or use " +
      "the 'global.' inference profile id.",
  },
];

/**
 * Classify API error text into a FailureReason with a retriability verdict —
 * the single source of truth for transient vs permanent.
 *
 * Policy:
 * - Billing/credit/quota, auth, and invalid-request (400) errors are
 *   permanent: retrying burns attempts on a hopeless request.
 * - Transport faults, timeouts, rate limits, and server-side errors (5xx,
 *   overloaded) are transient.
 * - Unrecognized text defaults to RETRIABLE (bounded by maxAttempts: a wrong
 *   "retriable" costs one extra attempt, a wrong "non-retriable" kills the
 *   run) — unless `opts.sessionEstablished` is false, in which case it is a
 *   local setup failure and NON-retriable. The known patterns above are
 *   unaffected by the gate.
 */
export function classifyApiErrorText(
  text: string,
  opts?: { sessionEstablished?: boolean },
): FailureReason {
  const errorText = typeof text === "string" && text.length > 0 ? text : "Unknown API error";
  const lower = errorText.toLowerCase();
  // Default true: existing single-arg callers keep the original retriable
  // fallback. Only callers that can prove non-establishment pass false.
  const sessionEstablished = opts?.sessionEstablished ?? true;

  // Status codes are matched on word boundaries so they don't false-match
  // inside larger numbers (e.g. "after 2400s" must not match 400).
  const hasCode = (code: string): boolean => new RegExp(`\\b${code}\\b`).test(lower);

  // Attached to every RETRIABLE verdict below; permanent verdicts omit it
  // (no retry to schedule). Text is the ONLY source: neither in-process SDK
  // surfaces structured Retry-After headers at this boundary. If one ever
  // does, add an explicit override here rather than scraping them into text.
  const retryAfterMs = parseRetryAfterMs(errorText);

  // --- Permanent failures (checked first: most specific signals) ---

  // Worded rate-limit signals win over the billing/quota match below: a
  // rate_limit_error that also mentions "quota" is a TRANSIENT rate limit, not
  // exhausted billing. A bare "429" stays ambiguous until after the billing
  // check (OpenAI returns 429 for permanent insufficient_quota too).
  const hasExplicitRateLimit =
    lower.includes("rate limit") || lower.includes("rate_limit") || lower.includes("rate-limit");
  if (hasExplicitRateLimit) {
    return {
      type: "rate-limit",
      retriable: true,
      message: `API rate limit: ${errorText}`,
      retryAfterMs,
    };
  }

  // Billing/credit/quota and provider usage-limit caps are permanent. The
  // usage-limit phrasings come from the non-Anthropic providers the embedded
  // Pi agent drives ("Monthly usage limit reached", "out of budget",
  // "available balance", camelCase *UsageLimitError names).
  const isBilling =
    lower.includes("credit") ||
    lower.includes("billing") ||
    lower.includes("insufficient") ||
    lower.includes("quota") ||
    lower.includes("available balance") ||
    lower.includes("out of budget") ||
    // "usage limit" (spaced) and "usagelimit" (camelCase error names lowercased)
    /usage\s?limit/.test(lower);
  if (isBilling) {
    return {
      type: "api-error",
      retriable: false,
      message: `API billing/usage error: ${errorText}`,
    };
  }

  // --- AWS Bedrock auth/access failures (pi's bedrock provider and the Agent
  // SDK's CLAUDE_CODE_USE_BEDROCK path both surface AWS's error names). These
  // carry no HTTP status code in the surfaced text, so without explicit
  // patterns they fall through to the transient fallback and get retried —
  // the worst outcome for problems only the operator can fix. Permanent, each
  // with a remediation hint (the fixes live in the AWS console/CLI, not here).
  // Checked BEFORE the timeout branch: AWS signature errors append the full
  // canonical request dump, whose header lines (x-stainless-timeout:600)
  // otherwise substring-match "timeout" and flip a permanently broken
  // credential chain into a retriable timeout. The matchers are specific
  // AWS wordings a genuine timeout message never contains.
  for (const { matches, remedy } of BEDROCK_PERMANENT_FAILURES) {
    if (matches(lower)) {
      return {
        type: "api-error",
        retriable: false,
        message: `Bedrock auth/access error: ${errorText} — ${remedy}`,
      };
    }
  }

  // Checked before the numeric status-code branches: "Request timed out after
  // 400 seconds" must classify as a timeout, not word-match hasCode("400")
  // into a permanent invalid request (or "401"/"403" durations into auth).
  const isTimeout = lower.includes("timeout") || lower.includes("timed out");
  if (isTimeout) {
    return {
      type: "timeout",
      retriable: true,
      message: errorText,
      retryAfterMs,
    };
  }

  const isAuth =
    hasCode("401") ||
    hasCode("403") ||
    lower.includes("authentication") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("api key") ||
    lower.includes("oauth");
  if (isAuth) {
    return {
      type: "api-error",
      retriable: false,
      message: `API auth error: ${errorText}`,
    };
  }

  // "prompt is too long" is the Claude SDK's normalization of Anthropic's
  // input-overflow 400 (status code stripped from the surfaced text). In a
  // `terminateOn: contextExceeded` loop this never applies: the
  // context-exceeded completion path preempts failure classification.
  // "ValidationException" / pi's "Validation error:" prefix are the request-
  // shape rejections Bedrock surfaces without a 400 in the text (e.g.
  // DeepSeek-R1's "Validation error: This model doesn't support tool use") —
  // permanently invalid requests that a retry can never fix.
  const isInvalidRequest =
    lower.includes("invalid_request") ||
    lower.includes("invalid request") ||
    lower.includes("validationexception") ||
    lower.includes("validation error:") ||
    lower.includes("prompt is too long") ||
    hasCode("400");
  if (isInvalidRequest) {
    return {
      type: "api-error",
      retriable: false,
      message: `API invalid request: ${errorText}`,
    };
  }

  // --- Transient failures ---

  // Bare "429" that survived the billing/quota check above: a plain
  // "Too Many Requests", transient.
  if (hasCode("429")) {
    return {
      type: "rate-limit",
      retriable: true,
      message: `API rate limit: ${errorText}`,
      retryAfterMs,
    };
  }

  // Transport faults are transient. Matched explicitly — not via the fallback
  // below — so they stay retriable even when no session was established: a
  // network outage at codon start is not a local setup failure. "unable to
  // connect" is the Pi agent's wording for a failed provider connection;
  // "fetch failed" is undici's generic network error.
  const isTransport =
    lower.includes("socket") ||
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("econnaborted") ||
    lower.includes("epipe") ||
    lower.includes("etimedout") ||
    lower.includes("enotfound") ||
    lower.includes("eai_again") ||
    lower.includes("unable to connect") ||
    lower.includes("fetch failed") ||
    lower.includes("connection reset") ||
    lower.includes("connection closed") ||
    lower.includes("connection error") ||
    (lower.includes("stream") && lower.includes("terminated")) ||
    lower.includes("network");
  if (isTransport) {
    return {
      type: "api-error",
      retriable: true,
      message: `API transport error: ${errorText}`,
      retryAfterMs,
    };
  }

  // Server-side 5xx / overloaded errors are transient; matched explicitly so
  // they survive the session-established gate on the fallback.
  const isServerError =
    hasCode("500") ||
    hasCode("502") ||
    hasCode("503") ||
    hasCode("504") ||
    hasCode("529") ||
    lower.includes("overloaded") ||
    lower.includes("internal server error") ||
    lower.includes("bad gateway") ||
    lower.includes("service unavailable");
  if (isServerError) {
    return {
      type: "api-error",
      retriable: true,
      message: `API server error: ${errorText}`,
      retryAfterMs,
    };
  }

  // Unrecognized error text: retriable by default, but a process that died
  // before its first message with text matching no known transient signal is a
  // local setup failure (bad executable, spawn error, bad cwd) that retrying
  // cannot fix.
  if (sessionEstablished === false) {
    return {
      type: "api-error",
      retriable: false,
      message: `Local setup/process error (no session established): ${errorText}`,
    };
  }
  return {
    type: "api-error",
    retriable: true,
    message: `API error in result: ${errorText}`,
    retryAfterMs,
  };
}

/**
 * Synthesize a failure reason for a codon that ended FAILED without any
 * classified reason of its own (process exited with no result and no crash
 * text). Retriability follows classifyApiErrorText's session-establishment
 * gate: established → plausibly transient, RETRIABLE; never established →
 * local setup failure, NON-retriable (defaults to established when unknown).
 *
 * Returns undefined when the failure is owned by another mechanism:
 * force-stop (retrying would fight the user's intent) and context-exceeded
 * (the loop/termination logic owns that outcome).
 */
export function synthesizeMissingFailureReason(params: {
  isForceStopping: boolean;
  isContextExceeded: boolean;
  exitCode: number;
  sessionEstablished?: boolean;
}): FailureReason | undefined {
  if (params.isForceStopping) return undefined;
  if (params.isContextExceeded) return undefined;

  const sessionEstablished = params.sessionEstablished ?? true;
  return {
    type: "api-error",
    retriable: sessionEstablished !== false,
    message:
      sessionEstablished === false
        ? `Codon process exited before establishing a session (exit code ${params.exitCode})`
        : `Codon process exited without a result message (exit code ${params.exitCode})`,
  };
}
