# Chronicler Trigger System - Review and Outstanding Issues

## Current State of Implementation

### ✅ What's Complete
1. **Type Definitions** (`server/types/chronicler-types.ts`)
   - All interfaces for triggers, conditions, execution strategies
   - Discriminated unions for type safety

2. **Event Schemas** (`server/config-validation/event-schemas.ts`)
   - Mapping of ServerEvent types to Zod schemas
   - BUT: Using `z.any()` for complex types (see issues below)

3. **Configuration Validation** (`server/config-validation/chronicler.schema.ts`)
   - Comprehensive Zod schemas with path validation
   - Validates that condition paths exist in event types
   - BUT: Still has some `any` types for Zod shape introspection

4. **Condition Evaluator** (`server/chroniclers/condition-evaluator.ts`)
   - Evaluates all 8 operators
   - Type-safe with `Record<string, unknown>` instead of `any`

5. **Trigger Engine** (`server/chroniclers/trigger-engine.ts`)
   - EventTriggerEngine (stateless)
   - SequenceTriggerEngine (stateful with history)
   - Factory function for creating engines

6. **Unit Tests** (`tests/unit/chronicler-validation.test.ts`)
   - 13 tests all passing
   - Validates configuration and path checking

### ❌ What's NOT Complete

1. **NOT HOOKED INTO TADPOLE SERVER**
   - No ChroniclerManager created yet
   - TadpoleServer doesn't know about chroniclers
   - No event subscription mechanism
   - No LLM execution logic

2. **Missing Components Still Needed:**
   - `server/chroniclers/chronicler-manager.ts` - Orchestrates multiple chroniclers
   - `server/chroniclers/chronicler.ts` - Individual chronicler instance
   - Integration with TadpoleServer's event emitter
   - Execution strategy handlers (debounce, count, timeWindow)
   - LLM prompt formatting and execution
   - Output file writing

## Critical Issues to Address

### 1. Two Sources of Truth Problem ⚠️

**The Problem:** We now have TypeScript types in `types.ts` AND Zod schemas in `event-schemas.ts` that could diverge.

**Current State:**
```typescript
// In event-schemas.ts
"state.snapshot": z.object({
  currentPhase: z.any().optional(), // PhaseExecution type is complex, using any for now
  completedPhases: z.array(z.any()),
  fileTree: z.array(z.any()),
  // ...
})
```

**Solutions:**
1. **Option A: Generate Zod schemas from TypeScript types**
   - Use a library like `ts-to-zod` or `zod-prisma-types`
   - Ensures single source of truth
   - BUT: May not handle all complex types

2. **Option B: Generate TypeScript types from Zod schemas**
   - Define everything in Zod first
   - Use `z.infer<>` for TypeScript types
   - More runtime safety
   - BUT: Major refactor needed

3. **Option C: Manual sync with tests** (Current approach)
   - Keep both, add tests to ensure they match
   - More maintenance burden
   - BUT: Most flexible

**Recommendation:** For now, Option C with comprehensive tests. Long-term, move to Option B.

### 2. Loose Event Schemas Problem ⚠️

**The Problem:** Many schemas use `z.any()` which defeats type safety:
- `currentPhase: z.any().optional()`
- `completedPhases: z.array(z.any())`
- `fileTree: z.array(z.any())`

**Impact:**
- Path validation can't check nested properties in these fields
- No compile-time safety for chronicler conditions
- Runtime errors possible

**Solution Needed:**
```typescript
// Instead of:
currentPhase: z.any().optional()

// Should be:
const phaseExecutionSchema = z.object({
  phaseId: z.string(),
  status: z.enum(['preparing', 'starting', 'initializing', 'running', 'completed', 'failed', 'skipped']),
  startTime: z.string(),
  // ... all fields
});

// Then:
currentPhase: phaseExecutionSchema.optional()
```

### 3. Integration Path Not Clear ⚠️

**What needs to happen:**
1. Update `server/config.ts` to load chronicler configs
2. Create ChroniclerManager that subscribes to TadpoleServer events
3. Modify TadpoleServer to instantiate ChroniclerManager
4. Add chronicler lifecycle management (start/stop with phases)

## Linting Issues Status

### Fixed ✅
- `server/chroniclers/condition-evaluator.ts` - Replaced `any` with `Record<string, unknown>`
- `server/config-validation/chronicler.schema.ts` - `getValueByPath` uses `unknown` instead of `any`

### Remaining Issues
- `server/config-validation/chronicler.schema.ts` lines 76, 178 - Uses `any` for Zod shape introspection
  - **Why not fixed:** Zod's internal types are complex, would need significant refactoring
  - **Impact:** Low - only used internally for validation logic

## Annotations Added to Code

### Type Safety Improvements
```typescript
// Before:
export function evaluateCondition(condition: Condition, eventData: any): boolean

// After:
export function evaluateCondition(condition: Condition, eventData: Record<string, unknown>): boolean
```

### Documentation Improvements
- Added JSDoc comments explaining parameters
- Clarified that `eventData` comes from `ServerEvent.data`
- Added notes about AND logic for multiple conditions

## Next Steps Priority

1. **HIGH: Fix Event Schemas**
   - Replace all `z.any()` with proper schemas
   - Add tests to ensure TypeScript types match Zod schemas

2. **HIGH: Create Integration Test**
   - Load websocket logs
   - Run chroniclers against them
   - Verify triggers fire correctly

3. **MEDIUM: Build ChroniclerManager**
   - Subscribe to events
   - Manage chronicler lifecycle
   - Handle execution strategies

4. **MEDIUM: Hook into TadpoleServer**
   - Update config loading
   - Instantiate manager
   - Clean up on phase completion

5. **LOW: Add More Chronicler Examples**
   - File change monitor
   - Cost tracker
   - Error rate monitor
   - Progress narrator

## Testing Strategy

### Current Tests
- Unit tests for validation ✅
- Path checking tests ✅

### Needed Tests
1. **Integration tests with real logs**
   - Load websocket logs from `tests/test-data/websocket-logs/`
   - Create test chroniclers
   - Verify trigger timing

2. **Event schema consistency tests**
   - Ensure Zod schemas match TypeScript types
   - Validate all event types have schemas

3. **Performance tests**
   - Many chroniclers running simultaneously
   - Large event histories
   - Memory usage monitoring

## Summary

The trigger system foundation is solid and well-tested, but it's **not yet integrated** into the main system. The main concerns are:

1. **Not hooked in** - No connection to TadpoleServer yet
2. **Type safety gaps** - Event schemas using `z.any()`
3. **Two sources of truth** - TypeScript types vs Zod schemas could diverge

These issues should be addressed before the chronicler system can be considered production-ready.
