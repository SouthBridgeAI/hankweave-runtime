import { beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

// Helper to create a fresh AJV instance (needed to avoid schema ID conflicts)
function createAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}

// Helper to get the root definition from a schema with $ref
function getRootDefinition(schema: Record<string, unknown>): Record<string, unknown> | null {
  if (schema.definitions && schema.$ref) {
    const refPath = (schema.$ref as string).replace("#/definitions/", "");
    return (schema.definitions as Record<string, Record<string, unknown>>)[refPath] || null;
  }
  return schema;
}

describe("JSON Schema Generation", () => {
  const schemaDir = path.join(import.meta.dir, "../../schemas");

  describe("Schema file existence", () => {
    test("hank.schema.json exists", () => {
      expect(fs.existsSync(path.join(schemaDir, "hank.schema.json"))).toBe(true);
    });

    test("hankweave.schema.json exists", () => {
      expect(fs.existsSync(path.join(schemaDir, "hankweave.schema.json"))).toBe(true);
    });

    test("sentinel.schema.json exists", () => {
      expect(fs.existsSync(path.join(schemaDir, "sentinel.schema.json"))).toBe(true);
    });
  });

  describe("Schema validity", () => {
    test("hank.schema.json is valid JSON Schema draft-07", () => {
      const ajv = createAjv();
      const schema = JSON.parse(fs.readFileSync(path.join(schemaDir, "hank.schema.json"), "utf-8"));
      expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
      expect(schema.title).toContain("Hank");

      const validate = ajv.compile(schema);
      expect(typeof validate).toBe("function");
    });

    test("hankweave.schema.json is valid JSON Schema", () => {
      const ajv = createAjv();
      const schema = JSON.parse(
        fs.readFileSync(path.join(schemaDir, "hankweave.schema.json"), "utf-8"),
      );
      const validate = ajv.compile(schema);
      expect(typeof validate).toBe("function");
    });

    test("sentinel.schema.json is valid JSON Schema", () => {
      const ajv = createAjv();
      const schema = JSON.parse(
        fs.readFileSync(path.join(schemaDir, "sentinel.schema.json"), "utf-8"),
      );
      const validate = ajv.compile(schema);
      expect(typeof validate).toBe("function");
    });
  });

  describe("Schema structure", () => {
    test("hank schema has required properties", () => {
      const schema = JSON.parse(fs.readFileSync(path.join(schemaDir, "hank.schema.json"), "utf-8"));

      // Schema uses $ref to definitions, so get the root definition
      const rootDef = getRootDefinition(schema);
      expect(rootDef).not.toBeNull();

      // Should have top-level properties for hank files
      const properties = rootDef?.properties as Record<string, unknown>;
      expect(properties).toBeDefined();
      expect(properties.hank).toBeDefined();
      expect(properties.meta).toBeDefined();
      expect(properties.overrides).toBeDefined();
      expect(properties.$schema).toBeDefined(); // Must allow $schema
    });

    test("hank schema requires hank array", () => {
      const schema = JSON.parse(fs.readFileSync(path.join(schemaDir, "hank.schema.json"), "utf-8"));
      const rootDef = getRootDefinition(schema);
      expect(rootDef?.required).toContain("hank");
    });
  });

  describe("Hank schema validation", () => {
    let validate: ValidateFunction;

    beforeAll(() => {
      const ajv = createAjv();
      const schema = JSON.parse(fs.readFileSync(path.join(schemaDir, "hank.schema.json"), "utf-8"));
      validate = ajv.compile(schema);
    });

    test("accepts minimal valid hank config", () => {
      const config = {
        hank: [
          {
            id: "test-codon",
            name: "Test Codon",
            model: "sonnet",
            continuationMode: "fresh",
            promptText: "Hello world",
          },
        ],
      };
      expect(validate(config)).toBe(true);
    });

    test("accepts hank with $schema property", () => {
      const config = {
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
      expect(validate(config)).toBe(true);
    });

    test("accepts hank with loop", () => {
      const config = {
        hank: [
          {
            type: "loop",
            id: "test-loop",
            name: "Test Loop",
            terminateOn: { type: "iterationLimit", limit: 3 },
            codons: [
              {
                id: "loop-codon",
                name: "Loop Codon",
                model: "sonnet",
                continuationMode: "continue-previous",
                promptText: "iterate",
              },
            ],
          },
        ],
      };
      expect(validate(config)).toBe(true);
    });

    test("accepts config with meta", () => {
      const config = {
        meta: { name: "My Hank", version: "1.0.0" },
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
      expect(validate(config)).toBe(true);
    });

    test("accepts config with overrides", () => {
      const config = {
        overrides: { model: "opus", dataHashTimeLimit: 10000 },
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
      expect(validate(config)).toBe(true);
    });

    test("accepts config with promptFile instead of promptText", () => {
      const config = {
        hank: [
          {
            id: "test",
            name: "Test",
            model: "sonnet",
            continuationMode: "fresh",
            promptFile: "./prompts/test.md",
          },
        ],
      };
      expect(validate(config)).toBe(true);
    });

    test("accepts config with array promptFile", () => {
      const config = {
        hank: [
          {
            id: "test",
            name: "Test",
            model: "sonnet",
            continuationMode: "fresh",
            promptFile: ["./prompts/part1.md", "./prompts/part2.md"],
          },
        ],
      };
      expect(validate(config)).toBe(true);
    });

    test("rejects empty hank array", () => {
      const config = { hank: [] };
      expect(validate(config)).toBe(false);
    });

    test("rejects codon missing required id", () => {
      const config = {
        hank: [{ name: "Test", model: "sonnet", continuationMode: "fresh", promptText: "test" }],
      };
      expect(validate(config)).toBe(false);
    });

    test("rejects invalid continuationMode", () => {
      const config = {
        hank: [
          {
            id: "test",
            name: "Test",
            model: "sonnet",
            continuationMode: "invalid",
            promptText: "test",
          },
        ],
      };
      expect(validate(config)).toBe(false);
    });
  });

  describe("Runtime config schema validation", () => {
    let validate: ValidateFunction;

    beforeAll(() => {
      const ajv = createAjv();
      const schema = JSON.parse(
        fs.readFileSync(path.join(schemaDir, "hankweave.schema.json"), "utf-8"),
      );
      validate = ajv.compile(schema);
    });

    test("accepts empty config (all fields optional)", () => {
      expect(validate({})).toBe(true);
    });

    test("accepts valid runtime config", () => {
      const config = {
        port: 8080,
        autostart: false,
        model: "opus",
      };
      expect(validate(config)).toBe(true);
    });

    test("rejects port as string", () => {
      expect(validate({ port: "8080" })).toBe(false);
    });
  });
});
