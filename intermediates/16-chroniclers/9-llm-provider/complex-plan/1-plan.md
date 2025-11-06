## Architectural Plan: The `LlmProviderManager`

### 1. Executive Summary

This document outlines the complete architectural plan for the `LlmProviderManager`, a stateful, resilient system for managing connections to Large Language Model (LLM) providers within the Tadpole Runner.

The primary goal is to create a robust, fault-tolerant layer that abstracts the complexities of provider instantiation, credential validation, and model availability away from the core application logic. This manager will be initialized at server startup, perform health checks on all configured providers, and maintain a runtime registry of available models. This enables Chroniclers to be configured with model fallback chains, ensuring they can continue to operate even if a primary LLM provider is unavailable.

### 2. Core Components

The architecture introduces one new core component and defines its interaction with existing components.

#### A. `LlmProviderManager` (New)

A stateful singleton class responsible for the entire lifecycle of LLM provider connections.

*   **Role**: To discover, validate, and provide access to LLM `LanguageModel` instances from the Vercel AI SDK.
*   **Lifecycle**: Instantiated once when `TadpoleServer` starts. Its `initialize()` method will kick off asynchronous health checks for all discovered providers.
*   **Key Responsibilities**:
    1.  **Provider Discovery**: Scan environment variables (e.g., `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) to identify which providers are configured.
    2.  **Health Checking**: Upon initialization, perform a small, real API call for each discovered provider to verify credentials and connectivity.
    3.  **Status Registry**: Maintain an internal, real-time registry of each provider's status (`available`, `unavailable`, `pending`).
    4.  **Model Provisioning**: Provide a public method (`getProviderForModel`) that allows consumers (Chroniclers) to request a validated `LanguageModel` instance for a specific model ID.
    5.  **Metadata Hub**: Act as a central source for hardcoded provider metadata, such as rate limits and cost-per-token information.

#### B. `ChroniclerManager` (Updated Role)

*   **Role**: Its role is simplified to that of a conduit. It will receive the `LlmProviderManager` instance from the `TadpoleServer` and pass it down to each `Chronicler` instance it creates. It is not responsible for knowing which providers are available.

#### C. `Chronicler` (Updated Role)

*   **Role**: Becomes the primary consumer of the `LlmProviderManager`.
*   **Responsibilities**:
    1.  Accept an `LlmProviderManager` instance in its constructor.
    2.  When triggered, read its own configuration to get the desired list of fallback models.
    3.  Iterate through its model list, requesting a provider for each from the `LlmProviderManager` until an available one is found.
    4.  Execute its LLM call using the first available provider.
    5.  Gracefully handle the case where no configured providers are available.

### 3. TypeScript Interfaces

These interfaces define the public contracts and internal data structures for the system.

```typescript
// server/llm/provider-types.ts

import type { LanguageModel } from 'ai';

/** The status of a provider in the registry. */
export type ProviderStatus = 'pending' | 'available' | 'unavailable';

/** The internal representation of a provider within the manager's registry. */
export interface RegisteredProvider {
  id: string; // e.g., 'anthropic'
  status: ProviderStatus;
  instance: LanguageModel;
  healthCheckPromise: Promise<void>; // A promise that resolves when the check is done
  failureReason?: string; // Reason for 'unavailable' status
}

/** Hardcoded rate limit information for a model. */
export interface RateLimitInfo {
  requestsPerMinute: number;
  tokensPerMinute: number;
}

/** Hardcoded cost information for a model. */
export interface CostInfo {
  inputCostPerMillionTokens: number;
  outputCostPerMillionTokens: number;
}

/** The public interface for the LlmProviderManager. */
export interface LlmProviderManager {
  /**
   * Discovers and initializes providers, running health checks in the background.
   * This method returns immediately.
   */
  initialize(): void;

  /**
   * Asynchronously retrieves an available LanguageModel instance for a given model ID.
   * This method will wait for the initial health check of the requested provider to complete.
   * @param modelId - The provider-scoped model ID (e.g., "anthropic:claude-3-5-sonnet-20240620").
   * @returns A ready-to-use LanguageModel instance, or null if the provider is unavailable.
   */
  getProviderForModel(modelId: string): Promise<LanguageModel | null>;

  /**
   * Retrieves hardcoded rate limit information for a specific model.
   * @param modelId - The provider-scoped model ID.
   * @returns RateLimitInfo or null if not found.
   */
  getRateLimitInfo(modelId: string): RateLimitInfo | null;

  /**
   * Retrieves hardcoded cost information for a specific model.
   * @param modelId - The provider-scoped model ID.
   * @returns CostInfo or null if not found.
   */
  getCostInfo(modelId: string): CostInfo | null;
}
```

### 4. Detailed Execution Flow

This narrative describes the end-to-end process from server start to a Chronicler making an LLM call.

#### Stage 1: Server Startup & Provider Initialization

1.  The `TadpoleServer` process begins.
2.  It creates a singleton instance of the `LlmProviderManager`.
3.  It immediately calls `llmProviderManager.initialize()`.
4.  The `initialize` method executes synchronously and quickly:
    a. It scans a predefined list of supported providers (e.g., Anthropic, OpenAI).
    b. For each provider, it checks for the existence of the corresponding environment variable (e.g., `ANTHROPIC_API_KEY`).
    c. If an env var is found, it creates an AI SDK `LanguageModel` instance (e.g., `createAnthropic()`).
    d. It adds an entry to its internal registry (`Map<string, RegisteredProvider>`) with a `status` of `'pending'`.
    e. It kicks off an **asynchronous** `healthCheck()` function for that provider. The promise for this check is stored in the registry.
5.  The `TadpoleServer` continues its startup sequence **without waiting** for the health checks to complete. It then creates the `ChroniclerManager`, passing the `LlmProviderManager` instance to it.

#### Stage 2: Chronicler Loading

1.  As the server proceeds, `chroniclerManager.loadChroniclersForPhase` is called.
2.  The `ChroniclerManager` reads the chronicler configurations.
3.  For each chronicler, it creates a new `Chronicler` instance, passing the `LlmProviderManager` instance into its constructor. The `Chronicler` stores this reference.
4.  At this stage, the health checks in the `LlmProviderManager` are likely still running in the background. The system is ready, but the availability of specific providers is not yet confirmed.

#### Stage 3: A Chronicler Makes an LLM Call

1.  A trigger condition is met, and a `Chronicler` instance's `executeChroniclerCall` method is invoked.
2.  The `Chronicler` retrieves its configured model fallback list from `this.config.llmParams.models`. For example: `["anthropic:claude-3-opus-20240229", "openai:gpt-4o"]`.
3.  It begins to iterate through this list to find the first available provider.
4.  **First attempt (Anthropic):**
    a. It calls `await this.llmProviderManager.getProviderForModel("anthropic:claude-3-opus-20240229")`.
    b. The `getProviderForModel` method looks up the "anthropic" provider in its registry.
    c. It finds the `healthCheckPromise` for Anthropic and `await`s it. This ensures the method only proceeds after the health check for *that specific provider* is complete.
    d. **Scenario 1 (Success):** The health check succeeded. The provider's status is now `'available'`. The method returns the AI SDK `LanguageModel` instance. The `Chronicler` receives the instance, breaks its loop, and proceeds to make the LLM call.
    e. **Scenario 2 (Failure):** The health check failed (e.g., invalid API key). The provider's status is now `'unavailable'`. The method returns `null`.
5.  **Second attempt (OpenAI):**
    a. Since the first attempt returned `null`, the `Chronicler`'s loop continues to the next item: `"openai:gpt-4o"`.
    b. It calls `await this.llmProviderManager.getProviderForModel("openai:gpt-4o")`.
    c. The same process as step 4b-d occurs for the OpenAI provider. Assuming this one is configured correctly, its health check succeeds, and the `LanguageModel` instance is returned.
    d. The `Chronicler` receives the valid OpenAI provider instance, breaks the loop, and makes its LLM call.
6.  **Failure Scenario:** If the `Chronicler` iterates through its entire list and receives `null` for every model, it will not make an LLM call. Instead, it will log a descriptive error (e.g., "Chronicler 'narrator' could not execute as no configured LLM providers were available.") and fail gracefully for that trigger event.

### 5. Configuration Changes

The chronicler configuration schema will be updated to support the model fallback chain.

**`server/config-validation/chronicler.schema.ts`**

```typescript
// Add this to the tadpoleLlmCallParamsSchema
export const tadpoleLlmCallParamsSchema = z.object({
  // ... existing params like temperature, maxOutputTokens ...
  models: z.array(z.string().regex(/^[a-z]+:.+$/)).optional()
    .describe("Ordered list of provider-scoped model IDs to use as a fallback chain."),
});
```

**Example `phases.json` chronicler configuration:**

```json
{
  "id": "resilient-narrator",
  "name": "Resilient Narrator",
  "trigger": { "type": "event", "on": ["*"] },
  "execution": { "strategy": "debounce", "milliseconds": 5000 },
  "systemPromptText": "You are a development narrator.",
  "userPromptFile": "./prompts/narrate.md",
  "llmParams": {
    "temperature": 0.2,
    "maxOutputTokens": 4096,
    "models": [
      "anthropic:claude-3-5-sonnet-20240620",
      "openai:gpt-4o-mini"
    ]
  }
}
```
*Note: The existing `model` field in the chronicler config can be deprecated or used as a shorthand for a single-item `models` array.*

### 6. Concrete Example: Handling a Failed Provider

**Scenario:**
-   The user has set `ANTHROPIC_API_KEY` (but it's invalid) and `OPENAI_API_KEY` (which is valid).
-   A chronicler is configured with `models: ["anthropic:claude-3-opus-20240229", "openai:gpt-4o"]`.

**Execution:**
1.  **Startup**: `LlmProviderManager` creates both Anthropic and OpenAI provider instances and starts their health checks in the background.
2.  **Health Checks**:
    -   The Anthropic health check fails with a 401 Unauthorized error. The manager updates its status to `unavailable` with reason "Authentication failed."
    -   The OpenAI health check succeeds. The manager updates its status to `available`.
3.  **Trigger**: The chronicler is triggered.
4.  **LLM Call Attempt 1**: It calls `getProviderForModel("anthropic:claude-3-opus-20240229")`. The manager, having completed the health check, immediately returns `null`.
5.  **LLM Call Attempt 2**: It calls `getProviderForModel("openai:gpt-4o")`. The manager returns the valid, health-checked OpenAI `LanguageModel` instance.
6.  **Result**: The chronicler successfully makes its API call using OpenAI, seamlessly falling back without any user intervention or runtime failure. The system remains robust.

### 7. Benefits of this Architecture

*   **Resilience**: The system can withstand provider outages or configuration errors without failing.
*   **Decoupling**: `TadpoleServer` remains agnostic to LLM providers. `ChroniclerManager` is a simple factory. All complex logic is encapsulated in the `LlmProviderManager` and the `Chronicler`.
*   **Clarity**: The configuration explicitly defines the desired behavior and fallback strategy.
*   **Performance**: Server startup is not blocked by slow API health checks. Latency is only incurred on the very first LLM call for a specific provider.
*   **Extensibility**: Adding a new provider requires minimal changes: add a new case in the discovery logic and provide its metadata.