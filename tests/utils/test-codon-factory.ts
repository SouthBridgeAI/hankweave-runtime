/**
 * Test utilities for creating properly-typed Codon objects with transforms applied.
 *
 * This helper ensures that test codons go through the same Zod parsing/transformation
 * pipeline as production code, converting model strings to ModelInfo objects.
 */

import { codonConfigSchema, codonSchema } from "../../server/config.js";
import { LlmProviderRegistry } from "../../server/llm/llm-provider-registry.js";
import type { Codon, CodonConfig } from "../../server/types/types.js";
import { Logger } from "../../server/utils.js";

let registryInitialized = false;

/**
 * Ensures LLMProviderRegistry singleton is initialized for tests.
 * Safe to call multiple times - only initializes once.
 */
export function ensureRegistryInitialized(): void {
  if (!registryInitialized) {
    const mockLogger = new Logger("/dev/null");
    LlmProviderRegistry.getInstance({
      logger: mockLogger,
      performHealthCheckOnInit: false,
    });
    registryInitialized = true;
  }
}

/**
 * Creates a test Codon by parsing through Zod schema.
 * This applies all transforms including model string -> ModelInfo conversion.
 *
 * @param codonData - Partial codon data (model as string)
 * @returns Fully parsed Codon with ModelInfo
 *
 * @example
 * const codon = createTestCodon({
 *   id: "test-1",
 *   name: "Test Codon",
 *   model: "sonnet",
 *   continuationMode: "fresh",
 * });
 */
export function createTestCodon(codonData: {
  id: string;
  name: string;
  model: string;
  continuationMode: "fresh" | "continue-previous";
  promptText?: string;
  promptFile?: string | string[];
  appendSystemPromptFile?: string | string[];
  appendSystemPromptText?: string;
  description?: string;
  checkpointedFiles?: string[];
  env?: Record<string, string>;
  rigSetup?: unknown[];
  checkpoints?: unknown[];
  sentinels?: unknown[];
}): Codon {
  ensureRegistryInitialized();

  // Parse through Zod schema to apply transforms
  // The transform guarantees model will be ModelInfo (or parsing will fail)
  return codonSchema.parse(codonData) as Codon;
}

/**
 * Creates a test CodonConfig (Codon or Loop) by parsing through Zod schema.
 * This applies all transforms including model string -> ModelInfo conversion
 * for both regular codons and nested codons within loops.
 *
 * @param configData - Codon or Loop configuration data (models as strings)
 * @returns Fully parsed CodonConfig with ModelInfo objects
 *
 * @example
 * const loop = createTestConfig({
 *   type: "loop",
 *   id: "test-loop",
 *   name: "Test Loop",
 *   codons: [
 *     {
 *       id: "work",
 *       name: "Work",
 *       model: "sonnet",
 *       continuationMode: "fresh",
 *       promptText: "Do work",
 *     },
 *   ],
 *   terminateOn: { type: "contextExceeded" },
 * });
 */
export function createTestConfig(configData: unknown): CodonConfig {
  ensureRegistryInitialized();

  // Parse through Zod schema to apply transforms
  // The transform guarantees models will be ModelInfo (or parsing will fail)
  return codonConfigSchema.parse(configData) as CodonConfig;
}
