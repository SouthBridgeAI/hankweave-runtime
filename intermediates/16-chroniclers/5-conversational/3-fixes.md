### **Objective**

Refactor the Chronicler system's persistence layer to use a new, phase-scoped filename convention (`<chroniclerId>-phase-<phaseId>.json`). This ensures that conversational history is isolated per phase and persists correctly across runs.

---

### **Step-by-Step Implementation Plan**

#### **Step 1: Update `HistoryManager` to Construct the Phase-Scoped Filename**

This is the foundational change. The `HistoryManager` will now be responsible for creating the unique, persistent filename using both the chronicler's ID and the phase's ID.

**File:** `server/chroniclers/history-manager.ts`

**Action:**
1.  Modify the `constructor` to accept a `phaseId` parameter.
2.  Update the logic that constructs `this.historyFilePath` to use the new naming convention.

```typescript
// server/chroniclers/history-manager.ts

// ... (imports)
import type { TrimingStrategy } from '../config-validation/chronicler.schema.js';
import type { PhaseId } from '../types/branded-types.js'; // Good practice to use the branded type

export class HistoryManager {
  // ... (existing properties)

  constructor(
    chroniclerId: string,
    phaseId: PhaseId, // <-- ADD this new parameter
    trimmingStrategy: TrimingStrategy,
    chroniclerDir?: string,
    logger?: Logger,
  ) {
    this.trimmingStrategy = trimmingStrategy;
    this.logger = logger;

    if (chroniclerDir) {
      // v-- THIS IS THE KEY CHANGE v--
      const filename = `${chroniclerId}-phase-${phaseId}.json`;
      this.historyFilePath = path.join(chroniclerDir, filename);
      // ^-- THIS IS THE KEY CHANGE ^--

      this.logger?.log(
        `[HistoryManager] Persistence for chronicler '${chroniclerId}' in phase '${phaseId}' enabled at: ${this.historyFilePath}`,
        'debug',
      );
    } else {
      this.logger?.log(
        `[HistoryManager:${chroniclerId}] Running in memory-only mode (no persistence)`,
        'info',
      );
    }
  }

  // ... (the rest of the class remains unchanged)
}
```

#### **Step 2: Update `Chronicler` to Receive and Forward the `phaseId`**

The `Chronicler` class acts as the bridge, receiving the `phaseId` from the manager and passing it down to the `HistoryManager` upon creation.

**File:** `server/chroniclers/chronicler.ts`

**Action:**
1.  Add a `phaseId` parameter to the `constructor`.
2.  Pass this `phaseId` when creating a new `HistoryManager` instance.

```typescript
// server/chroniclers/chronicler.ts

// ... (imports)
import type { PhaseId } from '../types/branded-types.js';

export class Chronicler {
  // ... (existing properties)

  constructor(
    private config: ChroniclerConfig,
    private phaseId: PhaseId, // <-- ADD this new parameter
    private llmCall: (id: string, events: ServerEvent[]) => Promise<unknown>,
    private logger?: Logger,
    chroniclerDir?: string,
  ) {
    this.triggerEngine = createTriggerEngine(config.trigger, logger);

    if (config.conversational) {
      // v-- PASS the phaseId to the HistoryManager v--
      this.historyManager = new HistoryManager(
        config.id,
        this.phaseId, // <-- Pass the phaseId here
        config.conversational.trimmingStrategy,
        chroniclerDir,
        this.logger,
      );
      // ... (logging)
    }
    // ... (rest of constructor)
  }

  // ... (the rest of the class remains unchanged)
}
```

#### **Step 3: Update `ChroniclerManager` to Accept `phaseId` During Loading**

Rename the method to better reflect its phase-scoped nature and inject the `phaseId` context at the moment the chroniclers are loaded.

**File:** `server/chroniclers/chronicler-manager.ts`

**Action:**
1.  Rename `loadChroniclers` to `loadChroniclersForPhase`.
2.  Modify the method signature to accept a `phaseId`.
3.  Pass this `phaseId` down when creating each new `Chronicler` instance.

```typescript
// server/chroniclers/chronicler-manager.ts

// ... (imports)
import type { PhaseId } from '../types/branded-types.js';

export class ChroniclerManager {
  // ... (constructor and other properties remain unchanged)

  /**
   * Load chronicler configurations for a specific phase.
   * @param configs - The chronicler configurations to load.
   * @param phaseId - The ID of the phase these chroniclers belong to.
   * @param llmCall - The function to execute for LLM calls.
   */
  public async loadChroniclersForPhase(
    configs: ChroniclerConfig[],
    phaseId: PhaseId, // <-- ADD this new parameter
    llmCall: (id: string, events: ServerEvent[]) => Promise<unknown>,
  ): Promise<void> {
    await this.initialize();
    this.llmCallFunction = llmCall;

    for (const config of configs) {
      try {
        const chronicler = new Chronicler(
          config,
          phaseId, // <-- Pass the phaseId here
          llmCall,
          this.logger,
          this.chroniclerDir,
        );
        this.chroniclers.push(chronicler);
        this.logger?.log(
          `[ChroniclerManager] Loaded chronicler '${config.id}' for phase '${phaseId}'`,
          'info'
        );
      } catch (error) {
        this.logger?.log(
          `[ChroniclerManager] Failed to load chronicler ${config.id}: ${error}`,
          'error',
        );
      }
    }
  }

  // ... (the rest of the class remains unchanged)
}
```

#### **Step 4: Update Tests**

The following test files need to be updated to accommodate the new `phaseId` parameter:

**Files to Update:**
1. `tests/unit/history-manager.test.ts` - Add `phaseId` to all `HistoryManager` constructor calls
2. `tests/integration/chronicler-conversational.test.ts` - Add `phaseId` to `Chronicler` constructor calls and update `ChroniclerManager.loadChroniclersForPhase` calls
3. `tests/integration/chronicler-triggers.test.ts` - Update `ChroniclerManager.loadChroniclersForPhase` calls
4. `tests/integration/chronicler-edge-cases.test.ts` - Update `ChroniclerManager.loadChroniclersForPhase` calls

**Example Updates:**

```typescript
// In tests/unit/history-manager.test.ts
const historyManager = new HistoryManager(
  "test-chronicler",
  PhaseId("test-phase"), // <-- Add this
  { type: "maxTurns", maxTurns: 5 },
  tempDir,
  mockLogger,
);

// In tests/integration/chronicler-conversational.test.ts
await manager.loadChroniclersForPhase( // <-- Renamed method
  [narratorConfig],
  PhaseId("test-phase"), // <-- Add this
  mockLlmCall,
);
```

#### **Note: Phase Config Integration Deferred**

The integration with `TadpoleServer` and adding `chroniclers` field to the phase configuration schema will be implemented in a future phase. This change focuses solely on the infrastructure for phase-scoped persistence.

---

### **Summary**

This refactoring ensures that:
1. Each conversational chronicler maintains separate history per phase
2. History persists correctly across server restarts and rollbacks
3. The API clearly indicates the phase-scoped nature of chroniclers
4. Tests are updated to reflect the new structure

The implementation represents approximately **150 lines of production code changes** and **50-100 lines of test updates**.
