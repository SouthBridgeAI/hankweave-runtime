# Technical Debt Cleanup Plan: Removing Unused Cleanup System

## Executive Summary

The `server/cleanup/` folder contains a sophisticated but **completely unused** cleanup system that was designed before the execution isolation pivot. This represents significant technical debt: ~1,000 lines of dead code with associated tests but zero production usage.

## Investigation Findings

### What Exists

1. **Legacy System (`server/cleanup-command.ts`)**:
   - Simple "nuclear option" cleanup
   - Removes entire execution directories
   - **ACTIVELY USED** in production

2. **New System (`server/cleanup/` folder)**:
   - 5 modules: `types.ts`, `manifest-builder.ts`, `git-operations.ts`, `file-operations.ts`, `command-analyzer.ts`
   - Sophisticated manifest-based cleanup
   - Git integration for selective rollback
   - Command analysis for side effect prediction
   - **NEVER USED** in production

### Code Duplication

```typescript
// Both systems implement:
- getDirectorySize()      // ~30 lines duplicated
- formatSize()            // ~15 lines duplicated
- Directory removal logic // ~20 lines duplicated
- Confirmation prompts     // ~10 lines duplicated
```

### Timeline of Events

1. **Phase 1**: Langton runs directly in user directories
   - Need for surgical cleanup to avoid destroying user files
   - Design sophisticated manifest-based system

2. **Phase 2**: Pivot to execution isolation
   - Langton runs in separate directories
   - Cleanup becomes trivial: just delete the directory
   - Simple CleanupCommand is sufficient

3. **Phase 3**: Current state
   - Complex system implemented but never integrated
   - Simple system updated and actively used
   - ~1,000 lines of dead code remain

## Cleanup Plan

### Option 1: Complete Removal (RECOMMENDED)

**Rationale**: The sophisticated cleanup system solves a problem that no longer exists.

**Steps**:

1. **Remove server files**:
   ```bash
   rm -rf server/cleanup/
   ```

2. **Remove test files**:
   ```bash
   rm tests/unit/cleanup-command-analyzer.test.ts
   rm tests/unit/cleanup-git-operations.test.ts
   rm tests/unit/cleanup-file-operations.test.ts
   rm tests/unit/cleanup-manifest-builder.test.ts
   ```

3. **Extract reusable utilities**:
   - Move `getDirectorySize()` and `formatSize()` to `server/utils.ts`
   - Update `server/cleanup-command.ts` to import from utils

4. **Update documentation**:
   - Add note in architecture docs about execution isolation
   - Remove any references to manifest-based cleanup

### Option 2: Preserve for Future Rollback Feature

**Rationale**: The manifest system could enable phase-level rollbacks.

**Steps**:

1. **Move to experimental folder**:
   ```bash
   mkdir server/experimental
   mv server/cleanup server/experimental/manifest-cleanup
   ```

2. **Add documentation**:
   ```typescript
   // server/experimental/manifest-cleanup/README.md
   // This system was designed for in-place cleanup but could be
   // adapted for phase-level rollbacks in the future.
   ```

