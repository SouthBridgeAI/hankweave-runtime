Here's a focused unit test plan for components that don't need Claude log fixtures:

## **1. config.ts**

### `calculateCost()`

```typescript
describe("calculateCost", () => {
  const costs = DEFAULT_CONFIG.costsPerMTok;

  test("calculates zero cost for zero tokens");
  test("calculates cost for only input tokens");
  test("calculates cost for only output tokens");
  test("calculates cost for mixed token types");
  test("handles very large token counts without overflow");
  test("maintains precision to 6 decimal places");
  test("calculates cache tokens correctly");
});
```

### `loadPhaseConfig()`

```typescript
describe("loadPhaseConfig", () => {
  test("loads valid configuration");
  test("throws on missing required fields");
  test("throws on invalid model names");
  test("validates promptFile XOR promptText");
  test("validates appendSystemPromptFile XOR appendSystemPromptText");
  test("resolves relative paths correctly");
  test("handles array of prompt files");
  test("validates workspace setup items");
  test("throws on non-existent prompt files");
  test("throws on unreadable files");
});
```

## **2. utils.ts**

### `escapeShellArg()`

```typescript
describe("escapeShellArg", () => {
  test("escapes single quotes correctly");
  test("handles empty strings");
  test("handles strings with newlines");
  test("handles strings with special shell characters ($, `, \\, !)");
  test("handles unicode characters");
  test("handles very long strings");
  test("prevents command injection attempts");
});
```

### `buildFileTree()`

```typescript
describe("buildFileTree", () => {
  // Using temp directory, no Claude needed
  test("builds tree from flat file list");
  test("handles nested directories correctly");
  test("sorts files within directories");
  test("includes lastModified for files");
  test("marks directories with isDirectory flag");
  test("handles empty directories");
  test("handles files at root level");
});
```

## **3. checkpoint-git.ts**

### `CheckpointGit.updateGitignore()`

```typescript
describe("CheckpointGit exclude patterns", () => {
  test("generates correct exclude for single pattern");
  test("generates correct exclude for multiple patterns");
  test("handles patterns with wildcards correctly");
  test("unignores parent directories for nested patterns");
  test("handles patterns starting with ./");
  test("handles directory-only patterns (ending with /)");
  test("generates correct exclude when no patterns");
});
```

### `CheckpointGit.commit()`

```typescript
describe("CheckpointGit commit", () => {
  test("formats commit message correctly");
  test("creates branch when specified");
  test("returns null when no changes and allowEmpty false");
  test("creates empty commit when allowEmpty true");
  test("switches back to main after branch commit");
});
```

## **4. claude-process-manager.ts**

### `buildClaudeArgs()`

```typescript
describe("ClaudeProcessManager.buildClaudeArgs", () => {
  test("builds basic args correctly");
  test("adds continuation args when previousSessionId provided");
  test("escapes system prompt correctly");
  test("handles missing system prompt");
  test("validates model parameter");
});
```

### `buildSystemPrompt()`

```typescript
describe("ClaudeProcessManager.buildSystemPrompt", () => {
  test("returns null when no system prompt configured");
  test("reads single file correctly");
  test("concatenates multiple files with double newlines");
  test("replaces PROJECT_DIR template variable");
  test("handles multiple template variables");
  test("prefers file over text when both provided");
});
```

## **5. type-guards.ts**

### Event Type Guards

```typescript
describe("Event type guards", () => {
  describe("isPhaseStartedEvent", () => {
    test("returns true for valid phase started event");
    test("returns false for missing data");
    test("returns false for missing phaseId");
    test("returns false for wrong event type");
  });

  describe("isErrorEvent", () => {
    test("returns true for valid error event");
    test("returns false for missing message");
    test("handles events with null data");
  });

  // Similar patterns for other guards
});
```

### Command Type Guards

```typescript
describe("Command type guards", () => {
  describe("isStartPhaseCommand", () => {
    test("returns true for valid start command");
    test("returns false for missing phaseId");
    test("returns false for non-object data");
    test("handles skipPreCommands field");
  });

  // Similar for other command guards
});
```

## **6. error-types.ts**

### Error Classes

```typescript
describe("Error classes", () => {
  describe("FatalError", () => {
    test("sets severity to FATAL");
    test("includes context when provided");
    test("has correct error name");
  });

  describe("PhaseError", () => {
    test("includes phaseId in context");
    test("merges additional context");
    test("sets severity to PHASE");
  });
});
```

## **7. Path Security Tests**

### `copyPath()` validation (mock the actual copy)

```typescript
describe("Path validation", () => {
  test("rejects paths with ..");
  test("rejects absolute paths as 'to' parameter");
  test("allows absolute paths as 'from' parameter");
  test("rejects symlinks pointing outside project");
  test("validates target parent directory exists");
  test("handles Windows path separators");
});
```

## **8. Complex Business Logic**

### Phase Sequencing

```typescript
describe("getNextPhaseIndex", () => {
  test("returns 0 when no phases completed");
  test("returns next index after last completed");
  test("returns -1 when all phases completed");
  test("handles non-sequential completion (after skip)");
});
```

### Session ID Chaining

```typescript
describe("getPreviousSessionId", () => {
  // Can mock file system
  test("returns null for first phase");
  test("returns null when previous phase failed");
  test("extracts UUID from successful phase log");
  test("returns null when log file missing");
  test("returns null when continueFromPrevious is false");
});
```

## **Test Structure**

```
tests/unit/
├── config.test.ts
├── utils.test.ts
├── checkpoint-git.test.ts
├── claude-process-manager.test.ts
├── type-guards.test.ts
├── error-types.test.ts
├── path-validation.test.ts
└── business-logic.test.ts
```

## **Key Testing Principles**

1. **Test edge cases**: Empty inputs, very large inputs, special characters
2. **Test error paths**: What happens when things go wrong
3. **Test boundaries**: Off-by-one errors, array bounds
4. **Test security**: Injection attempts, path traversal
5. **Test precision**: Financial calculations, floating point
6. **Test platform differences**: Windows vs Unix paths

These tests can all run without any Claude interaction or saved logs, making them fast and reliable. They focus on the critical business logic, security, and data integrity aspects of the system.
