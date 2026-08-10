import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import type { Provider } from "ai";
import {
  BEDROCK_DEFAULT_REGION,
  describeExplicitAwsEnvCredentialSource,
} from "../aws-credentials.js";

export interface ProviderDefinition {
  id: string;
  apiKeyEnvVar: string;
  createProvider: (apiKey: string) => Provider;
  defaultHeaders?: Record<string, string>; // Optional headers for the provider
  /**
   * Preferred models for health checks, tried in order before falling back
   * to findCheapestModel. Use stable, non-preview model IDs that the
   * provider is unlikely to deprecate. A function form is evaluated at
   * check time for providers whose usable model IDs depend on the
   * environment (amazon-bedrock: geo-prefixed inference profiles).
   */
  healthCheckModels?: string[] | (() => string[]);
  /**
   * For providers authenticated by more than a single API key
   * (amazon-bedrock). When set and apiKeyEnvVar found nothing, the registry
   * calls this; a non-null return (a human-readable source description)
   * marks the provider available and createProvider is invoked with an empty
   * apiKey — the factory reads the detected source from the environment
   * itself.
   */
  detectAmbientCredentials?: () => string | null;
  /**
   * Appended to the not-configured error when detectAmbientCredentials found
   * nothing — names the accepted sources so the skip message is actionable.
   */
  credentialsHelp?: string;
}

/**
 * Health-check candidates for Amazon Bedrock, ordered for the configured
 * region. Cross-region inference profiles are geo-scoped (us./eu./jp./au.),
 * so the probe must use the profile matching the region the provider factory
 * signs for; global. is the cross-geo fallback and leads in regions with no
 * geo-specific Anthropic profile.
 */
export function bedrockHealthCheckModels(): string[] {
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || BEDROCK_DEFAULT_REGION;
  const haiku = "anthropic.claude-haiku-4-5-20251001-v1:0";
  // GovCloud is its own partition with us-gov. profiles; the commercial us.
  // and global. profiles aren't callable from it (and it must be matched
  // before the broader us- prefix).
  if (region.startsWith("us-gov-")) return [`us-gov.${haiku}`];
  let geo: string | undefined;
  if (region.startsWith("us-")) geo = "us";
  else if (region.startsWith("eu-")) geo = "eu";
  // Japan (Tokyo/Osaka) and Australia (Sydney/Melbourne) have their own
  // Anthropic profiles; other ap-*/ca-*/sa-*/me-* regions only route via
  // global.
  else if (region === "ap-northeast-1" || region === "ap-northeast-3") geo = "jp";
  else if (region === "ap-southeast-2" || region === "ap-southeast-4") geo = "au";
  return geo ? [`${geo}.${haiku}`, `global.${haiku}`] : [`global.${haiku}`];
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
  {
    // Amazon Bedrock, explicit-env-credentials only: bearer token
    // (apiKeyEnvVar, so the HANKWEAVE_SENTINEL_ override convention works) or
    // an AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY key pair — both handled by
    // createAmazonBedrock's own aws4fetch signing. Profile/SSO, container
    // creds, IRSA, and IMDS are deliberately NOT supported for sentinels:
    // resolving them needs @aws-sdk/credential-providers, a ~6MB transitive
    // tree kept out of the bundle on purpose. Machines on those sources run
    // Bedrock codons fine (both harnesses resolve the full chain themselves)
    // but skip Bedrock-modeled sentinels — documented in the README FAQ.
    id: "amazon-bedrock",
    apiKeyEnvVar: "AWS_BEARER_TOKEN_BEDROCK",
    detectAmbientCredentials: describeExplicitAwsEnvCredentialSource,
    credentialsHelp:
      "sentinels accept AWS_BEARER_TOKEN_BEDROCK or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY only; profile/SSO/container/IMDS sources work for codons but not sentinels",
    createProvider: (apiKey) => {
      const region =
        process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || BEDROCK_DEFAULT_REGION;
      if (apiKey) {
        return createAmazonBedrock({ region, apiKey });
      }
      return createAmazonBedrock({
        region,
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        sessionToken: process.env.AWS_SESSION_TOKEN,
      });
    },
    // Cross-region inference profiles: Anthropic on Bedrock rejects bare
    // on-demand ids, and haiku is the cheapest Anthropic entry there. A
    // geo profile only routes within its own geography, so the candidate
    // list must follow the configured region (a us. probe from eu-west-1
    // fails and would mark every Bedrock sentinel unavailable) — hence the
    // function form, evaluated at check time.
    healthCheckModels: bedrockHealthCheckModels,
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