3. **Remove tests** (they're not testing used code):
   ```bash
   rm tests/unit/cleanup-*.test.ts  # except cleanup-command.test.ts
   ```

### Option 3: Salvage Useful Parts

**Rationale**: Some components have value beyond cleanup.

**What to keep**:
- `command-analyzer.ts` - Could predict command side effects
- `git-operations.ts` - Could enable git-based features

**What to remove**:
- `manifest-builder.ts` - Tightly coupled to old architecture
- `types.ts` - Specific to unused system
- `file-operations.ts` - Mostly duplicates existing utils

## Recommended Implementation

### Verification Results

Before proceeding, key claims have been verified:
- ✅ The `server/cleanup/` folder is completely unused (no imports anywhere)
- ✅ `CleanupCommand` is actively used in `server/index.ts` lines 125-137
- ✅ Code duplication confirmed between both implementations
- ✅ The sophisticated system was never integrated

### Step 1: Extract Shared Utilities

Add to existing `server/utils.ts` (not a new file):
```typescript
export async function getDirectorySize(
  dirPath: string,
  timeoutMs = 30000  // Preserve timeout feature from cleanup folder
): Promise<number> {
  let totalSize = 0;
  const startTime = Date.now();

  async function walkDir(currentPath: string): Promise<void> {
    // Check timeout
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`Directory size calculation timed out after ${timeoutMs}ms`);
    }

    const entries = await fs.promises.readdir(currentPath, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        await walkDir(fullPath);
      } else {
        try {
          const stats = await fs.promises.stat(fullPath);
          totalSize += stats.size;
        } catch {
          // Ignore files we can't stat
        }
      }
    }
  }

  await walkDir(dirPath);
  return totalSize;
}

export function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";

  const units = ["B", "KB", "MB", "GB"];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${(bytes / k ** i).toFixed(1)} ${units[i]}`;
}
```

### Step 2: Update CleanupCommand

```typescript
// server/cleanup-command.ts
import { getDirectorySize, formatSize } from "./utils.js";

// Remove duplicate implementations (lines 173-207)
```

### Step 3: Run Tests First

```bash
# Ensure nothing breaks before removing code
bun test tests/unit/cleanup-command.test.ts
```

### Step 4: Remove Dead Code

```bash
# Remove the entire cleanup folder
rm -rf server/cleanup/

# Remove associated test files (verify they exist first)
rm -f tests/unit/cleanup-command-analyzer.test.ts
rm -f tests/unit/cleanup-git-operations.test.ts
rm -f tests/unit/cleanup-file-operations.test.ts
rm -f tests/unit/cleanup-manifest-builder.test.ts
```

### Step 5: Run Tests Again

```bash
# Verify everything still works
bun test tests/unit/cleanup-command.test.ts
```

### Step 6: Document the Decision

Add to `documentation/architecture.md`:
```markdown
## Historical Note: Cleanup Systems

Tadpole originally included a sophisticated manifest-based cleanup system
designed for when it ran directly in user directories. After pivoting to
execution isolation, this system became unnecessary. The simple approach
of removing entire execution directories is sufficient and safer.

The unused system was removed in [date] to reduce technical debt.
```

## Impact Analysis

### Positive Impact
- **-1,000 lines** of unused code removed
- **-4 test files** that test unused code
- **Clearer architecture** without confusing dual systems
- **Reduced maintenance** burden

### Negative Impact
- Loss of potentially reusable git operations code
- Loss of command analysis capabilities
- Need to extract utilities before removal

### Additional Safety Features to Consider

While not needed for execution isolation, the cleanup folder's `file-operations.ts` contains defensive programming patterns worth noting:

```typescript
// Safety checks from cleanup/file-operations.ts
if (relative.startsWith("..") || path.isAbsolute(relative)) {
  throw new Error(`Refusing to delete directory outside project: ${dirPath}`);
}

const dangerousDirs = [".git", "node_modules", "/", "~", "."];
if (dangerousDirs.includes(basename) || dangerousDirs.includes(dirPath)) {
  throw new Error(`Refusing to delete potentially dangerous directory: ${dirPath}`);
}
```

These patterns could be useful for future file operations but aren't needed for the current cleanup system since execution directories are isolated by design.

### Risk Assessment
- **Low risk**: Code is completely unused
- **No production impact**: Only used system remains
- **Test coverage**: Existing tests for CleanupCommand remain


## Conclusion

The sophisticated cleanup system in `server/cleanup/` is technical debt from an architectural pivot. It should be removed entirely, with only the useful utility functions preserved. This will significantly simplify the codebase without any loss of functionality.

The execution isolation architecture makes complex cleanup unnecessary. Embrace the simplicity.
