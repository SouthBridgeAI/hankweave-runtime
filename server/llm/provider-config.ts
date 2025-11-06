import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import type { Provider } from "ai";

export interface ProviderDefinition {
  id: string;
  apiKeyEnvVar: string;
  createProvider: (apiKey: string) => Provider;
  defaultHeaders?: Record<string, string>; // Optional headers for the provider
}

/**
 * Provider definitions for all supported LLM providers.
 * Each provider definition includes:
 * - id: Unique identifier matching the providerId in models data
 * - apiKeyEnvVar: Environment variable name for the API key
 * - createProvider: Factory function to create the provider instance
 * - defaultHeaders: Optional default headers to include with requests
 */
export const PROVIDER_DEFINITIONS: ProviderDefinition[] = [
  {
    id: "anthropic",
    apiKeyEnvVar: "ANTHROPIC_API_KEY",
    createProvider: (apiKey) =>
      createAnthropic({
        apiKey,
        // Can add baseURL for proxies if needed in the future
      }),
  },
  {
    id: "openai",
    apiKeyEnvVar: "OPENAI_API_KEY",
    createProvider: (apiKey) =>
      createOpenAI({
        apiKey,
        // Default OpenAI provider configuration - no additional options needed
      }),
  },
  {
    id: "groq",
    apiKeyEnvVar: "GROQ_API_KEY",
    createProvider: (apiKey) =>
      createGroq({
        apiKey,
      }),
  },
  {
    id: "google",
    apiKeyEnvVar: "GOOGLE_API_KEY",
    createProvider: (apiKey) =>
      createGoogleGenerativeAI({
        apiKey,
      }),
  },
  // Note: Mistral is not included as @ai-sdk/mistral is not currently available
  // but the models data includes mistral models for future use
];

/**
 * Get provider definition by ID
 */
export function getProviderDefinition(providerId: string): ProviderDefinition | undefined {
  return PROVIDER_DEFINITIONS.find((def) => def.id === providerId);
}

/**
 * Get all supported provider IDs
 */
export function getSupportedProviderIds(): string[] {
  return PROVIDER_DEFINITIONS.map((def) => def.id);
}
