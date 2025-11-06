Investigation Report: ChroniclerManager Test Failures (Created by Zed agent)

## Table of Contents
1. [Original Problem](#original-problem)
2. [Initial Code Intent](#initial-code-intent)
3. [Investigation Path](#investigation-path)
4. [False Leads](#false-leads)
5. [Root Cause Discovery](#root-cause-discovery)
6. [Solution](#solution)

---

## Original Problem

### Symptoms
19 test failures across multiple integration test files:
- `chronicler-triggers.test.ts`: 8 failures
- `chronicler-edge-cases.test.ts`: 2 failures
- `chronicler-output-files.test.ts`: 8 failures
- `chronicler-conversational.test.ts`: 1 failure

### Error Patterns
Two distinct error types emerged:

**Type 1: Mock never called**
```typescript
expect(mock.toHaveBeenCalled()).toBe(true)
// Expected: true
// Received: false
```

**Type 2: Files not created**
```typescript
expect(fs.existsSync(autoDir)).toBe(true)
// Expected: true
// Received: false

// Or:
const files = fs.readdirSync(autoDir);
// ENOENT: No such file or directory
```

---

## Initial Code Intent

### The Original Design (Lines 301-355 in chronicler-manager.ts)

```typescript
const hasRealProviders = this.providerRegistry &&
  Array.from(this.providerRegistry.getProviderStatus().values())
    .some(s => s.status === "available");

for (const config of configs) {
  const isFullModelId = config.model?.includes("/");

  if (hasRealProviders && isFullModelId) {
    // Check if model exists in registry
    const modelInfoResult = this.providerRegistry.getModelInfo(config.model);
    if (!modelInfoResult.success) {
      this.logger?.log(`Skipping chronicler: Model not found`, "info");
      continue;  // Skip this chronicler
    }

    // Check if provider is healthy
    if (!providerStatus.healthy) {
      this.logger?.log(`Skipping chronicler: Provider not healthy`, "info");
      continue;  // Skip this chronicler
    }
  }

  // Create chronicler with:
  chronicler = new Chronicler(
    config,
    phaseId,
    hasRealProviders && isFullModelId
      ? concreteLlmCall    // Use real AI SDK
      : mockOrFallbackLlmCall,  // Use mock
    // ...
  );
}
```

### Design Intent
The code was designed to:
1. **Differentiate between production and test environments** based on model naming
   - Models with `/` (e.g., `anthropic/claude-haiku-4-5`) → Production, use real providers
   - Models without `/` (e.g., `test-model`) → Test, use mocks

2. **Skip chroniclers when providers unavailable**
   - If model not found in registry → Skip
   - If provider not healthy → Skip
   - This prevents runtime errors in production

3. **Respect provider availability**
   - Only use real providers when they're actually configured and healthy
   - Fall back to mocks when providers aren't available

### Why This Made Sense
- Production code would always use full model IDs: `anthropic/claude-3-5-sonnet-20241022`
- Tests would use simple names: `test-model`
- The `/` character serves as a natural discriminator
- Prevents chroniclers from running with invalid/unavailable models

---

## Investigation Path

### Phase 1: Initial Analysis from AI #1

**First theory:** Multiple independent issues
1. Output files not being created → File system problem?
2. Mocks not being called → Event triggering problem?
3. Memory-only mode log missing → Configuration problem?

**Led us to examine:**
- File path resolution in `Chronicler.initializeOutputFiles()`
- Event handling in `ChroniclerManager.handleEvent()`
- The `runChroniclerTest()` harness
- Persistence vs output files confusion

**Key insight from this phase:**
> "The tests DO pass executionPath... So the issue is that the chroniclers are not executing at all - the mock LLM is being called but the output files are not being created."

This was partially correct but missed the deeper issue.

### Phase 2: Root Cause Analysis from AI #2

**Second theory:** Provider registry blocks test mocks

**The breakthrough observation:**
```typescript
// In test harness:
const manager = new ChroniclerManager();  // No options!

// This creates a REAL registry:
this.providerRegistry = options.providerRegistry ||
  new LlmProviderRegistry({
    logger: this.logger,
    performHealthCheckOnInit: false,
  });
```

**Critical realization:**
- `LlmProviderRegistry` reads from environment variables
- If `ANTHROPIC_API_KEY` is set → provider status = `"available"`
- `hasRealProviders` becomes `true`
- Test configs use full model IDs with `/`
- Provider checks run → chronicler skipped OR real provider used (not mock!)

**This explained:**
- Why tests are environment-dependent (fail with API keys, pass without)
- Why mocks aren't being called
- Why the behavior is inconsistent across different machines

### Phase 3: Examining Test Patterns

We discovered **three distinct test patterns:**

**Pattern A: E2E Tests (Want Real Providers)**
```typescript
const realRegistry = new LlmProviderRegistry({...});
const manager = new ChroniclerManager({ providerRegistry: realRegistry });

await manager.loadChroniclersForPhase([config], phaseId, {
  llmCallOverride: async () => {
    throw new Error("Mock function should not be called with real providers");
  },
});
```
- Explicitly pass real registry
- Provide throwing mock as **safety guard**
- **Expect:** Real provider used, mock never called

**Pattern B: Integration Tests with Mock Registry (Working)**
```typescript
const mockRegistry = createMockLlmProviderRegistry();
const manager = new ChroniclerManager({ providerRegistry: mockRegistry });

await manager.loadChroniclersForPhase([config], phaseId, {
  llmCallOverride: mockLlm,
});
```
- Pass mock registry (reports `status: "not-configured"`)
- `hasRealProviders` = `false`
- Mock is used ✓

**Pattern C: Integration Tests without Registry (Broken)**
```typescript
const manager = new ChroniclerManager();  // No registry!

await manager.loadChroniclersForPhase([config], phaseId, {
  llmCallOverride: mockLlm,
});
```
- No registry → creates real one from environment
- If API keys present → `hasRealProviders` = `true`
- Provider checks run → chroniclers skipped
- Mock never called ✗

---

## False Leads

### False Lead #1: Missing `executionPath`
**Theory:** Tests don't provide `executionPath`, so chroniclers run in no-op mode

**Evidence that seemed to support it:**
- `runChroniclerTest()` doesn't pass `executionPath`
- `Chronicler.initializeOutputFiles()` returns empty path when no `executionPath`
- Output files not being created

**Why it was wrong:**
- `chronicler-output-files.test.ts` **does** provide `executionPath`
- Those tests still fail
- The real issue is chroniclers aren't executing at all (not even reaching the file write stage)

**What we learned:**
- This IS a real issue but not the root cause
- It contributes to the problem but doesn't explain all failures

### False Lead #2: `enablePersistence: false` Conflicts with Output Files
**Theory:** Tests set `enablePersistence: false` but expect output files

**Evidence that seemed to support it:**
```typescript
const manager = new ChroniclerManager({ enablePersistence: false });
// But then:
expect(fs.existsSync(autoDir)).toBe(true);  // Expects files!
```

**Why it was wrong:**
- There are **two separate persistence mechanisms**:
  - `enablePersistence`: Controls `.tadpole/chroniclers/history/` (conversational history)
  - `executionPath`: Controls `.tadpole/chronicler-outputs/` (chronicler outputs)
- They're independent
- `enablePersistence: false` should NOT prevent output files

**What we learned:**
- The naming is confusing
- But the logic is actually correct
- Not the root cause

### False Lead #3: Test Model Names
**Theory:** Tests should use `"test-model"` instead of `"anthropic/claude-haiku-4-5"`

**Evidence that seemed to support it:**
- Tests that use `"test-model"` work
- Tests that use `"anthropic/..."` fail
- The `/` character triggers provider checks

**Why it was partially wrong:**
- This would "fix" the symptoms
- But it doesn't address the actual design flaw
- Test configs might be used in real E2E tests later
- We'd lose the ability to use realistic model names in tests

**What we learned:**
- Model naming convention IS part of the problem
- But changing test configs is a workaround, not a fix
- The real issue is that the manager doesn't respect `llmCallOverride` when provided

---

## Root Cause Discovery

### The Aha Moment

Looking at the E2E test pattern:
```typescript
llmCallOverride: async () => {
  throw new Error("Mock function should not be called with real providers");
}
```

**Question:** Why would tests provide an override that throws?

**Answer:** Because they DON'T want it to be used! They want the real provider.

**Realization:** The override is a **safety check**, not a fallback.

### The Design Flaw

The current logic says:
> "If you have real providers AND a full model ID, use the real provider. Otherwise, use the override."

But it should say:
> "If you provide an override, use it. If you don't, then check for real providers."

**The Intent vs. Reality Gap:**

| Test Type | Provides Override? | Wants to Use | Current Behavior | Should Be |
|-----------|-------------------|--------------|------------------|-----------|
| E2E | Yes (throwing) | Real provider | ✓ Real provider | ✓ Real provider |
| Integration | Yes (working mock) | Mock | ✗ Real provider OR skipped | ✓ Mock |
| Integration w/ mock registry | Yes (working mock) | Mock | ✓ Mock | ✓ Mock |

The middle row is the problem!

### The Root Cause

**When `llmCallOverride` is provided, it should be treated as an explicit instruction:**
- "I'm taking control of LLM calls"
- "Skip provider checks"
- "Use my function"

**But the current code treats it as a fallback:**
- "If I can use a real provider, I will"
- "Only use your override if I can't find a real provider"

This inversion of priority is the bug.

---

## Solution

### The Fix

**Change 1: Detect Override Mode**
```typescript
// Check if we're in override mode (test/mock mode)
const useOverrideMode = !!(mockOrFallbackLlmCall || mockOrFallbackLlmObjectCall);

// Only check real providers if NOT in override mode
const hasRealProviders =
  !useOverrideMode &&
  this.providerRegistry &&
  Array.from(this.providerRegistry.getProviderStatus().values())
    .some(s => s.status === "available");
```

**Change 2: Prioritize Override**
```typescript
// Use override if provided (test/mock mode), otherwise use real provider
mockOrFallbackLlmCall ||
  (hasRealProviders && isFullModelId
    ? concreteLlmCall
    : (async () => { throw new Error("No LLM provider available"); }))
```

**Change 3: Fix E2E Tests**

Remove the throwing override from `chronicler-structured-output-e2e.test.ts`:
```typescript
// Before:
await manager.loadChroniclersForPhase([config], phaseId, {
  llmCallOverride: async () => {
    throw new Error("Mock function should not be called with real providers");
  },
  // ...
});

// After:
await manager.loadChroniclersForPhase([config], phaseId, {
  // No llmCallOverride - intentionally using real provider for E2E test
  // ...
});
```

### Why This Works

**For broken integration tests:**
1. They provide `llmCallOverride`
2. `useOverrideMode` = `true`
3. Provider checks **skipped**
4. Mock **always used**
5. Tests pass ✓

**For E2E tests (after removing throwing override):**
1. No `llmCallOverride` provided
2. `useOverrideMode` = `false`
3. Provider checks **run**
4. Real provider **used**
5. Tests pass ✓

**For integration tests with mock registry:**
1. They provide `llmCallOverride`
2. `useOverrideMode` = `true`
3. Mock **always used** (even though registry is mock)
4. Tests pass ✓

### Impact Analysis

**Tests Fixed:** 19
- `chronicler-triggers.test.ts`: 8 tests
- `chronicler-edge-cases.test.ts`: 2 tests
- `chronicler-output-files.test.ts`: 8 tests
- `chronicler-conversational.test.ts`: 1 test

**Tests Modified:** 8
- `chronicler-structured-output-e2e.test.ts`: Remove throwing override from 8 tests

**Tests Unaffected:** All others continue to work

### Additional Fix Needed

The `runChroniclerTest()` harness still needs to provide `executionPath`:

```typescript
export async function runChroniclerTest(
  logFilePath: string,
  chroniclerConfigs: ChroniclerConfig[],
): Promise<MockLlmCall> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicler-test-'));

  const manager = new ChroniclerManager();

  await manager.loadChroniclersForPhase(chroniclerConfigs, PhaseId("test-phase"), {
    llmCallOverride: mockLlmCall.fn,
    executionPath: tempDir,  // ← Add this
    onExecute,
  });

  // ... run test ...

  // Cleanup
  fs.rmSync(tempDir, { recursive: true, force: true });
}
```

---

## Lessons Learned

### Design Principles

1. **Explicit > Implicit:** When a user provides an override, that's an explicit instruction to use it
2. **Test > Production:** Defaults should favor production, but explicit test overrides should always win
3. **Fail Fast:** If no provider and no override, fail immediately (don't silently skip)

### Testing Insights

1. **Environment dependence is a smell:** Tests that pass/fail based on environment variables are unreliable
2. **Mock registries are good:** Integration tests should inject mock dependencies, not rely on environment
3. **Safety guards can be misleading:** The throwing override made it look like a real mock was expected

### Code Organization

1. **Two-phase initialization:** Constructor + explicit `initialize()` makes testing harder
2. **Registry auto-creation:** Creating real registry by default in constructor couples tests to environment
3. **Implicit mode switching:** Using model name syntax (`/`) to switch between modes is clever but fragile

---

## Conclusion

The root cause was a **priority inversion**: the code treated `llmCallOverride` as a fallback when it should be treated as a directive. This caused tests to attempt using real providers (which weren't available or were incorrectly configured), leading to chroniclers being silently skipped.

The fix inverts the priority: "Override provided? Use it. No override? Check providers." This makes tests deterministic, explicit, and independent of environment configuration.