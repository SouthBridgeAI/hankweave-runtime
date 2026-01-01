import { describe, expect, it } from "bun:test";
import {
  type ModelInfo,
  type ModelsData,
  modalitiesSchema,
  modelCostSchema,
  modelInfoSchema,
  modelLimitsSchema,
  modelsDataSchema,
  modelsDevApiResponseSchema,
  type ProviderInfo,
  providerInfoSchema,
} from "../../server/llm/models-dev-schema";

describe("Models Dev Schema Validation", () => {
  describe("modelCostSchema", () => {
    it("should validate valid cost data", () => {
      const validCost = {
        input: 3.0,
        output: 15.0,
        cache_read: 0.3,
        cache_write: 3.75,
      };

      expect(() => modelCostSchema.parse(validCost)).not.toThrow();
    });

    it("should accept optional fields", () => {
      const partialCost = {
        input: 3.0,
        output: 15.0,
      };

      expect(() => modelCostSchema.parse(partialCost)).not.toThrow();
    });

    it("should accept undefined (optional schema)", () => {
      expect(() => modelCostSchema.parse(undefined)).not.toThrow();
    });

    it("should reject negative costs", () => {
      const invalidCost = {
        input: -1,
        output: 5,
      };

      expect(() => modelCostSchema.parse(invalidCost)).toThrow();
    });
  });

  describe("modelLimitsSchema", () => {
    it("should validate valid limits", () => {
      const validLimits = {
        context: 200000,
        output: 8192,
      };

      expect(() => modelLimitsSchema.parse(validLimits)).not.toThrow();
    });

    it("should reject zero or negative limits", () => {
      const invalidLimits = {
        context: 0,
        output: -100,
      };

      expect(() => modelLimitsSchema.parse(invalidLimits)).toThrow();
    });

    it("should reject non-integer limits", () => {
      const invalidLimits = {
        context: 200000.5,
        output: 8192,
      };

      expect(() => modelLimitsSchema.parse(invalidLimits)).toThrow();
    });
  });

  describe("modalitiesSchema", () => {
    it("should validate text-only modalities", () => {
      const textOnly = {
        input: ["text"],
        output: ["text"],
      };

      expect(() => modalitiesSchema.parse(textOnly)).not.toThrow();
    });

    it("should validate multimodal input with text output", () => {
      const multimodal = {
        input: ["text", "image", "audio", "video"],
        output: ["text"],
      };

      expect(() => modalitiesSchema.parse(multimodal)).not.toThrow();
    });

    it("should reject empty modalities arrays", () => {
      const emptyModalities = {
        input: [],
        output: ["text"],
      };

      expect(() => modalitiesSchema.parse(emptyModalities)).toThrow();
    });
  });

  describe("modelInfoSchema", () => {
    it("should validate complete model info", () => {
      const completeModel: ModelInfo = {
        providerId: "anthropic",
        modelId: "claude-3-5-sonnet-20241022",
        name: "Claude 3.5 Sonnet",
        attachment: true,
        reasoning: false,
        tool_call: true,
        temperature: true,
        cost: {
          input: 3.0,
          output: 15.0,
          cache_read: 0.3,
          cache_write: 3.75,
        },
        limit: {
          context: 200000,
          output: 8192,
        },
        modalities: {
          input: ["text", "image"],
          output: ["text"],
        },
        knowledge: "2024-04-30",
        release_date: "2024-10-22",
        last_updated: "2024-10-22",
      };

      expect(() => modelInfoSchema.parse(completeModel)).not.toThrow();
    });

    it("should validate model info without cost data", () => {
      const modelWithoutCost = {
        providerId: "test",
        modelId: "test-model",
        name: "Test Model",
        attachment: false,
        reasoning: true,
        tool_call: false,
        temperature: true,
        limit: {
          context: 100000,
          output: 4096,
        },
        modalities: {
          input: ["text"],
          output: ["text"],
        },
        release_date: "2024-01",
        last_updated: "2024-01",
      };

      expect(() => modelInfoSchema.parse(modelWithoutCost)).not.toThrow();
    });

    it("should reject invalid date formats", () => {
      const invalidModel = {
        providerId: "test",
        modelId: "test",
        name: "Test",
        attachment: true,
        reasoning: false,
        tool_call: true,
        temperature: true,
        limit: { context: 1000, output: 100 },
        modalities: { input: ["text"], output: ["text"] },
        release_date: "invalid-date",
        last_updated: "2024-01-01",
      };

      expect(() => modelInfoSchema.parse(invalidModel)).toThrow();
    });

    it("should accept YYYY-MM and YYYY-MM-DD date formats", () => {
      const modelYearMonth = {
        providerId: "test",
        modelId: "test1",
        name: "Test 1",
        attachment: true,
        reasoning: false,
        tool_call: true,
        temperature: true,
        limit: { context: 1000, output: 100 },
        modalities: { input: ["text"], output: ["text"] },
        release_date: "2024-01",
        last_updated: "2024-01-15",
      };

      expect(() => modelInfoSchema.parse(modelYearMonth)).not.toThrow();
    });
  });

  describe("providerInfoSchema", () => {
    it("should validate provider with models", () => {
      const provider: ProviderInfo = {
        id: "anthropic",
        name: "Anthropic",
        models: [
          {
            providerId: "anthropic",
            modelId: "claude-3-haiku",
            name: "Claude 3 Haiku",
            attachment: true,
            reasoning: false,
            tool_call: true,
            temperature: true,
            limit: { context: 200000, output: 4096 },
            modalities: { input: ["text"], output: ["text"] },
            release_date: "2024-03",
            last_updated: "2024-03",
          },
        ],
      };

      expect(() => providerInfoSchema.parse(provider)).not.toThrow();
    });

    it("should reject provider with empty models array", () => {
      const emptyProvider = {
        id: "test",
        name: "Test Provider",
        models: [],
      };

      expect(() => providerInfoSchema.parse(emptyProvider)).toThrow();
    });
  });

  describe("modelsDataSchema", () => {
    it("should validate complete models data structure", () => {
      const validData: ModelsData = {
        version: "1.0.0",
        lastUpdated: new Date().toISOString(),
        providers: [
          {
            id: "anthropic",
            name: "Anthropic",
            models: [
              {
                providerId: "anthropic",
                modelId: "claude-3-haiku",
                name: "Claude 3 Haiku",
                attachment: true,
                reasoning: false,
                tool_call: true,
                temperature: true,
                cost: { input: 0.25, output: 1.25 },
                limit: { context: 200000, output: 4096 },
                modalities: { input: ["text", "image"], output: ["text"] },
                release_date: "2024-03-13",
                last_updated: "2024-03-13",
              },
            ],
          },
        ],
      };

      expect(() => modelsDataSchema.parse(validData)).not.toThrow();
    });

    it("should reject invalid version format", () => {
      const invalidVersion = {
        version: "v1.0",
        lastUpdated: new Date().toISOString(),
        providers: [],
      };

      expect(() => modelsDataSchema.parse(invalidVersion)).toThrow();
    });

    it("should reject invalid timestamp format", () => {
      const invalidTimestamp = {
        version: "1.0.0",
        lastUpdated: "not-a-timestamp",
        providers: [],
      };

      expect(() => modelsDataSchema.parse(invalidTimestamp)).toThrow();
    });

    it("should accept empty providers array", () => {
      const emptyProviders = {
        version: "1.0.0",
        lastUpdated: new Date().toISOString(),
        providers: [],
      };

      expect(() => modelsDataSchema.parse(emptyProviders)).not.toThrow();
    });
  });

  describe("modelsDevApiResponseSchema", () => {
    it("should validate realistic API response structure", () => {
      const apiResponse = {
        anthropic: {
          name: "Anthropic",
          models: {
            "claude-3-haiku": {
              name: "Claude 3 Haiku",
              attachment: true,
              reasoning: false,
              tool_call: true,
              temperature: true,
              cost: {
                input: 0.25,
                output: 1.25,
              },
              limit: {
                context: 200000,
                output: 4096,
              },
              modalities: {
                input: ["text", "image"],
                output: ["text"],
              },
              release_date: "2024-03-13",
              last_updated: "2024-03-13",
            },
          },
        },
      };

      expect(() => modelsDevApiResponseSchema.parse(apiResponse)).not.toThrow();
    });

    it("should validate API response with optional cost field", () => {
      const apiResponseNoCost = {
        testprovider: {
          name: "Test Provider",
          models: {
            "test-model": {
              name: "Test Model",
              attachment: false,
              reasoning: true,
              tool_call: false,
              temperature: true,
              limit: { context: 100000, output: 2048 },
              modalities: { input: ["text"], output: ["text"] },
              release_date: "2024-01",
              last_updated: "2024-01",
            },
          },
        },
      };

      expect(() => modelsDevApiResponseSchema.parse(apiResponseNoCost)).not.toThrow();
    });
  });

  describe("Real data validation", () => {
    it("should validate the actual downloaded data file", async () => {
      // Import the actual data file that was downloaded
      const fs = await import("node:fs/promises");
      const path = await import("node:path");

      const dataPath = path.join(process.cwd(), "server/llm/models-dev-data.json");
      const dataContent = await fs.readFile(dataPath, "utf-8");
      const data = JSON.parse(dataContent);

      // This should not throw - validates our actual data
      expect(() => modelsDataSchema.parse(data)).not.toThrow();

      // Verify we have the expected structure
      const validatedData = modelsDataSchema.parse(data);
      expect(validatedData.version).toBe("1.0.0");
      expect(validatedData.providers.length).toBeGreaterThan(0);
      expect(validatedData.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

      // Verify we have expected providers
      const providerIds = validatedData.providers.map((p) => p.id);
      expect(providerIds).toContain("anthropic");
      expect(providerIds).toContain("openai");

      // Verify each provider has models
      for (const provider of validatedData.providers) {
        expect(provider.models.length).toBeGreaterThan(0);

        // Verify each model has required fields
        for (const model of provider.models) {
          expect(model.providerId).toBe(provider.id);
          expect(typeof model.modelId).toBe("string");
          expect(typeof model.name).toBe("string");
          expect(typeof model.attachment).toBe("boolean");
          expect(typeof model.reasoning).toBe("boolean");
          expect(typeof model.tool_call).toBe("boolean");
          expect(model.limit.context).toBeGreaterThan(0);
          expect(model.limit.output).toBeGreaterThan(0);
          expect(model.modalities.input.length).toBeGreaterThan(0);
          expect(model.modalities.output.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe("Edge cases and error conditions", () => {
    it("should handle missing required fields gracefully", () => {
      const incompleteModel = {
        providerId: "test",
        modelId: "test",
        name: "Test",
        // Missing required boolean fields
        limit: { context: 1000, output: 100 },
        modalities: { input: ["text"], output: ["text"] },
        release_date: "2024-01",
        last_updated: "2024-01",
      };

      expect(() => modelInfoSchema.parse(incompleteModel)).toThrow();
    });

    it("should validate very large context windows", () => {
      const largeContextModel = {
        providerId: "test",
        modelId: "test",
        name: "Test",
        attachment: true,
        reasoning: false,
        tool_call: true,
        temperature: true,
        limit: {
          context: 2000000, // 2M tokens
          output: 100000, // 100K tokens
        },
        modalities: { input: ["text"], output: ["text"] },
        release_date: "2024-01",
        last_updated: "2024-01",
      };

      expect(() => modelInfoSchema.parse(largeContextModel)).not.toThrow();
    });

    it("should validate various modality combinations", () => {
      const videoModel = {
        providerId: "test",
        modelId: "test-video",
        name: "Test Video Model",
        attachment: true,
        reasoning: false,
        tool_call: true,
        temperature: true,
        limit: { context: 100000, output: 4096 },
        modalities: {
          input: ["text", "image", "audio", "video", "pdf"],
          output: ["text"],
        },
        release_date: "2024-01",
        last_updated: "2024-01",
      };

      expect(() => modelInfoSchema.parse(videoModel)).not.toThrow();
    });
  });
});
