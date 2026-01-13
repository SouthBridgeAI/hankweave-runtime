# ENG-87: Frontmatter on Prompts - Changes and Decisions

## Step 2 Agent Analysis

This is a great feature for prompt reusability and self-documentation. Zero breaking changes - purely additive.

## Decision 1: Use Standard Frontmatter Format

**Format**: YAML frontmatter (industry standard)

**Research validation:**
[Gray-matter is the most widely-used frontmatter parser](https://github.com/jonschlinkert/gray-matter), used by Gatsby, Netlify, Astro, VitePress, TinaCMS, Shopify Polaris, Ant Design, and many other major projects. According to [frontmatter best practices from VitePress](https://vitepress.dev/guide/frontmatter), frontmatter must be at the top of files and use valid YAML between triple-dashed lines. Gray-matter's key advantage is [handling complex content including non-frontmatter code blocks](https://www.npmjs.com/package/gray-matter) that contain YAML examples, which breaks other parsers.
```markdown
---
field: value
---

Content here
```

**Library**: `gray-matter` (most popular, battle-tested)

**Why not custom format**: Don't reinvent the wheel. Frontmatter is well-understood by developers.

## Decision 2: Allowed Frontmatter Fields

**Core fields** (affect execution):
- `model`: Override codon model
- `continuationMode`: Override continuation mode

**Metadata fields** (documentation only):
- `name`: Prompt name
- `description`: What this prompt does
- `tags`: Array of tags for organization
- `version`: Prompt version
- `author`: Who wrote it

**Use strict schema** to catch typos:
```typescript
// Typo: "modle" instead of "model"
---
modle: opus
---
// Error: Unknown frontmatter field "modle"
```

## Decision 3: Precedence (Most Important Decision)

**Order of precedence** (highest to lowest):
1. CLI flags (`--model opus`)
2. Prompt frontmatter (`model: opus`)
3. Codon config (`"model": "sonnet"`)
4. Strand recommendations
5. Defaults

**Rationale**: More specific overrides less specific.

**Example**:
```bash
# All three specify model:
strandweave --model=opus  # CLI: opus
# Codon has model: "sonnet"
# Prompt has model: "haiku"

# Result: Uses CLI value (opus)
```

**Implementation**:
```typescript
let effectiveModel = DEFAULT_MODEL;

// Layer 4: Strand recommendations
if (strandRecommendations.model) {
  effectiveModel = strandRecommendations.model;
}

// Layer 3: Codon config
if (codon.model) {
  effectiveModel = codon.model;
}

// Layer 2: Prompt frontmatter
if (promptMetadata?.model) {
  effectiveModel = promptMetadata.model;
}

// Layer 1: CLI override
if (cliArgs.model) {
  effectiveModel = cliArgs.model;
}
```

## Decision 4: Multiple Prompts with Frontmatter

**Question**: If `promptFile: ["part1.md", "part2.md"]`, which frontmatter wins?

**Decision**: First file's frontmatter takes precedence.

**Reasoning**: Matches document concatenation mental model - first file is "primary".

**Alternative considered**: Merge frontmatter from all files
- **Rejected**: Too complex, confusing precedence

## Decision 5: Validation Timing

**Validate frontmatter on prompt load**, not during config validation.

**Why**: Prompts might be externally managed, changed frequently, or conditionally loaded.

**Error handling**:
```typescript
try {
  const metadata = promptFrontmatterSchema.parse(data);
} catch (error) {
  throw new Error(
    `Invalid frontmatter in ${filePath}:\n${error.message}\n\n` +
    `Allowed fields: model, continuationMode, name, description, tags, version, author`
  );
}
```

## Decision 6: Metadata Storage

**Store prompt metadata in execution metadata** for debugging:

```json
{
  "codonId": "analyze",
  "promptFiles": ["prompts/analyze.md"],
  "promptMetadata": {
    "name": "Code Analyzer",
    "model": "opus",
    "version": "1.2.0"
  }
}
```

**Benefits**:
- Can see which prompt version was used
- Helps with debugging
- Audit trail

## Complexity Assessment

**Implementation**: Low-Medium
- Add gray-matter dependency: Done with `bun add`
- Frontmatter parsing: ~50 lines
- Schema definition: ~30 lines
- Integration with CodonRunner: ~60 lines
- Precedence logic: ~40 lines
- Tests: ~60 lines

**Total**: ~240 lines, 1 day of work

## Step 2 Agent Recommendation

Implement this - it's a high-value feature for prompt reusability and organization.

**Critical**: Get precedence rules right from the start. Once users start using frontmatter, changing precedence is a breaking change.

**Implementation order**:
1. Add gray-matter parsing
2. Define schema (strict validation)
3. Implement precedence (CLI > frontmatter > codon > defaults)
4. Add to execution metadata
5. Tests for edge cases (multiple files, invalid frontmatter, etc.)
6. Documentation with examples

## Open Question for Step 3

**Should frontmatter support env var substitution?**

```markdown
---
model: ${STRANDWEAVE_MODEL}
---
```

**Step 2 Agent opinion**: Not for v1. Adds complexity. Can be added later if needed.
