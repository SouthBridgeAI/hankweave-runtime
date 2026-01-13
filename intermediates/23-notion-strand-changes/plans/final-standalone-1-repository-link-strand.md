# ENG-105: Running Strands from Repository URLs

> **Implementation Order:** Phase 4 (last) - See [00-index.md](00-index.md) for full context

## Related Plans

This task should be implemented after CLI improvements are complete, as it builds on patterns established there:

- **[ENG-106: Command Line Improvements](final-standalone-2-command-line-improvements.md)** - Introduces CLI patterns this task follows (space-separated flags, argument parsing helpers)
- **[ENG-93: Simple Input Text](final-standalone-3-simple-input-text-data.md)** - Similar URL detection patterns can be reused

## Task Summary

Enable Strandweave to run strands directly from Git repository URLs, allowing users to share and execute strand workflows without manual cloning. The user provides a repository URL instead of a local path, and Strandweave downloads it to a local cache before execution.

**Original Request (Hrishi Olickel):**
> "It would be awesome if we could provide strandweave with a strand link that is a specific permalink to a strand (or a repo url where the toplevel of the repo has a strand.json). If it's public (or accessible), we should be able to download it somewhere, get the strand, preflight it and run it, no? We can also prevent redownloading, support loading from different commits, etc etc."

## Sources and Context

### Linear Ticket
- **Identifier:** ENG-105
- **Status:** In Progress
- **Priority:** Medium
- **Created:** 2026-01-12

### Original Planning Documents
The following documents were synthesized by the Step 4 Agent to create this plan:
- [`supporting-docs/1-repository-link-strand-full-task.md`](supporting-docs/1-repository-link-strand-full-task.md) - Original task with Step 1/2/3 agent analysis
- [`supporting-docs/1-repository-link-strand-related-code.md`](supporting-docs/1-repository-link-strand-related-code.md) - Codebase integration points
- [`supporting-docs/1-repository-link-strand-changes-decisions-and-judgement-calls.md`](supporting-docs/1-repository-link-strand-changes-decisions-and-judgement-calls.md) - Technical decisions

### Key Research Findings (from Step 3 Agent)
The Step 3 Agent's research revealed important context about Git-based systems:

1. **Package managers moving away from Git-as-database:** Cargo migrated from Git index to sparse HTTP protocol (99% adoption by April 2025). Go modules saw 90x performance improvement moving from Git-based resolution to module proxy. However, our use case is different: we clone once for execution, not indexing thousands of packages. This validates the simpler Git-clone approach for Strandweave.

2. **Security vulnerabilities in Git clone operations:** CVE-2025-48384 demonstrates that malicious `.gitmodules` files can enable arbitrary filesystem writes and remote code execution. Repositories with symbolic links and Git LFS filters can execute scripts during clone. This reinforces the need for security prompts before executing downloaded strands.

3. **Unix stdin convention:** The `-` convention for stdin dates back to Ken Thompson in Version 5 Unix. If stdin support is ever added, `--data=-` would be the correct syntax (not directly related to this task, but noted for future reference).

## Decision Points and Judgement Calls

### Decision 1: Git-Only Approach (Use simple-git exclusively)

**The Step 4 Agent recommends:** Clone repositories using `simple-git` with `--depth 1` shallow clones. Do not add HTTP client libraries for raw file downloads.

**Rationale:**
- `simple-git` is already a dependency used by `server/checkpoint-git.ts` for the checkpoint system
- Git handles authentication automatically (SSH keys, credential helpers)
- Git naturally supports versioning (commits, branches, tags) matching the `@ref` syntax
- Shallow clones (`--depth 1`) avoid performance issues that plagued package managers

**Alternative rejected:** Adding `node-fetch` to support raw GitHub URLs like `https://raw.githubusercontent.com/...`. This would add complexity, require custom auth handling, and provide no natural versioning support.

### Decision 2: Cache Structure Mirrors URL Paths

**Cache location:** `~/.strandweave-cache/strands/`

**Directory structure:**
```
~/.strandweave-cache/strands/
  github.com/
    user/
      repo/
        main/           # Branch-based cache
        abc123def/      # Commit SHA-based cache
        v1.0.0/         # Tag-based cache
```

This structure is intuitive for debugging (mirrors URLs), allows separate cleanup of different versions, and makes cache inspection straightforward.

### Decision 3: Version Reference Syntax

**Syntax:** Append `@ref` to the URL to specify a version.

