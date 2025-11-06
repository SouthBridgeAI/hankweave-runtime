import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { createMockLlm } from "../utils/mock-llm.js";

describe("Mock LLM Utility", () => {
  describe("generateText", () => {
    it("should return text response with correct format", async () => {
      const mock = createMockLlm();
      const result = await mock.generateText({
        model: mock.mockModel,
        messages: [{ role: "user", content: "Test prompt" }],
      });

      expect(result.text).toContain("Mock response");
      expect(result.finishReason).toBe("stop");
      expect(result.usage.inputTokens).toBeGreaterThan(0);
      expect(result.usage.outputTokens).toBeGreaterThan(0);
    });

    it("should include input prompt in response", async () => {
      const mock = createMockLlm();
      const inputText = "Hello, world!";
      const result = await mock.generateText({
        model: mock.mockModel,
        messages: [{ role: "user", content: inputText }],
      });

      expect(result.text).toContain(inputText);
    });

    it("should handle empty messages array", async () => {
      const mock = createMockLlm();
      const result = await mock.generateText({
        model: mock.mockModel,
        messages: [],
        temperature: 0, // Explicit temperature for deterministic response
      });

      expect(result.text).toBe('Mock response for: ""');
      expect(result.finishReason).toBe("stop");
    });

    it("should handle system messages correctly", async () => {
      const mock = createMockLlm();
      const result = await mock.generateText({
        model: mock.mockModel,
        system: "You are a helpful assistant",
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(result.text).toContain("Hello");
      expect(result.finishReason).toBe("stop");
    });

    it("should simulate realistic timing", async () => {
      const mock = createMockLlm();
      const shortPrompt = "Hi";
      const longPrompt =
        "This is a much longer prompt that should take more time to process because it has many more characters and words in it";

      const shortStart = Date.now();
      await mock.generateText({
        model: mock.mockModel,
        messages: [{ role: "user", content: shortPrompt }],
      });
      const shortDuration = Date.now() - shortStart;

      const longStart = Date.now();
      await mock.generateText({
        model: mock.mockModel,
        messages: [{ role: "user", content: longPrompt }],
      });
      const longDuration = Date.now() - longStart;

      // Long prompt should take longer (with some tolerance for timing variations)
      expect(longDuration).toBeGreaterThanOrEqual(shortDuration);
    });
  });

  describe("streamText", () => {
    it("should stream text in chunks", async () => {
      const mock = createMockLlm();
      const result = mock.streamText({
        model: mock.mockModel,
        messages: [{ role: "user", content: "Test prompt" }],
      });

      const chunks: string[] = [];
      for await (const chunk of result.textStream) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.join("")).toContain("Mock stream response");
    });

    it("should resolve promises correctly", async () => {
      const mock = createMockLlm();
      const result = mock.streamText({
        model: mock.mockModel,
        messages: [{ role: "user", content: "Test prompt" }],
      });

      const [text, finishReason, usage] = await Promise.all([
        result.text,
        result.finishReason,
        result.usage,
      ]);

      expect(text).toContain("Mock stream response");
      expect(finishReason).toBe("stop");
      expect(usage.inputTokens).toBeGreaterThan(0);
      expect(usage.outputTokens).toBeGreaterThan(0);
    });

    it("should have consistent text between stream and promise", async () => {
      const mock = createMockLlm();
      const result = mock.streamText({
        model: mock.mockModel,
        messages: [{ role: "user", content: "Test prompt" }],
      });

      const streamedText = [];
      for await (const chunk of result.textStream) {
        streamedText.push(chunk);
      }

      const promiseText = await result.text;
      expect(streamedText.join("")).toBe(promiseText);
    });

    it("should handle empty input", async () => {
      const mock = createMockLlm();
      const result = mock.streamText({
        model: mock.mockModel,
        messages: [],
      });

      const chunks: string[] = [];
      for await (const chunk of result.textStream) {
        chunks.push(chunk);
      }

      expect(chunks.join("")).toBe('Mock stream response for: ""');
    });
  });

  describe("generateObject", () => {
    it("should generate schema-compliant objects", async () => {
      const schema = z.object({
        name: z.string(),
        age: z.number(),
        active: z.boolean(),
      });

      const mock = createMockLlm();
      const result = await mock.generateObject<z.infer<typeof schema>>({
        model: mock.mockModel,
        messages: [{ role: "user", content: "Generate a person" }],
        schema,
      });

      expect(result.object).toHaveProperty("name");
      expect(result.object).toHaveProperty("age");
      expect(result.object).toHaveProperty("active");
      expect(typeof result.object.name).toBe("string");
      expect(typeof result.object.age).toBe("number");
      expect(typeof result.object.active).toBe("boolean");
      expect(result.finishReason).toBe("stop");
    });

    it("should handle nested object schemas", async () => {
      const schema = z.object({
        user: z.object({
          name: z.string(),
          details: z.object({
            age: z.number(),
          }),
        }),
        tags: z.array(z.string()),
      });

      const mock = createMockLlm();
      const result = await mock.generateObject<z.infer<typeof schema>>({
        model: mock.mockModel,
        messages: [{ role: "user", content: "Generate a complex object" }],
        schema,
      });

      expect(result.object.user).toBeDefined();
      expect(result.object.user.name).toBeDefined();
      expect(result.object.user.details.age).toBeDefined();
      expect(result.object.tags).toBeInstanceOf(Array);
    });

    it("should support no-schema generation", async () => {
      const mock = createMockLlm();
      const result = await mock.generateObject({
        model: mock.mockModel,
        messages: [{ role: "user", content: "Generate anything" }],
        output: "no-schema",
      });

      expect(result.object).toBeDefined();
      expect(result.object).toHaveProperty("response");
      expect(result.object).toHaveProperty("timestamp");
      expect(result.finishReason).toBe("stop");
    });

    it("should handle enum schemas", async () => {
      const schema = z.object({
        status: z.enum(["active", "inactive", "pending"]),
        priority: z.number(),
      });

      const mock = createMockLlm();
      const result = await mock.generateObject<z.infer<typeof schema>>({
        model: mock.mockModel,
        messages: [{ role: "user", content: "Generate a status object" }],
        schema,
      });

      expect(result.object.status).toBe("active"); // First enum option
      expect(typeof result.object.priority).toBe("number");
    });

    it("should calculate usage tokens correctly", async () => {
      const mock = createMockLlm();
      const inputText = "Short";
      const result = await mock.generateObject({
        model: mock.mockModel,
        messages: [{ role: "user", content: inputText }],
        output: "no-schema",
      });

      expect(result.usage.inputTokens).toBe(inputText.length);
      expect(result.usage.outputTokens).toBe(JSON.stringify(result.object).length);
    });

    it("should handle array schemas", async () => {
      const schema = z.object({
        items: z.array(z.string()),
        count: z.number(),
      });

      const mock = createMockLlm();
      const result = await mock.generateObject<z.infer<typeof schema>>({
        model: mock.mockModel,
        messages: [{ role: "user", content: "Generate a list" }],
        schema,
      });

      expect(result.object.items).toBeInstanceOf(Array);
      expect(result.object.items.length).toBeGreaterThan(0);
      expect(typeof result.object.count).toBe("number");
    });
  });

  describe("Mock configuration and timing", () => {
    it("should accept and use configuration", () => {
      const config = {};
      const mock = createMockLlm(config);

      expect(mock.generateText).toBeInstanceOf(Function);
      expect(mock.streamText).toBeInstanceOf(Function);
      expect(mock.generateObject).toBeInstanceOf(Function);
      expect(mock.mockModel).toBeDefined();
    });

    it("should provide consistent timing behavior", async () => {
      const mock = createMockLlm();
      const prompt = "Test timing consistency";

      // Run multiple times to check consistency
      const times: number[] = [];
      for (let i = 0; i < 3; i++) {
        const start = Date.now();
        await mock.generateText({
          model: mock.mockModel,
          messages: [{ role: "user", content: prompt }],
        });
        times.push(Date.now() - start);
      }

      // All times should be within a reasonable range
      const minTime = Math.min(...times);
      const maxTime = Math.max(...times);
      const variance = maxTime - minTime;

      // Should have some variance due to random jitter but not too much
      expect(variance).toBeGreaterThan(0);
      expect(variance).toBeLessThan(200); // Allow up to 200ms variance
    });

    it("should handle concurrent requests properly", async () => {
      const mock = createMockLlm();

      const promises = Array.from({ length: 5 }, (_, i) =>
        mock.generateText({
          model: mock.mockModel,
          messages: [{ role: "user", content: `Request ${i}` }],
        }),
      );

      const results = await Promise.all(promises);

      expect(results).toHaveLength(5);
      results.forEach((result, i) => {
        expect(result.text).toContain(`Request ${i}`);
        expect(result.finishReason).toBe("stop");
      });
    });
  });

  describe("Error simulation capabilities", () => {
    describe("forceError configuration", () => {
      it("should throw forced error in generateText", async () => {
        const testError = new Error("API unavailable");
        const mock = createMockLlm({ forceError: testError });

        await expect(
          mock.generateText({
            model: mock.mockModel,
            messages: [{ role: "user", content: "Test" }],
          }),
        ).rejects.toThrow("API unavailable");
      });

      it("should throw forced error in streamText", () => {
        const testError = new Error("Stream error");
        const mock = createMockLlm({ forceError: testError });

        expect(() => {
          mock.streamText({
            model: mock.mockModel,
            messages: [{ role: "user", content: "Test" }],
          });
        }).toThrow("Stream error");
      });

      it("should throw forced error in generateObject", async () => {
        const testError = new Error("Object generation failed");
        const mock = createMockLlm({ forceError: testError });

        await expect(
          mock.generateObject({
            model: mock.mockModel,
            messages: [{ role: "user", content: "Test" }],
          }),
        ).rejects.toThrow("Object generation failed");
      });
    });

    describe("errorProvider configuration", () => {
      it("should use errorProvider to conditionally throw errors in generateText", async () => {
        const mock = createMockLlm({
          errorProvider: (options) => {
            const lastMessage = options.messages?.slice(-1)[0]?.content?.toString() ?? "";
            if (lastMessage.includes("error")) {
              return new Error("Conditional error");
            }
            return undefined;
          },
        });

        // Should succeed with normal message
        const result = await mock.generateText({
          model: mock.mockModel,
          messages: [{ role: "user", content: "Normal request" }],
        });
        expect(result.text).toContain("Mock response");

        // Should fail with error-triggering message
        await expect(
          mock.generateText({
            model: mock.mockModel,
            messages: [{ role: "user", content: "This should error" }],
          }),
        ).rejects.toThrow("Conditional error");
      });

      it("should use errorProvider in streamText", () => {
        const mock = createMockLlm({
          errorProvider: (options) => {
            const lastMessage = options.messages?.slice(-1)[0]?.content?.toString() ?? "";
            if (lastMessage.includes("stream-error")) {
              return new Error("Stream conditional error");
            }
            return undefined;
          },
        });

        // Should succeed with normal message
        expect(() => {
          mock.streamText({
            model: mock.mockModel,
            messages: [{ role: "user", content: "Normal stream" }],
          });
        }).not.toThrow();

        // Should fail with error-triggering message
        expect(() => {
          mock.streamText({
            model: mock.mockModel,
            messages: [{ role: "user", content: "This should stream-error" }],
          });
        }).toThrow("Stream conditional error");
      });

      it("should use errorProvider in generateObject", async () => {
        const mock = createMockLlm({
          errorProvider: (options) => {
            const lastMessage = options.messages?.slice(-1)[0]?.content?.toString() ?? "";
            if (lastMessage.includes("object-error")) {
              return new Error("Object conditional error");
            }
            return undefined;
          },
        });

        // Should succeed with normal message
        const result = await mock.generateObject({
          model: mock.mockModel,
          messages: [{ role: "user", content: "Generate normal object" }],
          output: "no-schema",
        });
        expect(result.object).toBeDefined();

        // Should fail with error-triggering message
        await expect(
          mock.generateObject({
            model: mock.mockModel,
            messages: [{ role: "user", content: "This should object-error" }],
            output: "no-schema",
          }),
        ).rejects.toThrow("Object conditional error");
      });
    });

    describe("error precedence", () => {
      it("should prioritize forceError over errorProvider", async () => {
        const mock = createMockLlm({
          forceError: new Error("Force error"),
          errorProvider: () => new Error("Provider error"),
        });

        await expect(
          mock.generateText({
            model: mock.mockModel,
            messages: [{ role: "user", content: "Test" }],
          }),
        ).rejects.toThrow("Force error");
      });
    });
  });

  describe("LLM parameter handling", () => {
    it("should respect temperature parameter", async () => {
      const mock = createMockLlm();

      const result0 = await mock.generateText({
        model: mock.mockModel,
        messages: [{ role: "user", content: "Test" }],
        temperature: 0,
      });

      const result1 = await mock.generateText({
        model: mock.mockModel,
        messages: [{ role: "user", content: "Test" }],
        temperature: 1.5,
      });

      // Temperature 0 should not include temp modifier
      expect(result0.text).toBe('Mock response for: "Test"');
      // Non-zero temperature should include temp modifier
      expect(result1.text).toContain("(temp=1.5)");
    });

    it("should respect maxOutputTokens parameter", async () => {
      const mock = createMockLlm({ respectMaxOutputTokens: true });

      const result = await mock.generateText({
        model: mock.mockModel,
        messages: [{ role: "user", content: "Generate a long response" }],
        maxOutputTokens: 10, // Very small limit
      });

      // Should be truncated (10 tokens * 4 chars = 40 chars max)
      expect(result.text.length).toBeLessThanOrEqual(40);
      expect(result.text).toEndWith("...");
      expect(result.finishReason).toBe("length");
    });

    it("should ignore maxOutputTokens when respectMaxOutputTokens is false", async () => {
      const mock = createMockLlm({ respectMaxOutputTokens: false });

      const result = await mock.generateText({
        model: mock.mockModel,
        messages: [{ role: "user", content: "Generate a response" }],
        maxOutputTokens: 1, // Extremely small limit
      });

      // Should not be truncated
      expect(result.text.length).toBeGreaterThan(4); // More than 1 token
      expect(result.finishReason).toBe("stop");
    });
  });

  describe("Edge cases and error handling", () => {
    it("should handle messages with object content that has toString", async () => {
      const mock = createMockLlm();
      // Create a valid content object that has toString method
      const contentObj = { toString: () => "Complex content object" };
      const result = await mock.generateText({
        model: mock.mockModel,
        messages: [{ role: "user", content: contentObj.toString() }],
      });

      expect(result.text).toContain("Complex content object");
    });

    it("should handle empty content gracefully", async () => {
      const mock = createMockLlm();
      const result = await mock.generateText({
        model: mock.mockModel,
        messages: [{ role: "user", content: "" }],
        temperature: 0, // Explicit temperature for deterministic response
      });

      expect(result.text).toBe('Mock response for: ""');
    });

    it("should handle very large inputs", async () => {
      const mock = createMockLlm();
      const largeInput = "x".repeat(10000);

      const result = await mock.generateText({
        model: mock.mockModel,
        messages: [{ role: "user", content: largeInput }],
      });

      expect(result.text).toContain("Mock response for:");
      expect(result.usage.inputTokens).toBe(largeInput.length);
    });

    it("should handle empty schema gracefully", async () => {
      const mock = createMockLlm();
      const result = await mock.generateObject({
        model: mock.mockModel,
        messages: [{ role: "user", content: "Generate object" }],
        // No schema provided
      });

      expect(result.object).toBeDefined();
      expect(result.finishReason).toBe("stop");
    });
  });
});
