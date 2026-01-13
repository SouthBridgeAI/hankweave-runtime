# ENG-105: Being able to run a repository link as a strand

## From Step 1 Agent

This task introduces a significant new capability to Strandweave: the ability to run strands directly from repository URLs or permalinks without requiring users to manually clone or download them first. The core question is whether we want to support both public repository URLs and authenticated private repositories, and how we handle versioning (specific commits vs branches). This feature would dramatically reduce friction for sharing and executing strands, making them more like "executable recipes" that can be easily distributed. The implementation will need to decide on caching strategy, security considerations for downloaded strands, and whether to support multiple version control systems or just Git initially.

---

## Linear Task Information

**Identifier:** ENG-105
**Title:** Being able to run a repository link as a strand
**Status:** In Progress
**Priority:** Medium
**Created:** 2026-01-12 by Hrishi Olickel
**Assignee:** Hrishi Olickel

### Original Description

Hrishi wrote: "It would be awesome if we could provide strandweave with a strand link that is a specific permalink to a strand (or a repo url where the toplevel of the repo has a strand.json). If it's public (or accessible), we should be able to download it somewhere, get the strand, preflight it and run it, no? We can also prevent redownloading, support loading from different commits, etc etc."

### Comments

No comments on this issue yet.

### Related Issues

No related issues linked.

---

## Step 1 Agent Analysis

### Understanding the Core Request

The fundamental idea here is to make Strandweave strands more portable and shareable by allowing users to reference them via URLs instead of requiring local file paths. This is analogous to how package managers like npm or pip allow you to install packages from remote sources, or how tools like Docker allow you to pull images from registries.

The specific use case Hrishi mentions is providing either:
1. A permalink to a specific strand file
2. A repository URL where the top level contains a `strand.json`

The key insight is that strands are currently treated as local artifacts, but they're really configurations that could be version-controlled, shared, and executed from remote sources.

### What "Accessible" Means

When Hrishi says "If it's public (or accessible)," this raises an important architectural question about authentication. The Step 1 Agent interprets this to mean we should support at minimum:

- **Public repositories** that don't require authentication
- Potentially **private repositories** that the user has access to (via SSH keys, tokens, etc.)

The parenthetical "(or accessible)" suggests that private repositories should be supported if the user has the necessary credentials configured on their system.

### The Caching Strategy

Hrishi explicitly mentions "We can also prevent redownloading, support loading from different commits, etc etc." This is a critical feature request that goes beyond just downloading once. The Step 1 Agent understands this to mean:

- The system should maintain a local cache of downloaded strands
- The cache should be keyed by repository URL and commit hash (or branch/tag)
- Users should be able to specify different versions (commits) of the same strand
- The system should avoid redundant downloads if the strand is already cached

This is similar to how Git submodules work or how Cargo/npm handle dependencies.

### Preflight and Security

The mention of "preflight it and run it" is important. Since we're downloading potentially untrusted code (strand configurations), we need to:

1. Validate the strand configuration before execution
2. Potentially show the user what the strand will do (especially any `rigSetup` commands)
3. Get user confirmation before executing downloaded strands

This is a security consideration - we don't want users blindly executing malicious strands.

### Implementation Questions and Initial Thinking

**Question 1: What URL formats should we support?**

The Step 1 Agent thinks we should support:
- Full GitHub URLs: `https://github.com/user/repo` or `https://github.com/user/repo/tree/branch/path`
- Git URLs: `git@github.com:user/repo.git`
- Potentially other Git hosting services (GitLab, Bitbucket)
- Raw file URLs for single strand files

**Question 2: Where should cached strands be stored?**

Based on how Strandweave currently uses `~/.strandweave-executions/` for execution directories, a natural location would be something like `~/.strandweave-cache/strands/`. The cache could be organized by repository host and path.

**Question 3: How should version selection work?**

Users should be able to specify:
- Latest version on default branch: `strandweave https://github.com/user/repo`
- Specific commit: `strandweave https://github.com/user/repo@abc123def`
- Specific tag: `strandweave https://github.com/user/repo@v1.0.0`
- Specific branch: `strandweave https://github.com/user/repo@develop`

This follows the convention used by many package managers.

**Question 4: What about strands with dependencies on other files?**

If a strand references prompt files like `prompts/analyze.md`, we need to download the entire repository context, not just the `strand.json` file. This means the download operation probably needs to be a full `git clone` (or at minimum, a sparse checkout of the relevant files).

**Question 5: How do we handle updates?**

Should there be a command to update cached strands? Something like `strandweave --update-cache` that checks for new commits on branches? Or should we always check for updates when a branch name is used (rather than a specific commit)?

### Integration with Existing CLI

Currently, Strandweave is invoked with `--config=./strand.json --data=/path/to/project`. With this feature, we might have:

```bash
# Traditional local usage
strandweave --config=./strand.json --data=/path/to/project

# New remote usage
strandweave --config=https://github.com/user/repo --data=/path/to/project

# Or with version pinning
strandweave --config=https://github.com/user/repo@v1.0.0 --data=/path/to/project
```

This maintains backwards compatibility while adding the new capability.

### Related to Other Tasks

This task doesn't explicitly relate to the other tasks in the batch (ENG-106, ENG-93, etc.), but it does touch on the general theme of making Strandweave easier to use. If ENG-106 goes forward with simplifying the CLI to `strandweave <strand> <data>`, then the URL support would just work naturally: `strandweave https://github.com/user/repo ./my-project`.

### Implementation Scope

The Step 1 Agent believes this task should include:

1. **URL parsing and validation** - Determine if a config parameter is a URL vs local path
2. **Git operations** - Clone/fetch repository contents
3. **Caching system** - Store downloaded strands and avoid redundant downloads
4. **Version resolution** - Support commit hashes, branches, tags
5. **Security checks** - Validate strand before execution, potentially warn about dangerous operations
6. **Cache management** - Commands to clear cache, update cached strands
7. **Error handling** - What happens if the URL is invalid, network is down, authentication fails, etc.

### Testing Considerations

We'll need tests for:
- Downloading from public GitHub repositories
- Handling authentication for private repositories
- Cache hit/miss scenarios
- Version pinning with commits and tags
- Error cases (404, network failures, invalid strand.json)
- Security validation of downloaded strands

### Open Questions for Step 2

The Step 2 agent (which will connect this to the codebase) should consider:

- Does Strandweave already have any Git operations? Look for existing Git-related code
- How does the current config loading work in `server/config.ts`? Where would URL detection fit?
- Is there an existing validation system that could be extended for security checks?
- What error handling patterns does Strandweave use? How should network errors be surfaced?
