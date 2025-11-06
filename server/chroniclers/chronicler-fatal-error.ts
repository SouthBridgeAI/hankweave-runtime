/**
 * Custom error type for chronicler fatal errors that should trigger unloading
 */
export class ChroniclerFatalError extends Error {
  constructor(
    public readonly chroniclerId: string,
    message: string,
    public readonly errorType: "configuration" | "corruption" | "resource" | "template",
    public readonly shouldUnload: boolean = true,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "ChroniclerFatalError";
  }
}
