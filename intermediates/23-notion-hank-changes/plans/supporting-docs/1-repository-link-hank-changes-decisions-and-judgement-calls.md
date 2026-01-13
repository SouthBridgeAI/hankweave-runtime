# ENG-105: Repository Link Hanks - Changes, Decisions, and Judgement Calls

## Step 2 Agent Analysis

### Core Implementation Approach

After examining the codebase, I recommend implementing remote hank loading as a **download-then-execute** pattern rather than a streaming pattern. This aligns perfectly with Hankweave's existing execution isolation model.

**Key Insight**: Hankweave already has sophisticated execution isolation (`.hankweave-executions/` directories, shadow Git, metadata tracking). Adding remote hanks is essentially inserting a "download to cache" step before the existing config loading flow.

### Decision 1: Use Git Clone for All Remote Operations

**Recommendation**: Use `simple-git` (already a dependency) exclusively for downloading remote hanks with `--depth 1` for shallow clones. Do NOT add HTTP client libraries.

**Industry context from research:**
Package managers have evolved away from Git-as-database due to performance issues. [Cargo migrated from Git index to sparse HTTP protocol](https://nesbitt.io/2025/12/24/package-managers-keep-using-git-as-a-database.html), achieving 99% adoption by April 2025. [Go modules saw 90x performance improvement](https://byteiota.com/git-as-database-fails-package-managers-the-pattern-is-clear/) moving from Git-based resolution (18 minutes) to module proxy (12 seconds). However, our use case differs - we're cloning once for execution, not maintaining an index of thousands of packages.

**Rationale**:
1. **Already in use**: The checkpoint system (`checkpoint-git.ts`) already uses `simple-git` extensively. Team is familiar with it.
2. **Auth handled by Git**: Private repositories work via SSH keys or credential helpers that Git already knows about. No need to reinvent authentication.
3. **Supports version pinning**: Git naturally handles commits, branches, tags - exactly what we need for `@v1.0.0` syntax.
4. **Partial clones**: Can use `--depth 1` for faster downloads of large repos.
5. **Consistent mental model**: Users already understand Git URLs and authentication.

**Alternative considered**: Adding `node-fetch` to support raw GitHub URLs like `https://raw.githubusercontent.com/...`
- **Rejected because**: Adds complexity, requires custom auth handling, doesn't naturally support versioning.

### Decision 2: Cache Structure

**Recommended cache location**: `~/.hankweave-cache/hanks/`

**Directory structure**:
```
~/.hankweave-cache/hanks/
  └── github.com/
      └── user/
          └── repo/
              ├── main/                    # Branch-based cache
              │   ├── .git/
              │   ├── hank.json
              │   └── prompts/
              ├── abc123def/               # Commit SHA-based cache
              │   ├── .git/
              │   └── ...
              └── v1.0.0/                  # Tag-based cache
                  └── ...
```

**Rationale**:
- Mirrors the URL structure (intuitive for debugging)
- Separate directories for different versions
- Can be cleaned up independently from execution directories
- Allows checking cache before downloading

**Alternative considered**: Flat structure with hashed names
- **Rejected because**: Harder to debug, can't easily inspect cached hanks

### Decision 3: URL Format Support

**Supported formats** (in order of implementation priority):

1. **GitHub HTTPS URLs** (highest priority):
   - `https://github.com/user/repo`
   - `https://github.com/user/repo/tree/branch`
   - `https://github.com/user/repo@commit-sha`
   - `https://github.com/user/repo@v1.0.0`

2. **Git SSH URLs**:
   - `git@github.com:user/repo.git`
   - `git@github.com:user/repo.git@v1.0.0`

3. **Generic Git URLs**:
   - `https://gitlab.com/user/repo`
   - `https://bitbucket.org/user/repo`

4. **Raw file URLs** (future consideration):
   - `https://raw.githubusercontent.com/user/repo/main/hank.json`
   - Currently NOT implementing - adds complexity for minimal benefit

**URL parsing strategy**:
```typescript
function parseHankUrl(url: string): {
  protocol: 'https' | 'ssh' | 'local';
  host: string;  // e.g., 'github.com'
  owner: string; // e.g., 'user'
  repo: string;  // e.g., 'repo'
  ref?: string;  // commit, branch, or tag (after @)
  isUrl: boolean;
} {
  // If no protocol and no @, it's a local path
  if (!url.includes('://') && !url.startsWith('git@')) {
    return { ...parseLocalPath(url), isUrl: false };
  }

  // Parse URL...
}
```

### Decision 4: Version Reference Syntax

**Recommended syntax**: Append `@ref` to URL to specify version.

**Examples**:
```bash
# Latest on default branch
hankweave --config=https://github.com/user/repo

# Specific branch
hankweave --config=https://github.com/user/repo@develop

# Specific commit
hankweave --config=https://github.com/user/repo@abc123def456

# Specific tag
hankweave --config=https://github.com/user/repo@v1.0.0
```

**Rationale**:
- Follows npm/cargo convention (`package@version`)
- Natural separation character
- Easy to parse (split on last `@`)
- Distinguishes from URL fragments or query params

**Alternative considered**: Query parameters like `?ref=v1.0.0`
- **Rejected because**: Less ergonomic, doesn't match package manager conventions

### Decision 5: Caching Strategy

**Cache behavior**:

1. **Commit SHAs**: Cache forever (immutable)
   ```bash
   # First run: downloads
   hankweave --config=https://github.com/user/repo@abc123
   # Second run: uses cache immediately
   hankweave --config=https://github.com/user/repo@abc123
   ```

2. **Tags**: Cache until explicit update (assume immutable, but allow refresh)
   ```bash
   # Uses cache if present
   hankweave --config=https://github.com/user/repo@v1.0.0
   # Force update: --update-cache flag
   hankweave --update-cache --config=https://github.com/user/repo@v1.0.0
   ```

3. **Branches**: Check for updates after TTL (e.g., 1 hour)
   ```bash
   # Checks if local cache is stale (> 1 hour old)
   hankweave --config=https://github.com/user/repo@main
   # If stale, fetches updates
   ```

4. **No version specified**: Always fetch latest on default branch
   ```bash
   # Always checks for updates
   hankweave --config=https://github.com/user/repo
   ```

**TTL configuration**: Store in cache metadata file
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

**Implementation note**: This requires metadata file in cache directory to track fetch times.

### Decision 6: Security and Trust

**Research findings on Git security threats:**
Recent research reveals critical vulnerabilities in Git clone operations. [CVE-2025-48384](https://www.cisecurity.org/advisory/a-vulnerability-in-git-could-allow-for-remote-code-execution_2025-078) demonstrates that malicious .gitmodules files can enable arbitrary filesystem writes and remote code execution. Additionally, [repositories with symbolic links and Git LFS filters can execute scripts during clone](https://github.com/git/git/security/advisories/GHSA-8prw-h3cq-mghm). These threats validate the need for aggressive security prompts before executing any downloaded hank.

**Pre-execution validation** (CRITICAL for safety):

When a remote hank is downloaded for the first time, display a security summary:

```
⚠️  About to execute hank from: https://github.com/user/repo@main

Hank configuration summary:
  - Name: "Code Analyzer"
  - Codons: 3
  - Models: sonnet
  - Rig setup operations: 2
    1. Copy: ../templates/config.json → config/analyzer.json
    2. Command: npm install
  - Tracked files: ["analysis.md", "results/**"]
  - Output files: ["analysis.md"]

⚠️  This hank will execute commands on your system.
Review the hank configuration at: ~/.hankweave-cache/hanks/github.com/user/repo/main/hank.json

Do you want to continue? [y/N]
```

**Trust levels**:
1. **First run**: Always prompt (unless `--yes` flag)
2. **Cached run**: Skip prompt if hank.json unchanged
3. **Updated run**: Prompt if hank.json diff detected

**Dangerous operation detection**: Reuse existing logic from `config.ts` (lines 1448-1464) that checks for dangerous shell commands.

### Decision 7: Integration with Existing CLI

**Backwards compatibility**: Must maintain existing behavior for local paths.

**URL detection logic** (in `server/index.ts`):
```typescript
const configPath = args.find(arg => arg.startsWith('--config='))?.split('=')[1] || 'hank.json';

// NEW: Detect if configPath is a URL
if (isUrl(configPath)) {
  // Download to cache
  const cachedPath = await downloadHank(configPath, {
    forceUpdate: args.includes('--update-cache'),
    skipPrompt: args.includes('--yes')
  });
  // Use cached path for rest of execution
  absoluteConfigPath = cachedPath;
} else {
  // Existing behavior
  absoluteConfigPath = path.resolve(process.cwd(), configPath);
}
```

**This preserves all existing functionality** while cleanly adding URL support.

### Decision 8: Error Handling

**Network errors** (connection timeout, DNS failure):
```
❌ Failed to download hank: Network error
   URL: https://github.com/user/repo
   Error: getaddrinfo ENOTFOUND github.com

   Check your internet connection and try again.

   To use a cached version (if available):
   hankweave --offline --config=https://github.com/user/repo
```

**Authentication errors** (private repo, no access):
```
❌ Failed to download hank: Authentication required
   URL: git@github.com:user/private-repo.git

   This repository appears to be private.
   Make sure you have:
   1. SSH key configured: ~/.ssh/id_rsa
   2. Access to the repository

   To configure SSH key for Git:
   ssh-keygen -t rsa -b 4096 -C "your_email@example.com"
   ssh-add ~/.ssh/id_rsa
```

**Invalid hank** (download succeeds but hank.json is invalid):
```
❌ Invalid hank configuration
   URL: https://github.com/user/repo
   Downloaded to: ~/.hankweave-cache/hanks/github.com/user/repo/main

   Validation errors:
   - Codon "analyze" (codon-1): promptFile "prompts/analyze.md" does not exist

   The cached download will be removed to avoid using invalid configuration.
```

### Decision 9: Offline Mode

**New CLI flag**: `--offline`

**Behavior**:
- Only use cached hanks, never fetch from network
- Error if hank not in cache
- Useful for disconnected environments or reproducible builds

```bash
# Works if hank was cached previously
hankweave --offline --config=https://github.com/user/repo@v1.0.0

# Errors if not cached:
❌ Hank not available offline
   URL: https://github.com/user/repo@v1.0.0
   Cache location: ~/.hankweave-cache/hanks/github.com/user/repo/v1.0.0

   Download first while connected:
   hankweave --config=https://github.com/user/repo@v1.0.0
```

### Decision 10: Cache Management Commands

**New commands to add**:

1. **List cache**:
   ```bash
   hankweave --list-cache

   Output:
   Cached hanks in ~/.hankweave-cache/hanks/:

   github.com/user/repo
     main (branch, last updated: 2 hours ago, 124 KB)
     v1.0.0 (tag, downloaded: 3 days ago, 124 KB)
     abc123def (commit, downloaded: 1 week ago, 124 KB)

   gitlab.com/org/project
     develop (branch, last updated: 1 day ago, 89 KB)

   Total: 4 cached versions, 461 KB
   ```

2. **Clean cache**:
   ```bash
   # Remove all cache
   hankweave --clean-cache

   # Remove specific repo
   hankweave --clean-cache github.com/user/repo

   # Remove old versions (keep recent)
   hankweave --clean-cache --keep-recent
   ```

3. **Update cache**:
   ```bash
   # Update specific hank
   hankweave --update-cache --config=https://github.com/user/repo@main

   # Update all branch-based cache entries
   hankweave --update-cache --all
   ```

### Step 2 Agent Judgement Calls

#### Judgement Call 1: Git-Only vs Mixed Approach

**Decision**: Git-only approach.

**Reasoning**: While supporting raw file URLs (like `https://raw.githubusercontent.com/...`) might seem convenient, it introduces significant complexity:
- Need HTTP client library (new dependency)
- Need to handle authentication separately for raw files
- Need to download referenced files (prompts) separately
- No natural versioning support

Git clone handles all of this elegantly. The slight overhead of cloning a repo instead of fetching one file is negligible for the added benefits.

#### Judgement Call 2: Cache Location

**Decision**: Separate cache directory, not inside execution directories.

**Reasoning**: Execution directories are ephemeral and scoped to specific data sources. Hank cache is orthogonal to execution - the same hank can be used with different data. Mixing them would complicate cleanup and confuse the mental model.

#### Judgement Call 3: Security Prompting

**Decision**: Err on the side of safety with initial execution prompts.

**Reasoning**: Executing arbitrary code from the internet is inherently risky. Unlike Docker (which runs in containers) or npm (which has a reputation system), Hankweave runs with full filesystem access in the execution directory. The first-run prompt is essential.

However, we should make it easy to skip prompts in trusted scenarios:
- `--yes` flag for CI/CD
- Trust cache based on unchanged hank.json
- Environment variable `HANKWEAVE_TRUST_REPOS` for whitelisting

#### Judgement Call 4: Version Resolution Precedence

**Decision**: Explicit version in URL takes precedence over everything.

**Order of precedence**:
1. Version specified in URL (`@v1.0.0`)
2. Cached version (if present and valid)
3. Default branch (for URLs without version)

This provides predictable behavior and prevents surprising version changes.

#### Judgement Call 5: Failure Mode for Invalid Hanks

**Decision**: Remove invalid hank from cache immediately.

**Reasoning**: If a downloaded hank fails validation, keeping it in cache could lead to confusing behavior on retry. Better to force a re-download or fix the issue upstream.

However, we should log the cache location before removing it so users can inspect it for debugging:
```
❌ Invalid hank removed from cache.
   Previous location: ~/.hankweave-cache/hanks/github.com/user/repo/main
   You can re-download after fixing the configuration.
```

### Implementation Complexity Assessment

**Estimated complexity**: Medium

**Why medium and not high**:
- The execution isolation architecture is already perfect for this
- `simple-git` is already a dependency
- URL parsing is straightforward
- Most of the code is glue logic, not complex algorithms

**Complexity breakdown**:
1. URL detection and parsing: Low (50-100 lines)
2. Download logic with simple-git: Low-Medium (150-200 lines)
3. Cache management: Low (100-150 lines)
4. Security prompting: Medium (200-250 lines, need to format output nicely)
5. Error handling: Low-Medium (100-150 lines)
6. Integration with existing CLI: Low (50-100 lines)
7. Tests: Medium (need to mock git operations, test various URL formats)

**Total estimate**: ~800-1000 lines of new code + tests

### Risks and Mitigation

**Risk 1**: Private repository authentication
- **Mitigation**: Rely entirely on Git's credential handling. Document how to set up SSH keys.

**Risk 2**: Large repositories causing slow downloads
- **Mitigation**: Use `--depth 1` for shallow clones. Consider sparse checkout for large repos.

**Risk 3**: Malicious hanks
- **Mitigation**: Security prompt, dangerous command detection, clear documentation about risks.

**Risk 4**: Cache growing unbounded
- **Mitigation**: Cache management commands, TTL-based cleanup, size warnings.

### Open Questions for Step 3 Agent

1. **Should we support sparse checkout for large repos?** Git supports checking out only specific files/directories. Could be useful for mono-repos with multiple hanks.

2. **Should cached hanks be read-only?** Currently planning to download to cache as normal Git repos. Should we prevent modification?

3. **Authentication for HTTPS URLs**: Git credential helpers work for HTTPS, but the UX is less smooth than SSH. Should we document a preferred auth method?

4. **Monorepo support**: If a repo contains multiple hank.json files in different directories, should we support `https://github.com/user/repo/path/to/hank`?

5. **Dependency resolution**: If a hank references other hanks (hypothetically), should we support transitive loading? Probably not for v1, but worth considering the architecture.

### Step 2 Agent Recommendations for Implementation Order

1. **Phase 1**: URL detection, basic Git clone, local caching (no version support yet)
2. **Phase 2**: Version support (`@commit`, `@tag`, `@branch`)
3. **Phase 3**: Security prompting and trust system
4. **Phase 4**: Cache management commands
5. **Phase 5**: TTL and update logic
6. **Phase 6**: Offline mode

This phased approach allows delivering value early while building up to the full feature set.
