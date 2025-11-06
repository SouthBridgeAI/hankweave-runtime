### **Technical Plan: Implementing Stateful Conversational Chroniclers**

**Intent:** This plan outlines the technical steps to build a stateful conversational capability into the Chronicler system. It focuses on creating a clean separation of concerns, ensuring data persistence and recovery, and providing a flexible configuration schema. The implementation will be done in isolation and thoroughly tested before integration with `TadpoleServer`.

#### **Part 1: A Refined and Explicit Configuration Schema**

We'll add an optional `conversational` field to the existing schema to enable stateful conversation mode. This approach is backward compatible and doesn't conflict with the existing prompt fields.

**File to Modify:** `server/config-validation/chronicler.schema.ts`

**Key Changes:**

1.  **Add Optional Conversational Config:** Add a `conversational` field with trimming strategy configuration.
2.  **Keep Existing Prompt Fields:** The existing `systemPromptFile`, `systemPromptText`, `userPromptFile`, and `userPromptText` fields remain unchanged.
3.  **Trimming Strategy:** Define how to manage conversation history size.
4.  **System Prompt Required for Conversational:** Use `.refine()` to ensure conversational chroniclers have a system prompt.

```typescript
// --- Trimming Strategy Schema (for Conversational mode) ---
// Intent: Define how the conversation history is pruned to stay within LLM context limits
const trimmingStrategySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("maxTurns"),
    maxTurns: z.number().int().positive().max(100)
  }),
  z.object({
    type: z.literal("maxTokens"),
    maxTokens: z.number().int().positive().max(100000)
  }),
]);

// --- Update Main Chronicler Schema ---
export const chroniclerConfigSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  description: z.string().optional(),
  trigger: chroniclerTriggerSchema,
  execution: chroniclerExecutionSchema,

  // Existing prompt fields remain
  systemPromptFile: z.union([z.string(), z.array(z.string())]).optional(),
  systemPromptText: z.string().optional(),
  userPromptFile: z.union([z.string(), z.array(z.string())]).optional(),
  userPromptText: z.string().optional(),

  // NEW: Optional conversational configuration
  // When present, enables stateful conversation tracking across triggers
  conversational: z.object({
    trimmingStrategy: trimmingStrategySchema
  }).optional(),

  model: z.enum(["sonnet", "opus"]).optional(),
  output: z.object({ /* ... */ }).optional(),
})
.strict()
.refine((data) => data.userPromptFile || data.userPromptText, {
  message: "Each chronicler must have at least one of `userPromptFile` or `userPromptText` defined.",
  path: [],
})
.refine((data) => {
  // Conversational chroniclers require a system prompt to establish context
  if (data.conversational) {
    return data.systemPromptFile || data.systemPromptText;
  }
  return true;
}, {
  message: "Conversational chroniclers require a system prompt (systemPromptFile or systemPromptText).",
  path: ["conversational"],
});

// Export derived types from the schemas (single source of truth)
export type ChroniclerConfig = z.infer<typeof chroniclerConfigSchema>;
export type TrimingStrategy = z.infer<typeof trimmingStrategySchema>;
export type ConversationalConfig = z.infer<typeof chroniclerConfigSchema>["conversational"];
```

#### **Part 2: The Conversation History Manager**

**Intent:** To create a new, dedicated class that encapsulates all logic related to managing a single chronicler's conversational state. This keeps the main `Chronicler` class clean and focused on orchestration. The history manager is responsible for maintaining conversation continuity across multiple trigger events.

**New File:** `server/chroniclers/history-manager.ts`

**Responsibilities:**

*   Loading history from a file on initialization, with recovery logic.
*   Appending new user and assistant messages with validation.
*   Automatically pruning the history based on the configured strategy.
*   Providing the full message history for an LLM call.
*   Persisting the history back to disk (if directory provided).
*   **NO system prompt storage** - only conversation history
*   **NO event templating** - receives already-formatted user message strings

**Important Note:** The HistoryManager does not handle event templating or serialization. It receives already-formatted strings for user messages. The conversion from `ServerEvent[]` to formatted text happens at a higher level (in the Chronicler or its caller).

