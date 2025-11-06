# Implementation Plan: `LlmProviderManager`

### 1. Executive Summary

This document provides a comprehensive, step-by-step plan for implementing the `LlmProviderManager`. It incorporates all feedback to create a robust, decoupled, and maintainable system for managing LLM interactions within Tadpole Runner.

The final architecture is defined by:
1.  **Offline Model Data**: A script will fetch, validate, and store `models.dev` data locally, removing a network dependency from server startup.
2.  **Centralized Provider Configuration**: A dedicated TypeScript configuration file will map provider IDs from `models.dev` to Vercel AI SDK instances and their required API key environment variables.
3.  **Centralized Call Logic**: The `LlmProviderManager` will expose `generateText` and `streamText` methods that internally handle the entire model fallback logic, simplifying consumer code.
4.  **Stateful Tracking**: The manager will track runtime metrics like costs and token usage.
5.  **Robust Error Handling**: If no configured providers are available for a given call, the manager will throw a specific `NoAvailableProvidersError`, allowing consumers like Chroniclers to handle the failure gracefully (e.g., by unloading).
6.  **Phased Implementation with Quality Gates**: The implementation is broken down into clear steps, each with its own testing requirements and quality checks (`lint` and `typecheck`).

### 2. Final Architecture Components

*   **`scripts/fetch-models-dev.ts`**: A standalone script to refresh local model data from `models.dev/api.json`.
*   **`server/llm/models-dev.schema.ts`**: A Zod schema to validate the data from `models.dev`.
*   **`server/llm/models-dev.data.json`**: The local, version-controlled copy of the model data.
*   **`server/llm/provider.config.ts`**: A new configuration file mapping provider IDs to SDK instances and API keys.
*   **`server/llm/llm-provider.manager.ts`**: The core singleton service for all LLM interactions.
*   **`server/llm/llm-provider.types.ts`**: TypeScript interfaces for the new system.
*   **`server/llm/errors.ts`**: Custom error classes, including `NoAvailableProvidersError`.

### 3. Step-by-Step Implementation Guide

---

#### **Phase 1: Data and Configuration Scaffolding**

*Goal: Set up the foundational data structures, schemas, and configurations.*

1.  **Create `models-dev` Schema**:
    *   **File**: `server/llm/models-dev.schema.ts`
    *   **Action**: Create a comprehensive Zod schema that validates the structure of `models.dev/api.json`. Include fields like `provider`, `modelId`, `name`, `cost`, `limit`, etc.
2.  **Create `fetch-models-dev` Script**:
    *   **File**: `scripts/fetch-models-dev.ts`
    *   **Action**: Implement the script to fetch data, validate it against the new Zod schema, and write it to `server/llm/models-dev.data.json`. Ensure it handles fetch/validation errors gracefully.
3.  **Generate Initial Data File**:
    *   **Action**: Run the script once (`bun scripts/fetch-models-dev.ts`) to generate the initial `server/llm/models-dev.data.json` file.
4.  **Create Provider Configuration**:
    *   **File**: `server/llm/provider.config.ts`
    *   **Action**: Create the mapping configuration as planned. Initially, include mappings for `anthropic` and `openai`.

    ```typescript
    import { createAnthropic } from '@ai-sdk/anthropic';
    import { createOpenAI } from '@ai-sdk/openai';
    import type { LanguageModel } from 'ai';

    export interface ProviderConfig {
      apiKeyEnvVar: string;
      sdkProvider: LanguageModel;
    }

    export const llmProviderConfig: Record<string, ProviderConfig> = {
      anthropic: {
        apiKeyEnvVar: 'ANTHROPIC_API_KEY',
        sdkProvider: createAnthropic(),
      },
      openai: {
        apiKeyEnvVar: 'OPENAI_API_KEY',
        sdkProvider: createOpenAI(),
      },
    };
    ```

5.  **Testing & Quality Gate**:
    *   **Unit Test**: Create `tests/unit/fetch-models-dev.test.ts`. Mock the `fetch` call and test both successful and failing validation scenarios.
    *   **Quality Check**: Run `bun lint:fix` and `bun typecheck`.

---

#### **Phase 2: `LlmProviderManager` Implementation**

*Goal: Build the core service, including initialization, health checks, and the centralized `generateText` method.*

1.  **Define Types and Errors**:
    *   **File**: `server/llm/llm-provider.types.ts` - Define all necessary interfaces (`ProviderStatus`, `ModelMetadata`, `RegisteredProvider`, etc.).
    *   **File**: `server/llm/errors.ts` - Define `NoAvailableProvidersError`.