```bash
# Latest on default branch
strandweave --config=https://github.com/user/repo

# Specific branch
strandweave --config=https://github.com/user/repo@develop

# Specific commit
strandweave --config=https://github.com/user/repo@abc123def456

# Specific tag
strandweave --config=https://github.com/user/repo@v1.0.0
```

This follows npm/cargo convention (`package@version`), is easy to parse (split on last `@`), and distinguishes from URL fragments.

### Decision 4: Caching Behavior by Reference Type

| Reference Type | Cache Behavior |
|---------------|----------------|
| Commit SHA | Cache forever (immutable) |
| Tags | Cache until explicit `--update-cache` (treat as immutable but allow refresh) |
| Branches | Check for updates after TTL (default: 1 hour) |
| No version | Always fetch latest on default branch |

**Cache metadata file** (stored in each cache directory):
```json
{
  "url": "https://github.com/user/repo",
  "ref": "main",
  "type": "branch",
  "lastFetched": "2026-01-13T10:30:00Z",
  "commitSha": "abc123def456",
  "ttl": 3600
}
```

### Decision 5: Security and Trust Model

**First-run prompt (CRITICAL for safety):**

When a remote strand is downloaded for the first time, Strandweave must display a security summary and require confirmation:

```
Downloading strand from: https://github.com/user/repo@main

Strand configuration summary:
  - Name: "Code Analyzer"
  - Codons: 3
  - Models: sonnet
  - Rig setup operations: 2
    1. Copy: ../templates/config.json -> config/analyzer.json
    2. Command: npm install
  - Tracked files: ["analysis.md", "results/**"]
  - Output files: ["analysis.md"]

This strand will execute commands on your system.
Review the strand configuration at: ~/.strandweave-cache/strands/github.com/user/repo/main/strand.json

Do you want to continue? [y/N]
```

**Trust levels:**
1. **First run:** Always prompt (unless `--yes` flag)
2. **Cached run (unchanged):** Skip prompt if strand.json content matches cached version
3. **Updated run:** Prompt again if strand.json content differs from previous execution

**Bypass mechanisms:**
- `--yes` flag for CI/CD environments
- Environment variable `STRANDWEAVE_TRUST_REPOS` for whitelisting specific repositories

### Decision 6: Error Handling Philosophy

Provide actionable error messages with recovery steps. Examples:

**Network error:**
```
Failed to download strand: Network error
URL: https://github.com/user/repo
Error: getaddrinfo ENOTFOUND github.com

Check your internet connection and try again.

To use a cached version (if available):
strandweave --offline --config=https://github.com/user/repo
```

**Authentication error:**
```
Failed to download strand: Authentication required
URL: git@github.com:user/private-repo.git

This repository appears to be private.
Make sure you have:
1. SSH key configured: ~/.ssh/id_rsa
2. Access to the repository

To configure SSH key for Git:
ssh-keygen -t rsa -b 4096 -C "your_email@example.com"
ssh-add ~/.ssh/id_rsa
```

**Invalid strand after download:**
```
Invalid strand configuration
URL: https://github.com/user/repo
Downloaded to: ~/.strandweave-cache/strands/github.com/user/repo/main

Validation errors:
- Codon "analyze" (codon-1): promptFile "prompts/analyze.md" does not exist

The cached download will be removed to avoid using invalid configuration.
```

### Decision 7: Invalid Strands are Removed from Cache

If a downloaded strand fails validation, remove it immediately from the cache. Keeping invalid strands could lead to confusing behavior on retry. Log the cache location before removal so users can inspect it for debugging if needed.

## Implementation Plan

### Phase 1: URL Detection and Basic Git Clone

**Files to modify:**

1. **`server/index.ts`** (lines 101-103, 249-253)

   Current code:
   ```typescript
   const configPath = args.find((arg) => arg.startsWith("--config="))?.split("=")[1] || "strand.json";
   // ...later...
   const absoluteConfigPath = path.isAbsolute(configPath)
     ? configPath
     : path.resolve(originalCwd, configPath);
   ```

   Modified code:
   ```typescript
   const configPath = args.find((arg) => arg.startsWith("--config="))?.split("=")[1] || "strand.json";

   // Detect if configPath is a URL and resolve it
   let absoluteConfigPath: string;
   if (isStrandUrl(configPath)) {
     const cacheResult = await resolveRemoteStrand(configPath, {
       forceUpdate: args.includes("--update-cache"),
       skipPrompt: args.includes("-y") || args.includes("--yes"),
       offline: args.includes("--offline"),
     });
     absoluteConfigPath = path.join(cacheResult.cachePath, "strand.json");
   } else {
     absoluteConfigPath = path.isAbsolute(configPath)
       ? configPath
       : path.resolve(originalCwd, configPath);
   }
   ```