```typescript
import type { Logger } from '../utils.js';
import type { TrimingStrategy } from '../config-validation/chronicler.schema.js';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
  TadpoleModelMessage,
  TadpoleUserModelMessage,
  TadpoleAssistantModelMessage,
  TadpoleSystemModelMessage,
} from '../types/input-ai-types.js';
import { tadpoleModelMessageSchema } from '../types/input-ai-types.js';

// Simple token counter - approximate 4 chars per token
// Intent: Provide a rough estimate for pruning without external dependencies
export const simpleTokenCounter = (text: string): number => {
  return Math.ceil(text.length / 4);
};

export class HistoryManager {
  private history: Array<TadpoleUserModelMessage | TadpoleAssistantModelMessage> = [];
  private readonly historyFilePath?: string;  // Optional - no file if no dir provided
  private readonly trimmingStrategy: TrimingStrategy;
  private readonly logger?: Logger;
  private isInitialized = false;
  private hasPendingUserMessage = false;  // Track if we're waiting for assistant response

  constructor(
    chroniclerId: string,
    trimmingStrategy: TrimingStrategy,
    chroniclerDir?: string,  // Optional - if not provided, no persistence
    logger?: Logger
  ) {
    this.trimmingStrategy = trimmingStrategy;
    this.logger = logger;

    // Only set up file path if directory is provided
    if (chroniclerDir) {
      this.historyFilePath = path.join(chroniclerDir, `${chroniclerId}.json`);
      this.logger?.log(
        `[HistoryManager:${chroniclerId}] Persistence enabled at ${this.historyFilePath}`,
        'debug'
      );
    } else {
      this.logger?.log(
        `[HistoryManager:${chroniclerId}] Running in memory-only mode (no persistence)`,
        'info'
      );
    }
  }

  // Initialize on first use - loads history if file exists
  private async ensureInitialized(): Promise<void> {
    if (this.isInitialized) return;

    // Load existing history if we have a file path
    if (this.historyFilePath) {
      await this.loadFromFile();
    }

    this.isInitialized = true;
  }

  // Add a new user message with validation
  // Intent: Ensure conversation integrity by preventing multiple user messages without responses
  public async addUserMessage(userContent: string, force = false): Promise<void> {
    await this.ensureInitialized();

    // Check for pending user message (missing assistant response)
    if (this.hasPendingUserMessage && !force) {
      const error = `Cannot add user message - still waiting for assistant response from previous message`;
      this.logger?.log(`[HistoryManager] ERROR: ${error}`, 'error');
      throw new Error(error);
    }

    this.history.push({ role: 'user', content: userContent });
    this.hasPendingUserMessage = true;

    this.logger?.log(
      `[HistoryManager] Added user message (${userContent.length} chars). Total messages: ${this.history.length}`,
      'debug'
    );
  }

  // Get messages to send to LLM (with automatic pruning)
  // Intent: Prepare the complete message list including system prompt and pruned history
  public async getMessagesToSend(
    systemPrompt: string,
    forceSkipPruning = false
  ): Promise<TadpoleModelMessage[]> {
    await this.ensureInitialized();

    // Prune if needed (unless explicitly skipped)
    if (!forceSkipPruning) {
      this.prune();
    }

    // Build the messages array with system prompt + history
    const messages: TadpoleModelMessage[] = [
      { role: 'system', content: systemPrompt } as TadpoleSystemModelMessage,
      ...this.history
    ];

    this.logger?.log(
      `[HistoryManager] Prepared ${messages.length} messages for LLM (including system prompt)`,
      'debug'
    );

    return messages;
  }

  // Add the assistant's response and save immediately
  // Intent: Complete the conversation turn and persist to disk
  public async addAssistantResponse(assistantContent: string): Promise<void> {
    await this.ensureInitialized();

    if (!this.hasPendingUserMessage) {
      this.logger?.log(
        `[HistoryManager] WARNING: Adding assistant response without pending user message`,
        'warn'
      );
    }

    this.history.push({ role: 'assistant', content: assistantContent });
    this.hasPendingUserMessage = false;  // Clear the pending flag

    this.logger?.log(
      `[HistoryManager] Added assistant response (${assistantContent.length} chars). Total messages: ${this.history.length}`,
      'debug'
    );

    // Save immediately if we have persistence enabled
    if (this.historyFilePath) {
      await this.saveToFile();
    }
  }

  // Prune history based on strategy
  // Intent: Keep conversation within LLM context limits by removing oldest messages
  private prune(): void {
    const originalLength = this.history.length;

    if (this.trimmingStrategy.type === 'maxTurns') {
      const maxTurns = this.trimmingStrategy.maxTurns;

      // Count complete turns (user + assistant pairs)
      const userMessages = this.history.filter(m => m.role === 'user').length;
      const assistantMessages = this.history.filter(m => m.role === 'assistant').length;
      const completeTurns = Math.min(userMessages, assistantMessages);

      if (completeTurns > maxTurns) {
        // Remove oldest complete turns
        const turnsToRemove = completeTurns - maxTurns;
        const messagesToRemove = turnsToRemove * 2; // Each turn has user + assistant

        const removed = this.history.splice(0, messagesToRemove);
        this.logger?.log(
          `[HistoryManager] Pruned ${removed.length} messages (${turnsToRemove} turns) to stay within maxTurns=${maxTurns}`,
          'info'
        );
      }
    } else if (this.trimmingStrategy.type === 'maxTokens') {
      const maxTokens = this.trimmingStrategy.maxTokens;

      // Calculate total tokens
      let totalTokens = this.history.reduce((sum, msg) => sum + simpleTokenCounter(msg.content), 0);

      // Remove oldest messages until under limit
      let removedCount = 0;
      while (totalTokens > maxTokens && this.history.length > 0) {
        const removed = this.history.shift();
        if (removed) {
          totalTokens -= simpleTokenCounter(removed.content);
          removedCount++;
        }
      }

      if (removedCount > 0) {
        this.logger?.log(
          `[HistoryManager] Pruned ${removedCount} messages to stay within maxTokens=${maxTokens}. Remaining: ${this.history.length}`,
          'info'
        );
      }
    }
  }

  // Load history from file (simple JSON format)
  // Intent: Restore conversation state from previous runs
  private async loadFromFile(): Promise<void> {
    if (!this.historyFilePath) return;

    try {
      const content = await fs.readFile(this.historyFilePath, 'utf-8');
      const parsed = JSON.parse(content);

      // Validate the loaded data using Tadpole schemas
      if (Array.isArray(parsed)) {
        const valid: Array<TadpoleUserModelMessage | TadpoleAssistantModelMessage> = [];
        for (const msg of parsed) {
          const result = tadpoleModelMessageSchema.safeParse(msg);
          if (result.success && (result.data.role === 'user' || result.data.role === 'assistant')) {
            valid.push(result.data as TadpoleUserModelMessage | TadpoleAssistantModelMessage);
          }
        }
        this.history = valid;

        // Check if last message is user (pending response)
        if (this.history.length > 0 && this.history[this.history.length - 1].role === 'user') {
          this.hasPendingUserMessage = true;
          this.logger?.log(
            `[HistoryManager] Loaded history with pending user message`,
            'warn'
          );
        }

        this.logger?.log(
          `[HistoryManager] Loaded ${this.history.length} messages from file`,
          'info'
        );
      } else {
        this.logger?.log(
          `[HistoryManager] Invalid history file format, starting fresh`,
          'warn'
        );
        this.history = [];
      }
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // File doesn't exist yet, that's fine
        this.logger?.log(`[HistoryManager] No existing history file, starting fresh`, 'debug');
      } else {
        this.logger?.log(`[HistoryManager] Error loading history: ${error}`, 'error');
      }
      this.history = [];
    }
  }

  // Save history to file (simple JSON format)
  // Intent: Persist conversation state for recovery across server restarts
  private async saveToFile(): Promise<void> {
    if (!this.historyFilePath) return;

    const tempPath = `${this.historyFilePath}.tmp`;

    try {
      // Write to temp file first (atomic write pattern)
      await fs.writeFile(tempPath, JSON.stringify(this.history, null, 2), 'utf-8');

      // Atomic rename
      await fs.rename(tempPath, this.historyFilePath);

      this.logger?.log(
        `[HistoryManager] Saved ${this.history.length} messages to file`,
        'debug'
      );
    } catch (error) {
      this.logger?.log(`[HistoryManager] Error saving history: ${error}`, 'error');

      // Clean up temp file if it exists
      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}
```

