# Architectural Plan (Revised): The `LlmProviderManager`

### 1. Executive Summary

This document outlines the revised architectural plan for the `LlmProviderManager`, a stateful, resilient system for managing connections to Large Language Model (LLM) providers within the Tadpole Runner.

This plan incorporates feedback to create a robust, decoupled, and maintainable system. Key changes from the initial plan include:

1.  **Offline Model Data**: Instead of fetching from `models.dev` on every server start, a separate script will download, validate, and store the model data locally. This removes a potential point of failure and network dependency from the server's critical startup path.
2.  **Centralized Call Logic**: The `LlmProviderManager` will expose its own `generateText` and `streamText` methods, encapsulating all fallback logic, error handling, and state tracking. This simplifies consumer code (like Chroniclers) significantly.
3.  **Stateful Tracking**: The manager will actively track runtime metrics, including total calls, token usage, and costs for each provider and model, fulfilling a core requirement.

The result is a powerful, centralized service that abstracts away all complexities of LLM provider management.

### 2. Core Components & Data Flow

#### A. `scripts/fetch-models-dev.ts` (New Script)

*   **Purpose**: A standalone Bun script to refresh the local `models.dev` data.
*   **Execution**: Run manually by a developer when model data needs updating.
*   **Workflow**:
    1.  Fetches `https://models.dev/api.json`.
    2.  Validates the downloaded JSON against a strict Zod schema (`server/llm/models-dev.schema.ts`).
    3.  On success, overwrites the local data file at `server/llm/models-dev.data.json`.
    4.  On failure, logs a detailed error and exits, leaving the old data file intact.

#### B. `server/llm/models-dev.schema.ts` (New Schema)

*   **Purpose**: Defines the Zod schema for validating the data from `models.dev`. This is the single source of truth for the expected data structure.
*   **Key Fields**: `provider`, `modelId`, `name`, `cost`, `limit`, `modalities`, etc.

#### C. `server/llm/models-dev.data.json` (New Data File)

*   **Purpose**: The local, version-controlled copy of the model data.
*   **Source**: Generated and updated only by the `fetch-models-dev.ts` script.
*   **Role**: Provides the `LlmProviderManager` with a fast, reliable, and offline source of model metadata.

#### D. `LlmProviderManager` (New Core Service)

A stateful singleton class that serves as the central nervous system for all LLM interactions.

*   **Lifecycle**: Instantiated once at `TadpoleServer` startup. Its `initialize()` method will be called, which remains non-blocking.
*   **Key Responsibilities**:
    1.  **Load Local Data**: Synchronously loads `models-dev.data.json` and a new provider configuration file into memory on instantiation.
    2.  **Provider Discovery**: Scans environment variables based on the provider configuration to determine which providers are potentially available.
    3.  **Asynchronous Health Checks**: For each discovered provider, it instantiates the Vercel AI SDK `LanguageModel` and runs a non-blocking health check (with retries) to validate credentials and connectivity.
    4.  **Runtime Registry**: Maintains an internal registry of providers, their status (`available`, `degraded`, `unavailable`), and their associated models from the local data file.
    5.  **Centralized Call Execution**: Exposes `generateText` and `streamText` methods. These methods contain the core fallback logic.
    6.  **Stateful Tracking**: Maintains an in-memory state of usage metrics (call counts, token usage, total cost) aggregated by provider and model.
    7.  **Error Management**: Tracks runtime errors. If a provider consistently fails, its status can be downgraded to `degraded` or `unavailable`, temporarily removing it from the fallback pool.

#### E. `Chronicler` (Updated Consumer)

*   **Role**: Becomes a simple, clean consumer of the `LlmProviderManager`.
*   **Workflow**:
    1.  Receives the `LlmProviderManager` instance in its constructor.
    2.  When triggered, it makes a single call: `await this.llmProviderManager.generateText({ messages, models: this.config.models })`.
    3.  All complexity of model selection, fallback, and error handling is handled by the manager.

### 3. TypeScript Interfaces

