import { beforeAll, describe, expect, test } from "bun:test";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  codonObjectSchema,
  hankFileAuthoringSchema,
  hankFileSchema,
} from "../../server/config";

describe("JSON Schema and Zod Parity", () => {
  let ajv: Ajv;
  let jsonSchemaValidate: ValidateFunction;

  beforeAll(() => {
    ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);

    const schema = JSON.parse(
      fs.readFileSync(path.resolve("schemas/hank.schema.json"), "utf-8"),
    );
    jsonSchemaValidate = ajv.compile(schema);
  });

  // Test cases that should pass BOTH validations
  const bothPass = [
    {
      name: "minimal config",
      config: {
        hank: [
          {
            id: "test",
            name: "Test",
            model: "sonnet",
            continuationMode: "fresh",
            promptText: "test",
          },
        ],
      },
    },
    {
      name: "full config",
      config: {
        meta: { name: "Test Hank", version: "1.0.0", description: "A test" },
        overrides: { model: "opus" },
        hank: [
          {
            id: "codon-1",
            name: "First Codon",
            model: "sonnet",
            continuationMode: "fresh",
            promptFile: "./prompt.md",
          },
        ],
      },
    },
  ];

  for (const { name, config } of bothPass) {
    test(`"${name}" passes both JSON Schema and Zod`, () => {
      const jsonSchemaValid = jsonSchemaValidate(config);
      const zodResult = hankFileSchema.safeParse(config);

      if (!jsonSchemaValid) {
        console.log("JSON Schema errors:", jsonSchemaValidate.errors);
      }
      if (!zodResult.success) {
        console.log("Zod errors:", zodResult.error.errors);
      }

      expect(jsonSchemaValid).toBe(true);
      expect(zodResult.success).toBe(true);
    });
  }

  // Test cases that should fail BOTH validations
  const bothFail = [
    { name: "empty hank array", config: { hank: [] } },
    { name: "missing hank array", config: { meta: { name: "Test" } } },
  ];

  for (const { name, config } of bothFail) {
    test(`"${name}" fails both JSON Schema and Zod`, () => {
      const jsonSchemaValid = jsonSchemaValidate(config);
      const zodResult = hankFileSchema.safeParse(config);

      expect(jsonSchemaValid).toBe(false);
      expect(zodResult.success).toBe(false);
    });
  }
});

describe("Authoring schema consistency", () => {
  // Valid configs should pass BOTH authoring and runtime schemas
  const validCodonConfigs = [
    {
      name: "minimal codon",
      config: {
        id: "test",
        name: "Test",
        model: "sonnet",
        continuationMode: "fresh",
        promptText: "Hello",
      },
    },
    {
      name: "codon with all optional fields",
      config: {
        id: "full",
        name: "Full Codon",
        model: "haiku",
        continuationMode: "continue-previous",
        promptFile: "./prompt.md",
        description: "A full codon",
        checkpointedFiles: ["output.md"],
        env: { KEY: "value" },
      },
    },
  ];

  for (const { name, config } of validCodonConfigs) {
    test(`"${name}" passes codonObjectSchema`, () => {
      // Both should accept the same input structure
      const objectResult = codonObjectSchema.safeParse(config);
      expect(objectResult.success).toBe(true);
    });
  }

  // Test that hank file structure is consistent
  test("hankFileAuthoringSchema matches hankFileSchema structure", () => {
    const testConfig = {
      meta: { name: "Test", version: "1.0.0" },
      hank: [
        {
          id: "test",
          name: "Test",
          model: "sonnet",
          continuationMode: "fresh",
          promptText: "test",
        },
      ],
    };

    // Both should accept the same structure
    const authoringResult = hankFileAuthoringSchema.safeParse(testConfig);
    const runtimeResult = hankFileSchema.safeParse(testConfig);

    expect(authoringResult.success).toBe(true);
    expect(runtimeResult.success).toBe(true);
  });

  // Authoring schema should explicitly allow $schema
  test("hankFileAuthoringSchema explicitly allows $schema", () => {
    const configWithSchema = {
      $schema: "https://unpkg.com/hankweave@latest/schemas/hank.schema.json",
      hank: [
        {
          id: "test",
          name: "Test",
          model: "sonnet",
          continuationMode: "fresh",
          promptText: "test",
        },
      ],
    };

    const result = hankFileAuthoringSchema.safeParse(configWithSchema);
    expect(result.success).toBe(true);
  });
});

describe("Schema validates documentation examples", () => {
  let ajv: Ajv;
  let validate: ValidateFunction;

  beforeAll(() => {
    ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);

    const schema = JSON.parse(
      fs.readFileSync(path.resolve("schemas/hank.schema.json"), "utf-8"),
    );
    validate = ajv.compile(schema);
  });

  test("validates data-codebook style hank", () => {
    const dataCodebookExample = {
      meta: {
        name: "Data Codebook Generator",
        version: "1.0.0",
        description: "Generates documented schemas from raw CSV files",
      },
      overrides: {
        model: "sonnet",
        dataHashTimeLimit: 10000,
      },
      hank: [
        {
          id: "analyze",
          name: "Analyze Data",
          model: "haiku",
          continuationMode: "fresh",
          promptFile: "./prompts/analyze.md",
          checkpointedFiles: ["analysis.md"],
        },
        {
          type: "loop",
          id: "refine",
          name: "Refinement Loop",
          terminateOn: { type: "iterationLimit", limit: 3 },
          codons: [
            {
              id: "refine-codon",
              name: "Refine",
              model: "sonnet",
              continuationMode: "continue-previous",
              promptText: "Refine the previous analysis",
            },
          ],
        },
      ],
    };

    expect(validate(dataCodebookExample)).toBe(true);
  });
});
