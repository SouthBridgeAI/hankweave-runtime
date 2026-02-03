import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadCodonSequence, validateHank } from "../../server/config";
import type { Codon, Loop } from "../../server/types/types";
import { Logger } from "../../server/utils";

/**
 * Tests for extension configuration (exhaustWithPrompt, maxExtensions).
 *
 * Note: validateHank() requires ANTHROPIC_API_KEY environment variable.
 * Tests using validateHank are marked with skipUnlessApiKey.
 */
describe("Extension Configuration", () => {
  const tempDir = path.resolve("tests", "test-area", "temp-extension-config-test");
  const configPath = path.join(tempDir, "extension-config.json");
  const projectPath = path.join(tempDir, "project");
  let testLogger: Logger;

  const skipUnlessApiKey = process.env.ANTHROPIC_API_KEY ? test : test.skip;

  beforeEach(() => {
    // Clean up and create temp directories
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tempDir, { recursive: true });
    fs.mkdirSync(projectPath, { recursive: true });

    testLogger = new Logger("/dev/null");
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Helper to write config file in correct hank format
  const writeConfig = (codons: unknown[]) => {
    const hankFile = { hank: codons };
    fs.writeFileSync(configPath, JSON.stringify(hankFile, null, 2));
  };

  // Helper to create a prompt file
  const createPromptFile = (name: string, content: string) => {
    const filePath = path.join(tempDir, name);
    fs.writeFileSync(filePath, content);
    return filePath;
  };

  describe("exhaustWithPrompt validation", () => {
    test("accepts valid exhaustWithPrompt string", () => {
      const promptFile = createPromptFile("prompt.md", "Do something");
      const config = [
        {
          id: "extend-codon",
          name: "Extending Codon",
          model: "haiku",
          continuationMode: "fresh" as const,
          promptFile,
          exhaustWithPrompt: "Please continue",
        },
      ];
      writeConfig(config);

      const result = loadCodonSequence({ configPath });
      expect(result.codons[0].type).toBe("codon");
      expect((result.codons[0] as Codon).exhaustWithPrompt).toBe("Please continue");
    });

    test("accepts exhaustWithPrompt with maxExtensions", () => {
      const promptFile = createPromptFile("prompt.md", "Do something");
      const config = [
        {
          id: "extend-codon",
          name: "Extending Codon",
          model: "haiku",
          continuationMode: "fresh" as const,
          promptFile,
          exhaustWithPrompt: "Please continue",
          maxExtensions: 50,
        },
      ];
      writeConfig(config);

      const result = loadCodonSequence({ configPath });
      expect((result.codons[0] as Codon).maxExtensions).toBe(50);
    });

    test("validates maxExtensions must be positive integer", () => {
      const promptFile = createPromptFile("prompt.md", "Do something");
      const config = [
        {
          id: "extend-codon",
          name: "Extending Codon",
          model: "haiku",
          continuationMode: "fresh" as const,
          promptFile,
          exhaustWithPrompt: "Please continue",
          maxExtensions: 0, // Invalid
        },
      ];
      writeConfig(config);

      expect(() => loadCodonSequence({ configPath })).toThrow();
    });

    test("validates maxExtensions cannot be negative", () => {
      const promptFile = createPromptFile("prompt.md", "Do something");
      const config = [
        {
          id: "extend-codon",
          name: "Extending Codon",
          model: "haiku",
          continuationMode: "fresh" as const,
          promptFile,
          exhaustWithPrompt: "Please continue",
          maxExtensions: -1, // Invalid
        },
      ];
      writeConfig(config);

      expect(() => loadCodonSequence({ configPath })).toThrow();
    });

    test("uses default maxExtensions (100) when not specified", () => {
      const promptFile = createPromptFile("prompt.md", "Do something");
      const config = [
        {
          id: "extend-codon",
          name: "Extending Codon",
          model: "haiku",
          continuationMode: "fresh" as const,
          promptFile,
          exhaustWithPrompt: "Please continue",
        },
      ];
      writeConfig(config);

      const result = loadCodonSequence({ configPath });
      expect((result.codons[0] as Codon).maxExtensions).toBe(100);
    });
  });

  describe("post-extension continuation rule", () => {
    skipUnlessApiKey("codon after exhaustWithPrompt must be fresh", async () => {
      const promptFile = createPromptFile("prompt.md", "Do something");
      const config = [
        {
          id: "extend-codon",
          name: "Extending Codon",
          model: "haiku",
          continuationMode: "fresh" as const,
          promptFile,
          exhaustWithPrompt: "Please continue",
        },
        {
          id: "next-codon",
          name: "Next Codon",
          model: "haiku",
          continuationMode: "continue-previous" as const, // Invalid after exhaustWithPrompt
          promptFile,
        },
      ];
      writeConfig(config);

      await expect(
        validateHank({
          configPath,
          executionPath: projectPath,
          logger: testLogger,
        }),
      ).rejects.toThrow(
        /Cannot use continuationMode "continue-previous" after a codon with exhaustWithPrompt/,
      );
    });

    skipUnlessApiKey("codon after exhaustWithPrompt with fresh mode is valid", async () => {
      const promptFile = createPromptFile("prompt.md", "Do something");
      const config = [
        {
          id: "extend-codon",
          name: "Extending Codon",
          model: "haiku",
          continuationMode: "fresh" as const,
          promptFile,
          exhaustWithPrompt: "Please continue",
        },
        {
          id: "next-codon",
          name: "Next Codon",
          model: "haiku",
          continuationMode: "fresh" as const, // Valid
          promptFile,
        },
      ];
      writeConfig(config);

      // Should not throw
      await validateHank({
        configPath,
        executionPath: projectPath,
        logger: testLogger,
      });
    });
  });

  describe("exhaustWithPrompt with loops", () => {
    test("works inside loop codon", () => {
      const promptFile = createPromptFile("prompt.md", "Do something");
      const config = [
        {
          type: "loop" as const,
          id: "test-loop",
          name: "Test Loop",
          terminateOn: { type: "iterationLimit" as const, limit: 3 },
          codons: [
            {
              id: "extend-codon",
              name: "Extending Codon",
              model: "haiku",
              continuationMode: "fresh" as const,
              promptFile,
              exhaustWithPrompt: "Please continue",
            },
          ],
        },
      ];
      writeConfig(config);

      const result = loadCodonSequence({ configPath });
      expect(result.codons[0].type).toBe("loop");
      const loop = result.codons[0] as Loop;
      expect(loop.codons[0].exhaustWithPrompt).toBe("Please continue");
    });

    skipUnlessApiKey(
      "loop with exhaustWithPrompt last codon cannot be followed by continue-previous",
      async () => {
        const promptFile = createPromptFile("prompt.md", "Do something");
        const config = [
          {
            type: "loop" as const,
            id: "test-loop",
            name: "Test Loop",
            terminateOn: { type: "iterationLimit" as const, limit: 3 },
            codons: [
              {
                id: "extend-codon",
                name: "Extending Codon",
                model: "haiku",
                continuationMode: "fresh" as const,
                promptFile,
                exhaustWithPrompt: "Please continue",
              },
            ],
          },
          {
            id: "next-codon",
            name: "Next Codon",
            model: "haiku",
            continuationMode: "continue-previous" as const, // Invalid
            promptFile,
          },
        ];
        writeConfig(config);

        await expect(
          validateHank({
            configPath,
            executionPath: projectPath,
            logger: testLogger,
          }),
        ).rejects.toThrow(
          /Cannot use continuationMode "continue-previous" after a loop whose last codon has exhaustWithPrompt/,
        );
      },
    );
  });

  describe("codon without exhaustWithPrompt", () => {
    test("does not have exhaustWithPrompt set", () => {
      const promptFile = createPromptFile("prompt.md", "Do something");
      const config = [
        {
          id: "normal-codon",
          name: "Normal Codon",
          model: "haiku",
          continuationMode: "fresh" as const,
          promptFile,
        },
      ];
      writeConfig(config);

      const result = loadCodonSequence({ configPath });
      expect((result.codons[0] as Codon).exhaustWithPrompt).toBeUndefined();
    });

    test("still gets default maxExtensions", () => {
      const promptFile = createPromptFile("prompt.md", "Do something");
      const config = [
        {
          id: "normal-codon",
          name: "Normal Codon",
          model: "haiku",
          continuationMode: "fresh" as const,
          promptFile,
        },
      ];
      writeConfig(config);

      const result = loadCodonSequence({ configPath });
      // maxExtensions has a default even without exhaustWithPrompt
      expect((result.codons[0] as Codon).maxExtensions).toBe(100);
    });
  });
});
