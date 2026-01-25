#!/usr/bin/env bun
/**
 * Generate JSON Schemas from Zod schemas.
 * Run with: bun scripts/generate-schemas.ts
 *
 * These schemas enable editor autocomplete and validation for:
 * - hank.json (workflow configuration)
 * - hankweave.json (runtime settings)
 * - sentinel config files
 */

import Ajv from "ajv";
import * as fs from "node:fs";
import * as path from "node:path";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { hankFileAuthoringSchema, runtimeConfigSchema } from "../server/config.js";
import { sentinelConfigSchema } from "../server/config-validation/sentinel.schema.js";

// AJV instance for validating generated schemas are valid JSON Schema draft-07
const ajv = new Ajv({ allErrors: true, strict: false });

const SCHEMA_DIR = path.join(import.meta.dir, "..", "schemas");
const DOCS_SCHEMA_DIR = path.join(
  import.meta.dir,
  "..",
  "..",
  "hankweave-docs",
  "nextra-site",
  "public",
  "schemas",
);
// Using unpkg CDN for npm package hosting
const BASE_URL = "https://unpkg.com/hankweave@latest/schemas";

interface SchemaConfig {
  zodSchema: z.ZodTypeAny;
  outputFile: string;
  title: string;
  description: string;
}

const schemas: SchemaConfig[] = [
  {
    zodSchema: hankFileAuthoringSchema,
    outputFile: "hank.schema.json",
    title: "Hankweave Hank File",
    description:
      "Schema for hank.json - the main workflow configuration file for Hankweave. See https://hankweave.dev/reference/configuration for documentation.",
  },
  {
    zodSchema: runtimeConfigSchema,
    outputFile: "hankweave.schema.json",
    title: "Hankweave Runtime Configuration",
    description:
      "Schema for hankweave.json - runtime settings for the Hankweave server. See https://hankweave.dev/reference/configuration for documentation.",
  },
  {
    zodSchema: sentinelConfigSchema,
    outputFile: "sentinel.schema.json",
    title: "Hankweave Sentinel Configuration",
    description:
      "Schema for sentinel configuration files - parallel observation agents. Note: Some runtime validations cannot be expressed in JSON Schema. See https://hankweave.dev/reference/sentinel-config for documentation.",
  },
];

async function generateSchemas() {
  console.log("Generating JSON schemas...\n");

  // Ensure package schemas directory exists (required)
  if (!fs.existsSync(SCHEMA_DIR)) {
    fs.mkdirSync(SCHEMA_DIR, { recursive: true });
  }

  // Check if docs directory exists (optional - only used if hosting schemas on hankweave.dev)
  const docsAvailable = fs.existsSync(path.dirname(DOCS_SCHEMA_DIR));
  if (docsAvailable && !fs.existsSync(DOCS_SCHEMA_DIR)) {
    fs.mkdirSync(DOCS_SCHEMA_DIR, { recursive: true });
  }

  for (const config of schemas) {
    console.log(`Generating ${config.outputFile}...`);

    // @ts-ignore - zodToJsonSchema has excessively deep types
    const jsonSchema: Record<string, unknown> = zodToJsonSchema(config.zodSchema, {
      name: config.title.replace(/\s+/g, ""),
      target: "jsonSchema7", // Draft-07 for VS Code compatibility
      $refStrategy: "none", // Inline all definitions for simpler schemas
    });

    // Add standard JSON Schema metadata
    const schemaWithMeta: Record<string, unknown> = {
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: `${BASE_URL}/${config.outputFile}`,
      title: config.title,
      description: config.description,
      ...jsonSchema,
    };

    // Remove the auto-generated name key if present
    if ("name" in schemaWithMeta) {
      delete schemaWithMeta.name;
    }

    // For schemas without authoring variants (hankweave.json, sentinel.json),
    // inject $schema property into the generated schema so editors show it in autocomplete.
    // hank.schema.json already has $schema via hankFileAuthoringSchema.
    if (config.outputFile !== "hank.schema.json") {
      // Handle both direct properties and $ref-based schemas
      if ("properties" in schemaWithMeta && schemaWithMeta.properties) {
        (schemaWithMeta.properties as Record<string, unknown>).$schema = {
          type: "string",
          description: "JSON Schema URL for editor support",
        };
      } else if ("definitions" in schemaWithMeta && schemaWithMeta.definitions) {
        // When using $ref, properties are in definitions
        const definitions = schemaWithMeta.definitions as Record<string, Record<string, unknown>>;
        for (const defKey of Object.keys(definitions)) {
          const definition = definitions[defKey];
          if (definition && typeof definition === "object" && "properties" in definition) {
            (definition.properties as Record<string, unknown>).$schema = {
              type: "string",
              description: "JSON Schema URL for editor support",
            };
          }
        }
      }
    }

    const schemaJson = JSON.stringify(schemaWithMeta, null, 2);

    // Validate that generated schema is valid JSON Schema
    try {
      ajv.compile(schemaWithMeta);
      console.log("  ✅ Schema validated successfully");
    } catch (error) {
      console.error(`  ❌ Generated schema is invalid JSON Schema: ${error}`);
      throw error;
    }

    // Write to package schemas directory
    const packagePath = path.join(SCHEMA_DIR, config.outputFile);
    fs.writeFileSync(packagePath, schemaJson);
    console.log(`  ✅ Written to ${packagePath}`);

    // Write to docs public directory for URL hosting (if available)
    if (docsAvailable) {
      const docsPath = path.join(DOCS_SCHEMA_DIR, config.outputFile);
      fs.writeFileSync(docsPath, schemaJson);
      console.log(`  ✅ Written to ${docsPath}`);
    }
  }

  console.log("\nSchema generation complete!");
}

generateSchemas().catch((error) => {
  console.error("❌ Schema generation failed:", error);
  process.exit(1);
});
