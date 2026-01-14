# Refactoring Guide: Finalizing the Hankweave Renaming

**Objective**: Complete the transition of terminology by renaming remaining artifacts of "Tadpole", "Phase", "Workspace", and "Chronicler" to "Hankweave", "Codon", "Rig", and "Sentinel" respectively.

**Constraint**: Ensure all changes preserve functionality. Most changes are in comments, string literals for logs, test data, and local variable names.

## 1. `server/state-manager.ts`

This file contains the bulk of the remaining old terminology in variable names and comments.

### Rename `tadpoleDir`
- **Location**: Constructor and private properties.
- **Change**: Rename `private readonly tadpoleDir: string` to `private readonly hankweaveDir: string` (or `stateDir`).
- **Update**: Update all references (e.g., `this.statePath = path.join(tadpoleDir, ...)`).

### Rename `Phase` -> `Codon` (Variables & Comments)
- **Method Comments**:
  - `getCodonById`: Change "Get phase entry" to "Get codon entry".
  - `expandNextIterationForCodon`: Change "phase completion" to "codon completion".
  - `isContextExceededAcceptable`: Change "given phase" to "given codon".
  - `getNextCodonToExecute`: Change "Get the next phase" to "Get the next codon".
  - `canContinueFrom`: Change "Check if the phase exists" to "Check if the codon exists".
  - `getCheckpointForContinuation`: Change "Find the specified phase" to "Find the specified codon" and "phase.status" to "codon.status".
- **Variables**:
  - In `isContextExceededAcceptable`, rename `const phaseEntry` to `const codonEntry`.
  - In `getExecutionThread`, rename `phaseConfigs` (in comment/logic if present) or "Fallback: Convert phaseConfigs..." comment to "Fallback: Convert codonConfigs...".
- **Log Messages**:
  - Change `[getNextPhaseToExecute]` to `[getNextCodonToExecute]`.

### Rename `Chronicler` -> `Sentinel` (Comments)
- **Location**: Inside `applyTransition` switch cases (e.g., `CodonTransitioned` case, `RunFailed` case).
- **Change**:
  - `// Transition from running to completing-chroniclers` -> `// Transition from running to completing-sentinels`.
  - `// Can transition from running OR completing-chroniclers` -> `// Can transition from running OR completing-sentinels`.
  - `// Find the phase - can be ... or completing-chroniclers` -> `... or completing-sentinels`.
  - `// Rename chroniclers.loaded → chroniclers.executed` -> `// Rename sentinels.loaded → sentinels.executed`.

### Rename `Workspace` -> `Rig` (Comments)
- **Location**: `getCheckpointForContinuation` method.
- **Change**: `// Continue from beginning - use first phase's workspace setup` -> `// Continue from beginning - use first codon's rig setup`.

---

## 2. `server/hankweave-runtime.ts`

### Log Messages & Comments
- **Search**: "phase"
- **Change**:
  - `Context exceeded error detected for phase ${codonId}` -> `... for codon ${codonId}`.
  - `// Determine final status based on the actual phase outcome` -> `... actual codon outcome`.
  - `Phase completed successfully due to context exceeded` -> `Codon completed successfully...`.
  - `// Check if this completed phase is part of a loop` -> `// Check if this completed codon is part of a loop`.

---

## 3. `server/config.ts`

### Variable Names
- **Location**: `validateCodonOrLoopRecursive` function.
- **Change**: Rename `const phaseContext` to `const codonContext`.

---

## 4. Tests (`tests/`)

Update test data and assertions to reflect the new terminology.

### Configuration Files (`tests/config/*.json`)
- **Files**: `test-context-exhaustion.config.json`, `test-context-exhaustion-with-iteration-terminate.config.json`.
- **Change**: Update names and IDs.
  - `"name": "Initial Setup Phase"` -> `"name": "Initial Setup Codon"`
  - `"name": "Final Phase After Loop"` -> `"name": "Final Codon After Loop"`
  - `"name": "Fresh Phase"` -> `"name": "Fresh Codon"`
  - `"id": "phase-1"` -> `"id": "codon-1"`

### Unit & E2E Tests
- **Location**: `tests/long-running/context-exhaustion-e2e.test.ts`
  - Change console logs: `"[test] Final phase started"` -> `"[test] Final codon started"`.
  - Change assertions looking for `"Phase completed successfully..."` to look for `"Codon completed successfully..."`.
- **Location**: `tests/unit/state-manager.test.ts`
  - Rename test descriptions: `"returns false for regular codon (not in loop)"` (if it currently says phase).
  - Rename IDs in test data: `id: CodonId("regular-phase")` -> `id: CodonId("regular-codon")`.

---

## 5. Summary Checklist

- [ ] **State Manager**: Rename `tadpoleDir`, `phase` vars/comments, `chronicler` comments, `workspace` comments.
- [ ] **Runtime**: Update "phase" log messages.
- [ ] **Config**: Rename `phaseContext`.
- [ ] **Tests**: Update "Phase" in test data IDs, names, and console logs.