import { describe, expect, it } from "bun:test";
import {
  modalitiesSchema,
  modelCostSchema,
  modelInfoSchema,
  modelLimitsSchema,
  modelsDataSchema,
  modelsDevApiResponseSchema,
  providerInfoSchema,
} from "../../server/llm/models-dev-schema";

describe("Models Dev Schema Validation", () => {
  describe("modelCostSchema", () => {
    it("should reject negative costs", () => {
      const invalidCost = {
        input: -1,
        output: 5,
      };

      expect(() => modelCostSchema.parse(invalidCost)).toThrow();
    });
  });

  describe("modelLimitsSchema", () => {
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
    it("should reject empty modalities arrays", () => {
      const emptyModalities = {
        input: [],
        output: ["text"],
      };

      expect(() => modalitiesSchema.parse(emptyModalities)).toThrow();
    });
  });

  describe("modelInfoSchema", () => {
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

        // Verify each model belongs to its provider
        for (const model of provider.models) {
          expect(model.providerId).toBe(provider.id);
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
  });
});