2. **Create `server/strand-downloader.ts`** (new file)

   This module handles all remote strand operations:

   ```typescript
   import simpleGit from "simple-git";
   import path from "node:path";
   import os from "node:os";
   import fs from "node:fs";

   const CACHE_BASE = path.join(os.homedir(), ".strandweave-cache", "strands");

   export interface ParsedStrandUrl {
     protocol: "https" | "ssh";
     host: string;
     owner: string;
     repo: string;
     ref?: string;
   }

   export function isStrandUrl(input: string): boolean {
     return input.startsWith("https://") ||
            input.startsWith("http://") ||
            input.startsWith("git@");
   }

   export function parseStrandUrl(url: string): ParsedStrandUrl {
     // Implementation handles:
     // - https://github.com/user/repo
     // - https://github.com/user/repo@v1.0.0
     // - git@github.com:user/repo.git
     // - git@github.com:user/repo.git@v1.0.0
   }

   export async function resolveRemoteStrand(
     url: string,
     options: {
       forceUpdate?: boolean;
       skipPrompt?: boolean;
       offline?: boolean;
     }
   ): Promise<{ cachePath: string; wasUpdated: boolean }> {
     // 1. Parse URL and determine cache path
     // 2. Check if cached and still valid (based on TTL for branches)
     // 3. If offline mode, error if not cached
     // 4. Clone or fetch updates as needed
     // 5. Return cache path
   }
   ```

3. **Update CLI argument validation** (`server/index.ts` line 72-93)

   Add new valid patterns:
   ```typescript
   /^--update-cache$/,
   /^--offline$/,
   /^--yes$/,
   /^--list-cache$/,
   /^--clean-cache(=.*)?$/,
   ```

4. **Update help text** (`server/index.ts` around line 116)

   Add documentation for new flags and URL support.

### Phase 2: Version Support and Cache Management

1. **Implement version parsing** in `strand-downloader.ts`:
   - Extract `@ref` suffix from URLs
   - Determine reference type (branch/tag/commit) by querying Git
   - Handle ambiguous refs (e.g., `v1.0.0` could be tag or branch)

2. **Implement cache metadata**:
   - Write `cache-meta.json` to each cache directory
   - Track last fetch time, reference type, resolved commit SHA
   - Use metadata for TTL checking on branches

3. **Add cache management commands**:
   ```bash
   strandweave --list-cache          # Show all cached strands with sizes/dates
   strandweave --clean-cache         # Remove all cached strands
   strandweave --clean-cache github.com/user/repo  # Remove specific repo
   ```

### Phase 3: Security Prompting

1. **Create security summary display**:
   - Parse strand.json and extract key information
   - Detect dangerous commands in rigSetup using existing patterns from `config.ts` (lines 1448-1464)
   - Format and display the security summary

2. **Implement trust tracking**:
   - Store hash of strand.json content in cache metadata
   - Compare on subsequent runs to detect changes
   - Skip prompt if unchanged and previously approved

3. **Support `--yes` and `STRANDWEAVE_TRUST_REPOS`**:
   - Parse environment variable as comma-separated list of trusted repository patterns
   - Match patterns against URL before prompting

### Phase 4: Offline Mode and Error Handling

1. **Implement `--offline` flag**:
   - When set, never attempt network operations
   - Error immediately if strand not in cache
   - Useful for reproducible builds and disconnected environments

2. **Comprehensive error handling**:
   - Catch and categorize Git errors (network, auth, not found)
   - Provide actionable error messages with recovery steps
   - Log errors to execution directory for debugging

## Code Integration Points

### Primary Integration: `server/index.ts`

The main integration happens at line 249-253 where `absoluteConfigPath` is resolved. The URL detection and download logic runs before this point, and the rest of the execution flow remains unchanged.

```typescript
// Current flow (local paths only):
// 1. Parse --config argument -> configPath
// 2. Resolve to absolute path -> absoluteConfigPath
// 3. Pass to resolveSettings() and validateStrand()

// New flow (with URL support):
// 1. Parse --config argument -> configPath
// 2. If URL: download/cache -> cachePath, set absoluteConfigPath = cachePath/strand.json
// 3. If local: resolve to absolute path -> absoluteConfigPath
// 4. Pass to resolveSettings() and validateStrand() (unchanged)
```