2.  **Implement the Manager Class**:
    *   **File**: `server/llm/llm-provider.manager.ts`
    *   **Constructor**: Implement logic to synchronously load `models-dev.data.json` and `provider.config.ts`.
    *   **`initialize()` Method**: Implement the non-blocking provider discovery and health check logic. Health checks should retry on failure before marking a provider as `unavailable`.
    *   **`generateText()` Method**: Implement the core logic:
        *   Accept `options` including a `models` array.
        *   Iterate through the `models` array.
        *   For each model, await its provider's health check.
        *   If the provider is `available`, attempt the LLM call.
        *   On success, record metrics and return the result.
        *   On failure, log the error and continue to the next model.
        *   If the loop finishes without success, throw `NoAvailableProvidersError`.
    *   **Stateful Tracking**: Add internal properties to track costs and token usage, and update them within `generateText`.

3.  **Testing & Quality Gate**:
    *   **Unit Test**: Create `tests/unit/llm-provider-manager.test.ts`. This is a critical test suite.
        *   Test initialization and data loading.
        *   Mock AI SDK providers to test health checks (success, failure, retry).
        *   Test the `generateText` fallback logic:
            *   Success on the first try.
            *   Success on the second try after the first fails.
            *   Throws `NoAvailableProvidersError` when all providers fail.
        *   Test stateful tracking of costs and tokens.
    *   **Quality Check**: Run `bun lint:fix` and `bun typecheck`.

---

#### **Phase 3: Chronicler Integration**

*Goal: Update the Chronicler system to use the new `LlmProviderManager`.*

1.  **Update Chronicler Configuration Schema**:
    *   **File**: `server/config-validation/chronicler.schema.ts`
    *   **Action**: Modify `tadpoleLlmCallParamsSchema` to remove the old `model` field and add the required `models: z.array(z.string())` field.
2.  **Update `ChroniclerManager`**:
    *   **File**: `server/chroniclers/chronicler-manager.ts`
    *   **Action**: Update `loadChroniclersForPhase` to accept the `LlmProviderManager` instance from `TadpoleServer` and pass it down to each `Chronicler` it creates.
3.  **Update `Chronicler` Class**:
    *   **File**: `server/chroniclers/chronicler.ts`
    *   **Constructor**: Modify to accept and store the `LlmProviderManager` instance.
    *   **`executeChroniclerCall()`**: Refactor this method completely. Remove the old `llmCall` logic. Replace it with a single call to `this.llmProviderManager.generateText()`, passing the required messages and the `models` array from its configuration. Wrap the call in a `try...catch` block to handle the `NoAvailableProvidersError` gracefully (e.g., log a warning and terminate the execution for that trigger).
4.  **Update `TadpoleServer`**:
    *   **File**: `server/tadpole-server.ts`
    *   **Action**: Instantiate `LlmProviderManager` at startup, call `initialize()`, and pass the instance to the `ChroniclerManager`.

5.  **Testing & Quality Gate**:
    *   **Integration Tests**: Update all existing Chronicler integration tests (`tests/integration/chronicler-*.test.ts`).
        *   The test harness will need to be updated to provide a mock `LlmProviderManager`.
        *   Update test configurations to use the new `models` array.
        *   Add specific tests for the fallback behavior and the `NoAvailableProvidersError` handling.
    *   **Quality Check**: Run `bun lint:fix` and `bun typecheck`.

### 4. Checklist of Required Changes

#### New Files to Create:
-   `[ ] scripts/fetch-models-dev.ts`
-   `[ ] server/llm/models-dev.schema.ts`
-   `[ ] server/llm/models-dev.data.json` (Generated)
-   `[ ] server/llm/provider.config.ts`
-   `[ ] server/llm/llm-provider.manager.ts`
-   `[ ] server/llm/llm-provider.types.ts`
-   `[ ] server/llm/errors.ts`
-   `[ ] tests/unit/fetch-models-dev.test.ts`
-   `[ ] tests/unit/llm-provider-manager.test.ts`

#### Existing Files to Modify:
-   `[ ] server/config-validation/chronicler.schema.ts` (Update `llmParams`)
-   `[ ] server/chroniclers/chronicler-manager.ts` (Pass manager instance)
-   `[ ] server/chroniclers/chronicler.ts` (Update constructor and `executeChroniclerCall`)
-   `[ ] server/tadpole-server.ts` (Instantiate and initialize the manager)
-   `[ ] tests/utils/chronicler-test-harness.ts` (Update to mock the new manager)
-   `[ ] All files in tests/integration/chronicler-*.test.ts` (Update tests to use new config and mocks)
