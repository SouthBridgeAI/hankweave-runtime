/**
 * Custom error type for sentinel fatal errors that should trigger unloading
 */
export class SentinelFatalError extends Error {
  constructor(
    public readonly sentinelId: string,
    message: string,
    public readonly errorType: "configuration" | "corruption" | "resource" | "template",
    public readonly shouldUnload: boolean = true,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "SentinelFatalError";
  }
}