```typescript
// server/llm/llm-provider.types.ts

import type { LanguageModel } from 'ai';
import { TadpoleGenerateTextOptions, TadpoleGenerateTextResult } from '../types/llm-call-types';

export type ProviderStatus = 'pending' | 'available' | 'degraded' | 'unavailable';

export interface ModelMetadata {
  id: string;
  name: string;
  contextWindow: number;
  inputCostPerMillionTokens?: number;
  outputCostPerMillionTokens?: number;
  // ... other fields from models.dev
}

export interface RegisteredProvider {
  id: string; // 'anthropic', 'openai'
  status: ProviderStatus;
  instance: LanguageModel;
  models: Map<string, ModelMetadata>;
  healthCheckPromise: Promise<void>;
  failureReason?: string;
}

export interface LlmProviderManager {
  initialize(): void;
  getProviderStatus(providerId: string): ProviderStatus;
  getModelMetadata(modelId: string): ModelMetadata | null;

  generateText(
    options: TadpoleGenerateTextOptions & { models: string[] }
  ): Promise<TadpoleGenerateTextResult>;

  // streamText would have a similar signature
}
```

### 4. Detailed Execution Flow

#### Stage 1: Offline Data Preparation (Developer Task)

1.  A developer runs `bun run scripts/fetch-models-dev.ts`.
2.  The script downloads the latest model data, validates it against the Zod schema.
3.  The `server/llm/models-dev.data.json` file is updated.
4.  The developer commits this updated file to the repository.

#### Stage 2: Server Startup

1.  `TadpoleServer` starts and creates the `LlmProviderManager` singleton.
2.  The manager's constructor synchronously reads and parses `models-dev.data.json` and the provider configuration.
3.  `TadpoleServer` calls `llmProviderManager.initialize()`.
4.  The `initialize` method scans the provider config, checks for corresponding environment variables (e.g., `ANTHROPIC_API_KEY`), and for each one found, it kicks off a non-blocking `healthCheck()` and sets the provider's status to `pending`.
5.  Server startup continues without waiting for health checks.

#### Stage 3: A Chronicler Makes an LLM Call

1.  A `Chronicler` is triggered.
2.  It constructs its `TadpoleGenerateTextOptions` and includes its model fallback list, e.g., `models: ["anthropic:claude-3-5-sonnet-20240620", "openai:gpt-4o-mini"]`.
3.  It makes a single call: `await this.llmProviderManager.generateText(options)`.
4.  Inside `LlmProviderManager.generateText`:
    a. It iterates through the `models` array.
    b. For the first model (`anthropic:claude-3-5-sonnet-20240620`), it looks up the `anthropic` provider.
    c. It `await`s the `healthCheckPromise` for the `anthropic` provider, ensuring the check is complete before proceeding.
    d. If the provider status is `available`, it performs the actual `generateText` call using the provider's `LanguageModel` instance.
    e. **On Success**: It records the token usage and cost, then returns the `TadpoleGenerateTextResult`. The process stops.
    f. **On Failure**: It logs the error, increments the failure count for that model/provider, and proceeds to the next model in the fallback list (`openai:gpt-4o-mini`). The process repeats.
5.  If the entire fallback chain is exhausted without success, the `generateText` method throws a specific `NoAvailableProvidersError`.
6.  The `Chronicler` receives the result (or catches the error) and proceeds accordingly.

### 5. Configuration

#### Provider Configuration (`server/llm/provider.config.ts`)

A new configuration file will map provider IDs to AI SDK implementations and environment variables.

```typescript
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';

export const llmProviderConfig = {
  anthropic: {
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    sdkProvider: createAnthropic(),
  },
  openai: {
    apiKeyEnvVar: 'OPENAI_API_KEY',
    sdkProvider: createOpenAI(),
  },
  // Add new providers here
};
```

#### Chronicler Configuration (`phases.json`)

The `llmParams` in the chronicler config will now primarily use the `models` array.

```json
{
  "id": "narrator",
  "llmParams": {
    "temperature": 0.1,
    "models": [
      "anthropic:claude-3-5-sonnet-20240620", // Primary
      "openai:gpt-4o-mini"                   // Fallback
    ]
  }
}
```

### 6. Benefits of this Revised Architecture

*   **Robustness**: Server startup is no longer dependent on an external API.
*   **Maintainability**: Model data is managed and version-controlled explicitly. Provider logic is cleanly separated.
*   **Simplicity**: Consumers of the service have a very simple API (`generateText`), hiding significant complexity.
*   **Observability**: Centralized stateful tracking provides a clear view of LLM costs, usage, and reliability across the entire application.
*   **Extensibility**: Adding a new provider is straightforward: add it to the config, update the `fetch-models` script if needed, and the system will integrate it.