### Secondary Integration: `server/config.ts`

The `loadStrandFile()` function (lines 694-713) and path resolution functions work unchanged because they receive a local filesystem path after the URL is resolved.

The key insight from Step 2 Agent: "When strand is loaded from URL, `configDir` becomes the local cache directory where the repo was cloned." All relative path resolution in strand configurations will work correctly because the entire repository context is cloned to cache.

### Existing Git Infrastructure: `server/checkpoint-git.ts`

The existing `CheckpointGit` class demonstrates the pattern for using `simple-git`:

```typescript
import simpleGit from "simple-git";

this.git = simpleGit(this.executionPath, {
  maxConcurrentProcesses: 1,
  config: [...],
}).env({...});

await this.git.init(false, { "--initial-branch": "main" });
```

The new `strand-downloader.ts` will follow the same pattern but use `git.clone()` instead of `git.init()`.

## New CLI Flags Summary

| Flag | Description |
|------|-------------|
| `--update-cache` | Force re-download of cached strand |
| `--offline` | Only use cached strands, never fetch from network |
| `--yes` | Skip security confirmation prompts |
| `--list-cache` | Display all cached strands |
| `--clean-cache[=<repo>]` | Remove cached strands (optionally for specific repo) |

## Testing Strategy

This feature introduces URL handling, Git operations, caching, and security prompts. Testing should focus on the brittle areas: URL parsing edge cases, cache invalidation logic, and security prompt flows.

### Unit Tests (tests/unit/strand-downloader.test.ts)

Focus on URL parsing correctness since this is the entry point and errors here cascade:

```typescript
describe("isStrandUrl", () => {
  test("detects HTTPS URLs", () => {
    expect(isStrandUrl("https://github.com/user/repo")).toBe(true);
    expect(isStrandUrl("http://github.com/user/repo")).toBe(true);
  });

  test("detects SSH URLs", () => {
    expect(isStrandUrl("git@github.com:user/repo.git")).toBe(true);
  });

  test("rejects local paths", () => {
    expect(isStrandUrl("./strand.json")).toBe(false);
    expect(isStrandUrl("/absolute/path/strand.json")).toBe(false);
  });
});

describe("parseStrandUrl", () => {
  test("parses HTTPS URL without ref", () => {
    const result = parseStrandUrl("https://github.com/user/repo");
    expect(result).toEqual({
      protocol: "https",
      host: "github.com",
      owner: "user",
      repo: "repo",
      ref: undefined,
    });
  });

  test("parses HTTPS URL with ref", () => {
    const result = parseStrandUrl("https://github.com/user/repo@v1.0.0");
    expect(result.ref).toBe("v1.0.0");
  });

  test("parses SSH URL with ref", () => {
    const result = parseStrandUrl("git@github.com:user/repo.git@main");
    expect(result.ref).toBe("main");
  });

  test("handles URLs with @ in path", () => {
    // Edge case: repo name contains @
    const result = parseStrandUrl("https://github.com/user/repo@name");
    // Should split on LAST @
    expect(result.repo).toBe("repo");
    expect(result.ref).toBe("name");
  });
});

describe("cache path generation", () => {
  test("generates consistent cache paths", () => {
    const path1 = getCachePath("https://github.com/user/repo", "main");
    const path2 = getCachePath("https://github.com/user/repo", "main");
    expect(path1).toBe(path2);
  });

  test("different refs generate different paths", () => {
    const mainPath = getCachePath("https://github.com/user/repo", "main");
    const devPath = getCachePath("https://github.com/user/repo", "develop");
    expect(mainPath).not.toBe(devPath);
  });
});
```

**Rationale:** URL parsing is complex with many edge cases. Getting this wrong means failed downloads or wrong repositories. Cache path generation determines whether we reuse or re-download.

### Integration Tests (tests/integration/remote-strand.test.ts)

Focus on cache behavior since this is the most stateful and brittle part:

