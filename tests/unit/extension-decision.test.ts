import { describe, expect, test } from "bun:test";
import { type ExtensionConfig, shouldExtendCodon } from "../../server/codon-runner";

/**
 * Failure reasons that prevent extension (mirrors CodonRunner's internal type)
 */
type FailureReason =
  | { type: "timeout"; retriable: boolean }
  | { type: "rate-limit"; retriable: boolean }
  | { type: "api-error"; retriable: boolean }
  | { type: "unknown"; retriable: boolean };

/**
 * Tests for the shouldExtendCodon() function.
 * This function determines whether a codon should extend after completion.
 */
describe("shouldExtendCodon", () => {
  // Helper to create default extension config
  const defaultExtensionConfig = (): ExtensionConfig => ({
    exhaustWithPrompt: "Please continue",
    maxExtensions: 100,
  });

  // Helper to create default params
  const defaultParams = () => ({
    exitCode: 0,
    resultMessageReceived: true,
    isContextExceeded: false,
    extensionConfig: defaultExtensionConfig() as ExtensionConfig | undefined,
    extensionCount: 0,
    isInterrupted: false,
    failureReason: undefined as FailureReason | undefined,
  });

  describe("successful extension conditions", () => {
    test("returns true when all conditions are met", () => {
      const params = defaultParams();
      expect(shouldExtendCodon(params)).toBe(true);
    });

    test("returns true when extension count is below max", () => {
      const params = {
        ...defaultParams(),
        extensionCount: 50,
        extensionConfig: { exhaustWithPrompt: "Continue", maxExtensions: 100 },
      };
      expect(shouldExtendCodon(params)).toBe(true);
    });
  });

  describe("no extension config", () => {
    test("returns false when extensionConfig is undefined", () => {
      const params = { ...defaultParams(), extensionConfig: undefined };
      expect(shouldExtendCodon(params)).toBe(false);
    });
  });

  describe("user interruption", () => {
    test("returns false when interrupted", () => {
      const params = { ...defaultParams(), isInterrupted: true };
      expect(shouldExtendCodon(params)).toBe(false);
    });
  });

  describe("max extensions reached", () => {
    test("returns false when extension count equals max", () => {
      const params = {
        ...defaultParams(),
        extensionCount: 100,
        extensionConfig: { exhaustWithPrompt: "Continue", maxExtensions: 100 },
      };
      expect(shouldExtendCodon(params)).toBe(false);
    });

    test("returns false when extension count exceeds max", () => {
      const params = {
        ...defaultParams(),
        extensionCount: 101,
        extensionConfig: { exhaustWithPrompt: "Continue", maxExtensions: 100 },
      };
      expect(shouldExtendCodon(params)).toBe(false);
    });

    test("returns true at extensionCount = maxExtensions - 1", () => {
      const params = {
        ...defaultParams(),
        extensionCount: 99,
        extensionConfig: { exhaustWithPrompt: "Continue", maxExtensions: 100 },
      };
      expect(shouldExtendCodon(params)).toBe(true);
    });
  });

  describe("exit conditions", () => {
    test("returns false when exit code is non-zero", () => {
      const params = { ...defaultParams(), exitCode: 1 };
      expect(shouldExtendCodon(params)).toBe(false);
    });

    test("returns false when exit code is signal (137)", () => {
      const params = { ...defaultParams(), exitCode: 137 };
      expect(shouldExtendCodon(params)).toBe(false);
    });

    test("returns false when exit code is signal (143)", () => {
      const params = { ...defaultParams(), exitCode: 143 };
      expect(shouldExtendCodon(params)).toBe(false);
    });

    test("returns false when result message not received", () => {
      const params = { ...defaultParams(), resultMessageReceived: false };
      expect(shouldExtendCodon(params)).toBe(false);
    });

    test("returns false when context is exceeded", () => {
      const params = { ...defaultParams(), isContextExceeded: true };
      expect(shouldExtendCodon(params)).toBe(false);
    });
  });

  describe("failure reasons", () => {
    test("returns false when timeout failure", () => {
      const params = {
        ...defaultParams(),
        failureReason: { type: "timeout", retriable: true } as FailureReason,
      };
      expect(shouldExtendCodon(params)).toBe(false);
    });

    test("returns false when rate-limit failure", () => {
      const params = {
        ...defaultParams(),
        failureReason: { type: "rate-limit", retriable: true } as FailureReason,
      };
      expect(shouldExtendCodon(params)).toBe(false);
    });

    test("returns false when api-error failure", () => {
      const params = {
        ...defaultParams(),
        failureReason: { type: "api-error", retriable: false } as FailureReason,
      };
      expect(shouldExtendCodon(params)).toBe(false);
    });

    test("returns false when unknown failure", () => {
      const params = {
        ...defaultParams(),
        failureReason: { type: "unknown", retriable: false } as FailureReason,
      };
      expect(shouldExtendCodon(params)).toBe(false);
    });
  });

  describe("edge cases", () => {
    test("returns false when exit code 0 but result not received", () => {
      // This can happen if the process exits cleanly but we didn't get the final message
      const params = { ...defaultParams(), exitCode: 0, resultMessageReceived: false };
      expect(shouldExtendCodon(params)).toBe(false);
    });

    test("returns false when clean exit but failure reason set", () => {
      // Timeout might set failure reason even though exit was clean
      const params = {
        ...defaultParams(),
        exitCode: 0,
        resultMessageReceived: true,
        failureReason: { type: "timeout", retriable: true } as FailureReason,
      };
      expect(shouldExtendCodon(params)).toBe(false);
    });
  });
});
