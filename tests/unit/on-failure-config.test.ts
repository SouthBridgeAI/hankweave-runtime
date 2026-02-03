import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadCodonSequence } from "../../server/config";
import { LlmProviderRegistry } from "../../server/llm/llm-provider-registry";
import { Logger } from "../../server/utils";

// -------------
// Test Helpers
// -------------

const tempDir = path.resolve("tests", "test-area", "temp-on-failure-test");
const configPath = path.join(tempDir, "test-config.json");

const cleanup = (dir: string) => {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true });
  }
};

const writeHankConfig = (filePath: string, codons: unknown[]) => {
  const hankFile = { hank: codons };
  fs.writeFileSync(filePath, JSON.stringify(hankFile, null, 2));
};

const baseCodon = {
  id: "test",
  name: "Test",
  model: "sonnet",
  continuationMode: "fresh",
  promptText: "Test prompt",
};

// -------------
// Tests
// -------------

describe("onFailure configuration", () => {
  beforeAll(() => {
    const mockLogger = new Logger("/dev/null");
    LlmProviderRegistry.getInstance({
      logger: mockLogger,
      performHealthCheckOnInit: false,
    });
  });

  beforeEach(() => {
    cleanup(tempDir);
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  describe("onFailure field validation", () => {
    test("accepts 'abort' value", () => {
      writeHankConfig(configPath, [{ ...baseCodon, onFailure: "abort" }]);
      const result = loadCodonSequence({ configPath });
      expect(result.codons).toHaveLength(1);
      if (result.codons[0].type !== "loop") {
        expect(result.codons[0].onFailure).toBe("abort");
      }
    });

    test("accepts 'retry' value", () => {
      writeHankConfig(configPath, [{ ...baseCodon, onFailure: "retry" }]);
      const result = loadCodonSequence({ configPath });
      if (result.codons[0].type !== "loop") {
        expect(result.codons[0].onFailure).toBe("retry");
      }
    });

    test("accepts 'ignore' value", () => {
      writeHankConfig(configPath, [{ ...baseCodon, onFailure: "ignore" }]);
      const result = loadCodonSequence({ configPath });
      if (result.codons[0].type !== "loop") {
        expect(result.codons[0].onFailure).toBe("ignore");
      }
    });

    test("allows omitting onFailure (defaults handled in runtime)", () => {
      writeHankConfig(configPath, [baseCodon]);
      const result = loadCodonSequence({ configPath });
      if (result.codons[0].type !== "loop") {
        expect(result.codons[0].onFailure).toBeUndefined();
      }
    });

    test("rejects invalid onFailure values", () => {
      writeHankConfig(configPath, [{ ...baseCodon, onFailure: "invalid" }]);
      expect(() => loadCodonSequence({ configPath })).toThrow();
    });
  });

  describe("retryConfig validation", () => {
    test("accepts valid retryConfig with onFailure: retry", () => {
      writeHankConfig(configPath, [
        {
          ...baseCodon,
          onFailure: "retry",
          retryConfig: { maxAttempts: 5, delayMs: 2000 },
        },
      ]);
      const result = loadCodonSequence({ configPath });
      if (result.codons[0].type !== "loop") {
        expect(result.codons[0].retryConfig?.maxAttempts).toBe(5);
        expect(result.codons[0].retryConfig?.delayMs).toBe(2000);
      }
    });

    test("uses default values when retryConfig partially specified", () => {
      writeHankConfig(configPath, [
        {
          ...baseCodon,
          onFailure: "retry",
          retryConfig: { maxAttempts: 2 },
        },
      ]);
      const result = loadCodonSequence({ configPath });
      if (result.codons[0].type !== "loop") {
        expect(result.codons[0].retryConfig?.maxAttempts).toBe(2);
        expect(result.codons[0].retryConfig?.delayMs).toBe(1000); // default
      }
    });

    test("rejects retryConfig when onFailure is not retry", () => {
      writeHankConfig(configPath, [
        {
          ...baseCodon,
          onFailure: "abort",
          retryConfig: { maxAttempts: 3 },
        },
      ]);
      expect(() => loadCodonSequence({ configPath })).toThrow(
        /retryConfig can only be used when onFailure is 'retry'/,
      );
    });

    test("rejects retryConfig when onFailure is omitted", () => {
      writeHankConfig(configPath, [
        {
          ...baseCodon,
          retryConfig: { maxAttempts: 3 },
        },
      ]);
      expect(() => loadCodonSequence({ configPath })).toThrow(
        /retryConfig can only be used when onFailure is 'retry'/,
      );
    });

    test("rejects maxAttempts less than 1", () => {
      writeHankConfig(configPath, [
        {
          ...baseCodon,
          onFailure: "retry",
          retryConfig: { maxAttempts: 0 },
        },
      ]);
      expect(() => loadCodonSequence({ configPath })).toThrow();
    });

    test("rejects maxAttempts greater than 10", () => {
      writeHankConfig(configPath, [
        {
          ...baseCodon,
          onFailure: "retry",
          retryConfig: { maxAttempts: 11 },
        },
      ]);
      expect(() => loadCodonSequence({ configPath })).toThrow();
    });

    test("rejects negative delayMs", () => {
      writeHankConfig(configPath, [
        {
          ...baseCodon,
          onFailure: "retry",
          retryConfig: { delayMs: -1 },
        },
      ]);
      expect(() => loadCodonSequence({ configPath })).toThrow();
    });

    test("rejects delayMs greater than 60000", () => {
      writeHankConfig(configPath, [
        {
          ...baseCodon,
          onFailure: "retry",
          retryConfig: { delayMs: 60001 },
        },
      ]);
      expect(() => loadCodonSequence({ configPath })).toThrow();
    });

    test("accepts delayMs of 0", () => {
      writeHankConfig(configPath, [
        {
          ...baseCodon,
          onFailure: "retry",
          retryConfig: { delayMs: 0 },
        },
      ]);
      const result = loadCodonSequence({ configPath });
      if (result.codons[0].type !== "loop") {
        expect(result.codons[0].retryConfig?.delayMs).toBe(0);
      }
    });

    test("accepts maxAttempts of 1", () => {
      writeHankConfig(configPath, [
        {
          ...baseCodon,
          onFailure: "retry",
          retryConfig: { maxAttempts: 1 },
        },
      ]);
      const result = loadCodonSequence({ configPath });
      if (result.codons[0].type !== "loop") {
        expect(result.codons[0].retryConfig?.maxAttempts).toBe(1);
      }
    });

    test("accepts maxAttempts of 10", () => {
      writeHankConfig(configPath, [
        {
          ...baseCodon,
          onFailure: "retry",
          retryConfig: { maxAttempts: 10 },
        },
      ]);
      const result = loadCodonSequence({ configPath });
      if (result.codons[0].type !== "loop") {
        expect(result.codons[0].retryConfig?.maxAttempts).toBe(10);
      }
    });
  });

  describe("retryConfig with onFailure: ignore", () => {
    test("rejects retryConfig when onFailure is ignore", () => {
      writeHankConfig(configPath, [
        {
          ...baseCodon,
          onFailure: "ignore",
          retryConfig: { maxAttempts: 3 },
        },
      ]);
      expect(() => loadCodonSequence({ configPath })).toThrow(
        /retryConfig can only be used when onFailure is 'retry'/,
      );
    });
  });
});