#### **Part 3: Minimal Chronicler Class Updates**

**Intent:** For now, we'll just add the HistoryManager to the Chronicler class without implementing the actual LLM call flow. This allows us to test the history management independently.

**File to Modify:** `server/chroniclers/chronicler.ts`

```typescript
// Add to existing imports
import { HistoryManager } from './history-manager';

export class Chronicler {
  // ... existing fields
  private readonly historyManager?: HistoryManager; // Optional, only for conversational

  constructor(
    private config: ChroniclerConfig,
    private llmCall: (id: string, events: ServerEvent[]) => Promise<string>,
    private logger?: Logger,
    chroniclerDir?: string  // Optional - passed from parent for persistence
  ) {
    // ... existing constructor code

    // Create history manager if conversational mode is enabled
    // Intent: Only create history manager for conversational chroniclers
    if (config.conversational) {
      this.historyManager = new HistoryManager(
        config.id,
        config.conversational.trimmingStrategy,
        chroniclerDir,  // May be undefined - that's OK, runs in memory-only mode
        this.logger
      );

      this.logger?.log(
        `[Chronicler:${config.id}] Initialized conversational mode with ${config.conversational.trimmingStrategy.type} trimming`,
        'info'
      );
    }
  }

  // Expose history manager for testing (temporary)
  // This will be removed once we implement the full flow
  public getHistoryManager(): HistoryManager | undefined {
    return this.historyManager;
  }

  // The existing handleEvent, flush, destroy methods remain unchanged
  // The actual integration with processTriggeredEvents will come later
}
```

**Note:** The actual integration of conversational mode with the trigger execution flow will be implemented in a future phase. For now, we're just ensuring the HistoryManager is properly instantiated and can be tested.