```typescript
describe("Remote Strand Caching", () => {
  let tempCacheDir: string;

  beforeEach(() => {
    tempCacheDir = path.join("tests", "test-area", `cache-${Date.now()}`);
    // Override cache directory for testing
  });

  afterEach(() => {
    fs.rmSync(tempCacheDir, { recursive: true, force: true });
  });

  test("caches strand on first download", async () => {
    const mockGit = createMockGit();
    const result = await resolveRemoteStrand(
      "https://github.com/test/repo",
      { skipPrompt: true }
    );

    expect(result.wasUpdated).toBe(true);
    expect(fs.existsSync(result.cachePath)).toBe(true);
    expect(mockGit.clone).toHaveBeenCalledTimes(1);
  });

  test("uses cache on second call within TTL", async () => {
    const mockGit = createMockGit();

    // First call - should clone
    await resolveRemoteStrand("https://github.com/test/repo@main", { skipPrompt: true });

    // Second call within TTL - should use cache
    const result = await resolveRemoteStrand("https://github.com/test/repo@main", { skipPrompt: true });

    expect(result.wasUpdated).toBe(false);
    expect(mockGit.clone).toHaveBeenCalledTimes(1); // Only once
  });

  test("refetches branch after TTL expires", async () => {
    const mockGit = createMockGit();

    // First call
    await resolveRemoteStrand("https://github.com/test/repo@main", { skipPrompt: true });

    // Manually expire the cache metadata
    const metaPath = path.join(getCachePath("https://github.com/test/repo", "main"), "cache-meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    meta.lastFetched = new Date(Date.now() - 7200000).toISOString(); // 2 hours ago
    fs.writeFileSync(metaPath, JSON.stringify(meta));

    // Second call - should refetch
    const result = await resolveRemoteStrand("https://github.com/test/repo@main", { skipPrompt: true });
    expect(mockGit.fetch).toHaveBeenCalled();
  });

  test("never refetches commit SHAs", async () => {
    const mockGit = createMockGit();
    const commitSha = "abc123def456";

    await resolveRemoteStrand(`https://github.com/test/repo@${commitSha}`, { skipPrompt: true });
    await resolveRemoteStrand(`https://github.com/test/repo@${commitSha}`, { skipPrompt: true });

    expect(mockGit.clone).toHaveBeenCalledTimes(1); // Only once, never refetch
  });

  test("removes invalid strand from cache", async () => {
    const mockGit = createMockGit({
      cloneReturns: "invalid-strand.json" // Returns strand with validation errors
    });

    await expect(resolveRemoteStrand("https://github.com/test/repo", { skipPrompt: true }))
      .rejects.toThrow("Invalid strand configuration");

    // Cache should be cleaned up
    const cachePath = getCachePath("https://github.com/test/repo", undefined);
    expect(fs.existsSync(cachePath)).toBe(false);
  });
});
```

**Rationale:** Cache invalidation is notoriously difficult. These tests verify the TTL logic works correctly for different reference types and that invalid strands don't pollute the cache.

### Integration Tests: Security Prompts

```typescript
describe("Remote Strand Security", () => {
  test("prompts user on first download", async () => {
    const mockPrompt = jest.fn().mockResolvedValue("y");

    await resolveRemoteStrand("https://github.com/test/repo", {
      skipPrompt: false,
      promptFunction: mockPrompt,
    });

    expect(mockPrompt).toHaveBeenCalledWith(
      expect.stringContaining("This strand will execute commands")
    );
  });

  test("skips prompt with --yes flag", async () => {
    const mockPrompt = jest.fn();

    await resolveRemoteStrand("https://github.com/test/repo", {
      skipPrompt: true,
    });

    expect(mockPrompt).not.toHaveBeenCalled();
  });

  test("re-prompts when strand.json changes", async () => {
    const mockPrompt = jest.fn().mockResolvedValue("y");

    // First download
    await resolveRemoteStrand("https://github.com/test/repo@main", {
      skipPrompt: false,
      promptFunction: mockPrompt,
    });

    // Modify cached strand.json
    const cachePath = getCachePath("https://github.com/test/repo", "main");
    const strandPath = path.join(cachePath, "strand.json");
    const strand = JSON.parse(fs.readFileSync(strandPath, "utf-8"));
    strand.strand.push({ id: "new-codon", /* ... */ });
    fs.writeFileSync(strandPath, JSON.stringify(strand));

    // Second download - should re-prompt because content changed
    mockPrompt.mockClear();
    await resolveRemoteStrand("https://github.com/test/repo@main", {
      skipPrompt: false,
      promptFunction: mockPrompt,
      forceUpdate: true,
    });

    expect(mockPrompt).toHaveBeenCalled();
  });
});
```

**Rationale:** Security prompts are critical for user safety. These tests ensure prompts appear when they should and are skipped when appropriate.

### E2E Tests: Attach to Existing E2E Suite

Rather than creating expensive standalone E2E tests, add these checks to the existing happy-path-e2e.test.ts:

```typescript
// In tests/e2e/happy-path-e2e.test.ts, add new test group:

