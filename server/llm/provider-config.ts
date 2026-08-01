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
  /**
   * Preferred models for health checks, tried in order before falling back
   * to findCheapestModel. Use stable, non-preview model IDs that the
   * provider is unlikely to deprecate.
   */
  healthCheckModels?: string[];
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
    healthCheckModels: ["claude-haiku-4-5"],
  },
  {
    id: "openai",
    apiKeyEnvVar: "OPENAI_API_KEY",
    createProvider: (apiKey) =>
      createOpenAI({
        apiKey,
        // Default OpenAI provider configuration - no additional options needed
      }),
    healthCheckModels: ["gpt-5.4-mini"],
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
    // GEMINI_API_KEY is the standard var for the Gemini API (Google AI Studio)
    // and the embedded pi runtime's native spelling. The legacy GOOGLE_API_KEY
    // alias was removed — one name across sentinels, wizard, and pi.
    apiKeyEnvVar: "GEMINI_API_KEY",
    createProvider: (apiKey) =>
      createGoogleGenerativeAI({
        apiKey,
      }),
    healthCheckModels: ["gemini-flash-latest"],
  },
  {
    // DeepSeek exposes an OpenAI-compatible API, so we reuse the OpenAI
    // provider factory pointed at the DeepSeek base URL. This lets the registry
    // treat DeepSeek as a configurable provider for health checks, direct
    // generateText calls, passthrough shims, and pricing metadata.
    id: "deepseek",
    apiKeyEnvVar: "DEEPSEEK_API_KEY",
    createProvider: (apiKey) => {
      const openai = createOpenAI({
        apiKey,
        baseURL: process.env.DEEPSEEK_BASE_URL?.replace(/\/+$/, "") || "https://api.deepseek.com",
      });
      // DeepSeek implements the OpenAI /chat/completions API but NOT the newer
      // Responses API that @ai-sdk/openai's languageModel() targets by default.
      // Route languageModel() to chat() so health checks and direct generateText
      // calls hit /chat/completions instead of 404ing on /responses.
      return new Proxy(openai, {
        get(target, prop, receiver) {
          if (prop === "languageModel") {
            return (modelId: string) => target.chat(modelId);
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as Provider;
    },
    healthCheckModels: ["deepseek-v4-flash"],
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