#### **Part 4: Update ChroniclerManager to Handle Directory Creation**

**Intent:** The ChroniclerManager should create and manage the chronicler directory, passing it to individual chroniclers.

**File to Modify:** `server/chroniclers/chronicler-manager.ts`

```typescript
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export class ChroniclerManager {
  private chroniclers: Map<string, Chronicler> = new Map();
  private chroniclerDir?: string;

  constructor(
    private logger?: Logger,
    enablePersistence = true  // Allow disabling persistence for testing
  ) {
    // Set up chronicler directory if persistence is enabled
    if (enablePersistence) {
      this.chroniclerDir = path.join('.tadpole', 'chroniclers');
    }
  }

  // Initialize the manager and create directory if needed
  // Intent: Ensure chronicler directory exists before creating any chroniclers
  public async initialize(): Promise<void> {
    if (this.chroniclerDir) {
      try {
        await fs.mkdir(this.chroniclerDir, { recursive: true });
        this.logger?.log(
          `[ChroniclerManager] Created/verified chronicler directory at ${this.chroniclerDir}`,
          'debug'
        );
      } catch (error) {
        this.logger?.log(
          `[ChroniclerManager] Failed to create directory ${this.chroniclerDir}: ${error}. Running without persistence.`,
          'warn'
        );
        this.chroniclerDir = undefined;  // Disable persistence on error
      }
    }
  }

  // Load chroniclers from configuration
  public async loadChroniclers(
    configs: ChroniclerConfig[],
    llmCall: (id: string, events: ServerEvent[], messages?: any[]) => Promise<string>
  ): Promise<void> {
    // Ensure we're initialized
    await this.initialize();

    for (const config of configs) {
      try {
        // Create chronicler with optional directory for persistence
        const chronicler = new Chronicler(
          config,
          llmCall,
          this.logger,
          this.chroniclerDir  // Pass directory (may be undefined)
        );

        this.chroniclers.set(config.id, chronicler);

        this.logger?.log(
          `[ChroniclerManager] Loaded chronicler: ${config.id}`,
          'info'
        );
      } catch (error) {
        this.logger?.log(
          `[ChroniclerManager] Failed to load chronicler ${config.id}: ${error}`,
          'error'
        );
      }
    }
  }

  // ... rest of the manager implementation
}
```

#### **Part 5: Testing Strategy (Focus on History Manager)**

**Intent:** To create focused unit tests for the HistoryManager and configuration validation, without requiring full chronicler integration.

**New File:** `tests/unit/history-manager.test.ts`

**Test Cases for HistoryManager:**

1.  **Basic Operations:**
    *   Create a HistoryManager and add user/assistant messages
    *   Verify `getMessagesToSend()` returns properly formatted TadpoleModelMessage[]
    *   Verify system prompt is included as first message

2.  **History Loading:**
    *   Create a pre-populated JSON history file
    *   Create a new HistoryManager instance
    *   Verify it loads the history correctly
    *   Verify pending user message detection works

3.  **`maxTurns` Pruning:**
    *   Set `maxTurns: 2`
    *   Add 3 turns of conversation
    *   Call `getMessagesToSend()` and verify only 2 turns are returned

4.  **`maxTokens` Pruning:**
    *   Set `maxTokens: 100`
    *   Add messages with varying content length
    *   Verify pruning keeps total under token limit

5.  **Pending Message Validation:**
    *   Try to add a user message when one is already pending
    *   Assert that it throws an error
    *   Test the `force` parameter to override

6.  **Memory-Only Mode:**
    *   Create HistoryManager without directory
    *   Verify it works but doesn't persist
    *   Create new instance and verify history is empty

7.  **Persistence and Recovery:**
    *   Create HistoryManager with persistence enabled
    *   Add user and assistant messages
    *   Verify JSON file is created after assistant response
    *   Create new instance and verify history is loaded

8.  **Message Type Validation:**
    *   Load a history file with invalid message formats
    *   Verify only valid TadpoleUserModelMessage and TadpoleAssistantModelMessage are kept
    *   Verify invalid messages are filtered out

**New File:** `tests/unit/chronicler-conversational-config.test.ts`

**Test Cases for Configuration:**

1.  **Valid Conversational Config:**
    *   Create config with conversational field and system prompt
    *   Verify validation passes

2.  **Missing System Prompt:**
    *   Create conversational chronicler without system prompt
    *   Assert validation error

3.  **Trimming Strategy Validation:**
    *   Test valid maxTurns and maxTokens configurations
    *   Test invalid values (negative, too large, wrong types)

4.  **Backward Compatibility:**
    *   Verify existing chronicler configs without conversational field still work

By focusing on testing the HistoryManager and configuration independently, we can ensure these core components work correctly before integrating them with the full chronicler execution flow.