describe("Remote Strand Workflow", () => {
  test("runs strand from public GitHub URL", async () => {
    // Use a known public test repository
    const result = await startServer({
      config: "https://github.com/strandweave/test-strands@v1.0.0",
      data: TEST_DATA_DIR,
      args: ["--yes"], // Skip prompt
    });

    // Verify it downloaded and executed
    expect(result.success).toBe(true);
    expect(result.logs).toContain("Using remote strand");
  });

  test("offline mode uses cached strand", async () => {
    // First run to populate cache
    await startServer({
      config: "https://github.com/strandweave/test-strands@v1.0.0",
      data: TEST_DATA_DIR,
      args: ["--yes"],
    });

    // Second run in offline mode
    const result = await startServer({
      config: "https://github.com/strandweave/test-strands@v1.0.0",
      data: TEST_DATA_DIR,
      args: ["--offline"],
    });

    expect(result.success).toBe(true);
    expect(result.logs).not.toContain("Cloning repository");
  });
});
```

**Rationale:** E2E tests are expensive. By adding to the existing suite, we get real-world validation without the overhead of spinning up separate test servers. These tests verify the entire flow works end-to-end.

### Manual Testing Checklist

Because Git operations and network are involved, some manual testing is recommended:

1. **Network conditions:**
   - Test with slow network to verify timeout handling
   - Test with no network + offline mode
   - Test with intermittent connection

2. **Authentication:**
   - Public repository (no auth needed)
   - Private repository with SSH key
   - Private repository without proper credentials (should fail gracefully)

3. **Cache management:**
   - Run `strandweave --list-cache` to verify display
   - Run `strandweave --clean-cache` to verify cleanup
   - Manually inspect `~/.strandweave-cache/strands/` directory structure

**Rationale:** Git and network operations have many environmental dependencies that are difficult to mock perfectly. Manual testing catches these real-world issues.

## Risk Mitigation

### Risk 1: Private Repository Authentication
**Mitigation:** Rely entirely on Git's credential handling. Document SSH key setup in error messages and documentation.

### Risk 2: Large Repositories
**Mitigation:** Use `--depth 1` for shallow clones by default. Consider adding `--sparse` checkout support in future if needed for monorepos.

### Risk 3: Malicious Strands
**Mitigation:** Security prompt showing all rig setup commands before execution. Reuse existing dangerous command detection. Clear documentation about security implications.

### Risk 4: Unbounded Cache Growth
**Mitigation:** Cache management commands (`--list-cache`, `--clean-cache`). Consider adding automatic cleanup of unused cached strands older than configurable threshold in future.

## Dependencies

### Existing Dependencies (no changes needed)
- `simple-git` - Already used for checkpoint system

### No New Dependencies Required
The Git-only approach means we don't need to add HTTP client libraries.

## Open Questions for User

Before implementation, please confirm the following decisions:

### 1. Cache TTL for Branch References
**Current recommendation:** 1 hour default TTL for branch-based cache entries. After the TTL expires, Strandweave will check for updates before running.

**Question:** Is 1 hour appropriate for branch caching? Should this be user-configurable via an environment variable like `STRANDWEAVE_CACHE_TTL`?

### 2. Security Prompt Model
**Current recommendation:**
- First run: Always prompt with strand summary (unless `--yes`)
- Cached run (unchanged): Skip prompt if strand.json matches cached version
- Updated run: Prompt again if strand.json differs

**Question:** Is this security model sufficient? Should there also be a whitelist file (e.g., `~/.strandweave/trusted-repos.json`) in addition to the `STRANDWEAVE_TRUST_REPOS` environment variable?

### 3. Trust Environment Variable Format
**Current recommendation:** `STRANDWEAVE_TRUST_REPOS` as a comma-separated list of repository patterns.

**Question:** Should this support glob patterns (e.g., `github.com/my-org/*`) or only exact matches?

---

## Backwards Compatibility

This feature is purely additive. Existing local path usage remains unchanged:

```bash
# These continue to work exactly as before
strandweave --config=./strand.json --data=/path/to/project
strandweave --config=/absolute/path/strand.json --data=/path/to/project
```

The URL detection only triggers when the config path matches URL patterns (starts with `https://`, `http://`, or `git@`).
