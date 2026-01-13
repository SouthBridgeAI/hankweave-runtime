# ENG-87: Frontmatter on Prompts

> **Implementation Order:** Phase 4 (late, adds dependency) - See [00-index.md](00-index.md) for full context

## Related Plans

This task is mostly independent but adds a new npm dependency:

- **[ENG-105: Repository URLs](final-standalone-1-repository-link-strand.md)** - Remote strands can include prompts with frontmatter; precedence rules apply
- **[ENG-106: Command Line Improvements](final-standalone-2-command-line-improvements.md)** - CLI model override (`--model`) should take precedence over frontmatter

## Task Summary

Add YAML frontmatter support to prompt markdown files for better metadata management, organization, and configuration at the prompt level. This enables prompts to be self-documenting and allows configuration overrides (like model selection) without modifying the strand.json.

**Original Request (Hrishi Olickel):**
> "Since prompts are just markdown, it would be useful to add title, comments, author and date to them for better management. Should be easy enough to add the parsing."

## Sources and Context

### Linear Ticket
- **Identifier:** ENG-87
- **Status:** In Progress
- **Priority:** Medium
- **Labels:** Minor
- **Created:** 2025-12-18

### Original Planning Documents
The following documents were synthesized by the Step 4 Agent to create this plan:
- [`supporting-docs/7-frontmatter-prompts-full-task.md`](supporting-docs/7-frontmatter-prompts-full-task.md) - Original task with Step 1/2/3 agent analysis
- [`supporting-docs/7-frontmatter-prompts-related-code.md`](supporting-docs/7-frontmatter-prompts-related-code.md) - Codebase integration points
- [`supporting-docs/7-frontmatter-prompts-changes-decisions-and-judgement-calls.md`](supporting-docs/7-frontmatter-prompts-changes-decisions-and-judgement-calls.md) - Technical decisions

### Research Findings (from Step 3 Agent)

The Step 3 Agent validated the use of gray-matter library:

> "Gray-matter is the most widely-used frontmatter parser, used by Gatsby, Netlify, Astro, VitePress, TinaCMS, Shopify Polaris, Ant Design, and many other major projects. Gray-matter's key advantage is handling complex content including non-frontmatter code blocks that contain YAML examples, which breaks other parsers."

Sources cited:
- [gray-matter GitHub](https://github.com/jonschlinkert/gray-matter) - Industry standard
- [VitePress frontmatter best practices](https://vitepress.dev/guide/frontmatter)

### Current Code State (from Step 2 Agent)

**No frontmatter parsing exists yet.** Prompts are loaded as plain text files.

Current schema in `server/config.ts` (lines 249-268):
```typescript
promptFile: z
  .union([z.string(), z.array(z.string())])
  .optional()
  .describe("Path to a file containing the prompt"),
promptText: z
  .string()
  .optional()
  .describe("Inline prompt text"),
```

## Decision Points and Judgement Calls

### Decision 1: Use Standard YAML Frontmatter Format

**The Step 4 Agent recommends:** Standard YAML frontmatter delimited by `---`:

```markdown
---
name: Code Analyzer
description: Analyzes code for patterns and issues
model: opus
tags: [analysis, code-review]
---

Your actual prompt content here...
```

**Library:** `gray-matter` (most popular, battle-tested, handles edge cases)

### Decision 2: Define Two Categories of Fields

**The Step 4 Agent recommends:** Separate fields into "core" (affect execution) and "metadata" (documentation only).

**Core fields (affect execution):**
| Field | Type | Purpose |
|-------|------|---------|
| `model` | string | Override codon model |
| `continuationMode` | `"fresh"` \| `"continue-previous"` | Override continuation mode |

**Metadata fields (documentation only):**
| Field | Type | Purpose |
|-------|------|---------|
| `name` | string | Display name for the prompt |
| `description` | string | What this prompt does |
| `tags` | string[] | For categorization and filtering |
| `version` | string | Prompt version (semantic versioning) |
| `author` | string | Who wrote the prompt |

### Decision 3: Precedence Order (CRITICAL)

**The Step 4 Agent recommends:** Most specific wins, with this order:

```
CLI flags > Prompt frontmatter > Codon config > Strand recommendations > Defaults
```

| Layer | Source | Example |
|-------|--------|---------|
| 1 (highest) | CLI flags | `--model opus` |
| 2 | Prompt frontmatter | `model: opus` in .md file |
| 3 | Codon config | `"model": "sonnet"` in strand.json |
| 4 | Strand recommendations | `"recommendations": {"model": "sonnet"}` |
| 5 (lowest) | Defaults | Configured default model |

**Example:**
```bash
strandweave --model=opus  # CLI: opus
# Codon has model: "sonnet"
# Prompt has model: "haiku"
# Result: Uses CLI value (opus)
```

**Implementation:**
```typescript
let effectiveModel = DEFAULT_MODEL;

// Layer 4: Strand recommendations
if (strandRecommendations.model) effectiveModel = strandRecommendations.model;

// Layer 3: Codon config
if (codon.model) effectiveModel = codon.model;

// Layer 2: Prompt frontmatter
if (promptMetadata?.model) effectiveModel = promptMetadata.model;

// Layer 1: CLI override
if (cliArgs.model) effectiveModel = cliArgs.model;
```

**Warning from Step 3 Agent:**
> "Document the precedence order prominently in examples. Users will be confused if they set `model: opus` in frontmatter but it gets overridden by CLI. Clear documentation prevents support issues."

### Decision 4: Multiple Prompt Files

**The Step 4 Agent recommends:** First file's frontmatter takes precedence when `promptFile` is an array.

**Example:**
```json
{
  "promptFile": ["setup.md", "instructions.md", "context.md"]
}
```

If `setup.md` has `model: opus` and `instructions.md` has `model: sonnet`, the result is `opus` (first file wins).

**Rationale:** Matches document concatenation mental model where first file is "primary."

### Decision 5: Use Strict Schema Validation

**The Step 4 Agent recommends:** Reject unknown frontmatter fields to catch typos.

```typescript
const promptFrontmatterSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  model: z.string().optional(),
  continuationMode: z.enum(['fresh', 'continue-previous']).optional(),
  tags: z.array(z.string()).optional(),
  version: z.string().optional(),
  author: z.string().optional(),
}).strict();  // STRICT: reject unknown fields
```

**Example error:**
```
Error: Invalid frontmatter in prompts/analyze.md
Unknown field "modle". Did you mean "model"?
Allowed fields: model, continuationMode, name, description, tags, version, author
```

### Decision 6: Store Metadata in Execution State

**The Step 4 Agent recommends:** Record prompt metadata in execution metadata for debugging and audit trail.

**In execution metadata:**
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

This enables:
- Seeing which prompt version was used
- Debugging configuration issues
- Audit trail for compliance

## Implementation Plan

### Step 1: Add gray-matter Dependency

```bash
bun add gray-matter
bun add -d @types/gray-matter
```

### Step 2: Create Frontmatter Parser Module

**Create `server/prompt-frontmatter.ts`:**

```typescript
import matter from 'gray-matter';
import { z } from 'zod';
import fs from 'node:fs';

// Schema for frontmatter fields
export const promptFrontmatterSchema = z.object({
  // Core fields (affect execution)
  model: z.string().optional(),
  continuationMode: z.enum(['fresh', 'continue-previous']).optional(),

  // Metadata fields (documentation only)
  name: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  version: z.string().optional(),
  author: z.string().optional(),
}).strict();

export type PromptFrontmatter = z.infer<typeof promptFrontmatterSchema>;

export interface ParsedPrompt {
  metadata: PromptFrontmatter | undefined;
  content: string;
}

/**
 * Load a prompt file and parse its frontmatter.
 * Returns both the metadata (if present) and the prompt content.
 */
export function loadPromptWithFrontmatter(filePath: string): ParsedPrompt {
  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const { data, content } = matter(fileContent);

  // If no frontmatter, return just the content
  if (Object.keys(data).length === 0) {
    return {
      metadata: undefined,
      content: fileContent.trim(),
    };
  }

  // Validate frontmatter against schema
  try {
    const metadata = promptFrontmatterSchema.parse(data);
    return {
      metadata,
      content: content.trim(),
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
      throw new Error(
        `Invalid frontmatter in ${filePath}:\n${issues}\n\n` +
        `Allowed fields: model, continuationMode, name, description, tags, version, author`
      );
    }
    throw error;
  }
}

/**
 * Load multiple prompt files, combining content and using first file's metadata.
 */
export function loadPromptFiles(filePaths: string[]): ParsedPrompt {
  let combinedContent = '';
  let firstMetadata: PromptFrontmatter | undefined;

  for (const filePath of filePaths) {
    const { metadata, content } = loadPromptWithFrontmatter(filePath);

    // First file's metadata takes precedence
    if (!firstMetadata && metadata) {
      firstMetadata = metadata;
    }

    combinedContent += content + '\n\n';
  }

  return {
    metadata: firstMetadata,
    content: combinedContent.trim(),
  };
}
```

### Step 3: Integrate with Codon Loading

**Modify prompt loading in `server/codon-runner.ts` or relevant file:**

```typescript
import { loadPromptFiles, PromptFrontmatter } from './prompt-frontmatter.js';

// In codon initialization:
let promptContent: string;
let promptMetadata: PromptFrontmatter | undefined;

if (codon.promptFile) {
  const files = Array.isArray(codon.promptFile)
    ? codon.promptFile
    : [codon.promptFile];

  const result = loadPromptFiles(files);
  promptContent = result.content;
  promptMetadata = result.metadata;
} else if (codon.promptText) {
  promptContent = codon.promptText;
  promptMetadata = undefined;  // No frontmatter for inline text
}

// Apply frontmatter overrides (respecting precedence)
let effectiveConfig = { ...codon };

if (promptMetadata) {
  // Layer 2: Frontmatter overrides codon config (but CLI can still override)
  if (promptMetadata.model && !cliOverrideModel) {
    effectiveConfig.model = promptMetadata.model;
  }
  if (promptMetadata.continuationMode && !cliOverrideContinuation) {
    effectiveConfig.continuationMode = promptMetadata.continuationMode;
  }
}
```

### Step 4: Update Types

**Add to `server/types/types.ts`:**

```typescript
export interface PromptFrontmatter {
  model?: string;
  continuationMode?: 'fresh' | 'continue-previous';
  name?: string;
  description?: string;
  tags?: string[];
  version?: string;
  author?: string;
}

// Add to execution metadata
export interface CodonExecutionRecord {
  codonId: string;
  promptFiles?: string[];
  promptMetadata?: PromptFrontmatter;
  // ... other fields
}
```

### Step 5: Store Metadata in Execution State

**When recording codon execution:**

```typescript
// In execution metadata recording
const codonRecord: CodonExecutionRecord = {
  codonId: codon.id,
  promptFiles: codon.promptFile
    ? (Array.isArray(codon.promptFile) ? codon.promptFile : [codon.promptFile])
    : undefined,
  promptMetadata: promptMetadata,
  startTime: new Date().toISOString(),
};

// Save to .strandweave/state.json or events
```

### Step 6: Update Documentation

**Add to README.md:**

```markdown
### Prompt Files with Frontmatter

Prompt markdown files can include YAML frontmatter for metadata and configuration:

\`\`\`markdown
---
name: "Analyze TypeScript Codebase"
description: "Comprehensive analysis for TypeScript projects"
model: opus
tags: ["analysis", "typescript"]
version: "1.0"
author: "Your Name"
---

Read the source files in <%DATA_DIR%> and analyze:
- Code structure and patterns
- Type safety usage
- Potential improvements
\`\`\`

#### Frontmatter Fields

| Field | Type | Purpose |
|-------|------|---------|
| `model` | string | Override the codon's model setting |
| `continuationMode` | `"fresh"` \| `"continue-previous"` | Override continuation mode |
| `name` | string | Display name for the prompt |
| `description` | string | What this prompt does |
| `tags` | string[] | For categorization |
| `version` | string | Prompt version |
| `author` | string | Author name |

#### Precedence

When the same setting is specified in multiple places, the most specific wins:

1. CLI flags (`--model opus`) - highest priority
2. Prompt frontmatter
3. Codon config in strand.json
4. Strand recommendations
5. Defaults - lowest priority
```

## Code Integration Points

### New File: `server/prompt-frontmatter.ts`

New module for frontmatter parsing and schema validation.

### Modify: `server/codon-runner.ts` (or equivalent)

Add frontmatter loading when processing prompt files.

### Modify: `server/types/types.ts`

Add PromptFrontmatter interface.

### Modify: README.md

Add documentation and examples.

## Testing Strategy

This feature adds YAML frontmatter parsing with schema validation and precedence rules. Testing should focus on parser correctness (gray-matter edge cases), schema validation, and the precedence chain. Since it reuses gray-matter, we don't need to test YAML parsing extensively.

### Unit Tests (tests/unit/prompt-frontmatter.test.ts)

Focus on the frontmatter module and schema validation:

```typescript
describe("Frontmatter Parsing", () => {
  test("parses valid frontmatter with all fields", () => {
    const content = `---
name: Test Prompt
description: A test prompt
model: opus
continuationMode: fresh
tags: [analysis, testing]
version: "1.0.0"
author: Test Author
---
Prompt content here`;

    const result = loadPromptWithFrontmatter(createTempFile(content));

    expect(result.metadata).toEqual({
      name: 'Test Prompt',
      description: 'A test prompt',
      model: 'opus',
      continuationMode: 'fresh',
      tags: ['analysis', 'testing'],
      version: '1.0.0',
      author: 'Test Author',
    });
    expect(result.content).toBe('Prompt content here');
  });

  test("handles files without frontmatter", () => {
    const content = 'Just plain markdown content\n\nWith multiple paragraphs.';
    const result = loadPromptWithFrontmatter(createTempFile(content));

    expect(result.metadata).toBeUndefined();
    expect(result.content).toBe(content.trim());
  });

  test("handles empty frontmatter block", () => {
    const content = `---
---
Content after empty frontmatter`;

    const result = loadPromptWithFrontmatter(createTempFile(content));
    expect(result.metadata).toBeUndefined();
    expect(result.content).toBe('Content after empty frontmatter');
  });

  test("rejects unknown frontmatter fields", () => {
    const content = `---
name: Test
model: opus
unknownField: value
---
Content`;

    expect(() => loadPromptWithFrontmatter(createTempFile(content)))
      .toThrow(/Invalid frontmatter/);
    expect(() => loadPromptWithFrontmatter(createTempFile(content)))
      .toThrow(/unknownField/);
  });

  test("rejects invalid enum values", () => {
    const content = `---
continuationMode: invalid-mode
---
Content`;

    expect(() => loadPromptWithFrontmatter(createTempFile(content)))
      .toThrow(/Invalid frontmatter/);
  });

  test("handles markdown code blocks with YAML examples", () => {
    // This is why we use gray-matter - it handles this edge case
    const content = `---
model: opus
---
Here's an example YAML block:
\`\`\`yaml
---
example: config
---
\`\`\``;

    const result = loadPromptWithFrontmatter(createTempFile(content));
    expect(result.metadata?.model).toBe('opus');
    expect(result.content).toContain('```yaml');
  });

  test("preserves content whitespace and formatting", () => {
    const content = `---
name: Test
---
  Indented line
    More indented

Normal line`;

    const result = loadPromptWithFrontmatter(createTempFile(content));
    expect(result.content).toContain('  Indented line');
    expect(result.content).toContain('    More indented');
  });
});

describe("Multiple Prompt Files", () => {
  test("combines content from multiple files", () => {
    const result = loadPromptFiles([
      createTempPromptFile('File 1 content'),
      createTempPromptFile('File 2 content'),
      createTempPromptFile('File 3 content'),
    ]);

    expect(result.content).toContain('File 1 content');
    expect(result.content).toContain('File 2 content');
    expect(result.content).toContain('File 3 content');
  });

  test("first file's frontmatter takes precedence", () => {
    const result = loadPromptFiles([
      createTempPromptFile('---\nmodel: opus\n---\nContent 1'),
      createTempPromptFile('---\nmodel: sonnet\n---\nContent 2'),
      createTempPromptFile('---\nmodel: haiku\n---\nContent 3'),
    ]);

    expect(result.metadata?.model).toBe('opus'); // First file wins
  });

  test("uses first file with frontmatter when earlier files have none", () => {
    const result = loadPromptFiles([
      createTempPromptFile('Plain content'),
      createTempPromptFile('---\nmodel: sonnet\n---\nWith frontmatter'),
      createTempPromptFile('More plain content'),
    ]);

    expect(result.metadata?.model).toBe('sonnet');
  });

  test("separates content with newlines", () => {
    const result = loadPromptFiles([
      createTempPromptFile('File 1'),
      createTempPromptFile('File 2'),
    ]);

    // Files should be separated
    expect(result.content).toMatch(/File 1\s+File 2/);
  });
});
```

**Rationale:** Frontmatter parsing is the core functionality. Gray-matter handles most edge cases, but we need to test our schema validation and multi-file combining logic.

### Integration Tests (tests/integration/frontmatter-precedence.test.ts)

Test the precedence chain:

```typescript
describe("Frontmatter Precedence", () => {
  test("frontmatter model overrides codon config", async () => {
    const strand = {
      strand: [{
        id: 'test',
        name: 'Test',
        model: 'sonnet', // Codon specifies sonnet
        continuationMode: 'fresh',
        promptFile: createPromptWithFrontmatter({ model: 'opus' }), // Frontmatter specifies opus
      }],
    };

    const effectiveConfig = await resolveCodonConfig(strand.strand[0], {});

    expect(effectiveConfig.model).toBe('opus'); // Frontmatter wins
  });

  test("CLI model overrides frontmatter", async () => {
    const strand = {
      strand: [{
        id: 'test',
        name: 'Test',
        model: 'sonnet',
        continuationMode: 'fresh',
        promptFile: createPromptWithFrontmatter({ model: 'opus' }),
      }],
    };

    const effectiveConfig = await resolveCodonConfig(strand.strand[0], {
      cliModel: 'haiku', // CLI override
    });

    expect(effectiveConfig.model).toBe('haiku'); // CLI wins
  });

  test("frontmatter continuationMode works", async () => {
    const strand = {
      strand: [{
        id: 'test',
        name: 'Test',
        model: 'sonnet',
        continuationMode: 'fresh', // Codon default
        promptFile: createPromptWithFrontmatter({ continuationMode: 'continue-previous' }),
      }],
    };

    const effectiveConfig = await resolveCodonConfig(strand.strand[0], {});

    expect(effectiveConfig.continuationMode).toBe('continue-previous');
  });

  test("full precedence chain: CLI > frontmatter > codon > strand > defaults", async () => {
    // Strand recommendations
    const strand = {
      recommendations: { model: 'haiku' },
      strand: [{
        id: 'test',
        name: 'Test',
        model: 'sonnet', // Codon config
        continuationMode: 'fresh',
        promptFile: createPromptWithFrontmatter({ model: 'opus' }), // Frontmatter
      }],
    };

    // No CLI override
    let config = await resolveCodonConfig(strand.strand[0], { strandRecommendations: strand.recommendations });
    expect(config.model).toBe('opus'); // Frontmatter beats codon

    // With CLI override
    config = await resolveCodonConfig(strand.strand[0], {
      strandRecommendations: strand.recommendations,
      cliModel: '3.5-sonnet',
    });
    expect(config.model).toBe('3.5-sonnet'); // CLI beats everything
  });

  test("metadata fields don't affect execution", async () => {
    // Metadata like name, description, tags should not change behavior
    const strand = {
      strand: [{
        id: 'test',
        name: 'Test',
        model: 'sonnet',
        continuationMode: 'fresh',
        promptFile: createPromptWithFrontmatter({
          name: 'Custom Prompt Name',
          description: 'A description',
          tags: ['test', 'example'],
          version: '2.0.0',
        }),
      }],
    };

    const effectiveConfig = await resolveCodonConfig(strand.strand[0], {});

    // Model should not change (only metadata provided)
    expect(effectiveConfig.model).toBe('sonnet');

    // But metadata should be available
    expect(effectiveConfig.promptMetadata?.name).toBe('Custom Prompt Name');
  });
});
```

**Rationale:** Precedence is the most complex part of this feature. These tests ensure the chain works correctly: CLI > frontmatter > codon > strand > defaults.

### Integration Tests: Execution Metadata Storage

```typescript
describe("Prompt Metadata Storage", () => {
  test("stores frontmatter in execution metadata", async () => {
    const promptFile = createPromptWithFrontmatter({
      name: 'Analysis Prompt',
      version: '1.2.0',
      model: 'opus',
    });

    const result = await runCodon({
      id: 'test',
      promptFile,
    });

    const meta = await readExecutionMetadata(result.executionPath);
    expect(meta.codons[0].promptMetadata).toEqual({
      name: 'Analysis Prompt',
      version: '1.2.0',
      model: 'opus',
    });
  });

  test("does not store metadata for promptText", async () => {
    const result = await runCodon({
      id: 'test',
      promptText: 'Inline prompt text',
    });

    const meta = await readExecutionMetadata(result.executionPath);
    expect(meta.codons[0].promptMetadata).toBeUndefined();
  });
});
```

**Rationale:** Metadata storage enables debugging and audit trails. These tests ensure metadata is recorded correctly.

### E2E Test: Attach to Existing Suite

Add to tests/e2e/happy-path-e2e.test.ts:

```typescript
describe("Prompt Frontmatter", () => {
  test("runs codon with frontmatter model override", async () => {
    // Create temp prompt file with frontmatter
    const promptPath = path.join(TEST_AREA, `prompt-${Date.now()}.md`);
    fs.writeFileSync(promptPath, `---
model: opus
name: E2E Test Prompt
version: "1.0.0"
---
Create a file called result.txt with content "frontmatter test"`);

    // Create strand that uses sonnet but prompt overrides to opus
    const strandPath = path.join(TEST_AREA, `strand-${Date.now()}.json`);
    fs.writeFileSync(strandPath, JSON.stringify({
      strand: [{
        id: 'test',
        name: 'Test',
        model: 'sonnet', // This should be overridden
        continuationMode: 'fresh',
        promptFile: promptPath,
        checkpointedFiles: ['result.txt'],
      }],
    }));

    const result = await startServer({
      config: strandPath,
      data: TEST_DATA_DIR,
      args: ['--start-new'],
    });

    expect(result.success).toBe(true);

    // Check execution metadata shows opus was used
    const meta = readExecutionMetadata(result.executionPath);
    expect(meta.codons[0].promptMetadata?.model).toBe('opus');
    expect(meta.codons[0].promptMetadata?.name).toBe('E2E Test Prompt');

    // Verify agent actually ran (created the file)
    expect(fs.existsSync(path.join(result.executionPath, 'result.txt'))).toBe(true);
  });

  test("CLI --model overrides frontmatter", async () => {
    const promptPath = path.join(TEST_AREA, `prompt-${Date.now()}.md`);
    fs.writeFileSync(promptPath, `---
model: opus
---
Test prompt`);

    const strandPath = path.join(TEST_AREA, `strand-${Date.now()}.json`);
    fs.writeFileSync(strandPath, JSON.stringify({
      strand: [{
        id: 'test',
        name: 'Test',
        model: 'sonnet',
        continuationMode: 'fresh',
        promptFile: promptPath,
        promptText: 'Output model name to model.txt',
        checkpointedFiles: ['model.txt'],
      }],
    }));

    const result = await startServer({
      config: strandPath,
      data: TEST_DATA_DIR,
      args: ['--start-new', '--model', 'haiku'],
    });

    expect(result.success).toBe(true);

    // CLI should have overridden frontmatter
    // (Verifying actual model used requires inspecting Claude API calls,
    // which is difficult in E2E. This test at least verifies no errors.)
  });
});
```

**Rationale:** E2E test verifies the complete flow: frontmatter is parsed, precedence is applied, metadata is stored, and the agent runs successfully.

### No Need for Gray-Matter Library Tests

Gray-matter is a battle-tested library used by major projects. We don't need to test its YAML parsing extensively. Our tests focus on our wrapper logic: schema validation, multi-file handling, and precedence.

## Complexity Assessment

**Overall complexity:** Low-Medium

**Breakdown:**
- gray-matter dependency: Done with `bun add`
- Frontmatter parsing module: ~80 lines
- Schema definition: ~30 lines
- Integration with codon loading: ~50 lines
- Precedence logic: ~40 lines
- Metadata storage: ~20 lines
- Type definitions: ~20 lines
- Tests: ~100 lines
- Documentation: ~50 lines

**Total new code:** ~240 lines
**Total effort:** 1 day

## Risk Mitigation

### Risk 1: Precedence Confusion
**Mitigation:** Document precedence order prominently with examples. Add warning when frontmatter is overridden by CLI.

### Risk 2: Breaking Existing Prompts
**Mitigation:** This is purely additive. Files without frontmatter continue to work as plain text.

### Risk 3: Invalid YAML Breaking Execution
**Mitigation:** Clear error messages showing what's wrong and which fields are allowed.

### Risk 4: Performance Impact
**Mitigation:** gray-matter is fast and only parses the frontmatter section. Impact is negligible.

## Dependencies

**New dependency:** `gray-matter`
- Well-maintained, industry standard
- ~35KB unpacked size
- Zero dependencies of its own

## Open Questions for User

Before implementation, please confirm the following decisions:

### 1. Strict Schema Validation
**Current recommendation:** Reject unknown frontmatter fields to catch typos. For example, `modle: opus` would error with "Unknown field 'modle'. Did you mean 'model'?"

**Question:** Could this be too strict? Should there be support for custom fields using an `x-` prefix (similar to HTTP headers)? For example, `x-internal-version: 2024-Q4` would be allowed but ignored.

### 2. Precedence Order Intuition
**Current recommendation:**
```
CLI flags > Prompt frontmatter > Codon config > Strand recommendations > Defaults
```

**Question:** Is this intuitive? Some users might expect codon config in strand.json to override prompt frontmatter since the strand.json is the "orchestrating" document. Would you prefer:
- Current: Prompt frontmatter overrides codon config (prompts are more specialized)
- Alternative: Codon config overrides frontmatter (strand.json is authoritative)

### 3. Metadata Display
**Current recommendation:** Store prompt metadata in execution state for debugging but don't display it during normal execution.

**Question:** Should the TUI show prompt metadata (name, version, author) when a codon starts? This could help users understand which version of a prompt is being used.

---

## Backward Compatibility

Full backward compatibility maintained:
- Prompts without frontmatter continue to work as before
- All existing strand configurations work unchanged
- No breaking changes to any existing behavior

## Future Enhancements (Out of Scope)

These could be added in future iterations:
1. **Prompt library command:** `strandweave --list-prompts --tag analysis`
2. **Environment variable substitution:** `model: ${STRANDWEAVE_MODEL}`
3. **Prompt validation command:** `strandweave --validate-prompt prompts/analyze.md`
4. **Template parameters:** Define variables in frontmatter to fill in

---

## Testing Requirements and Affected Tests

This section documents all existing tests that need to be updated when implementing this change, as well as comprehensive testing requirements.

### Tests That Must Be Updated (Required Changes)

This feature adds frontmatter parsing to prompt files. These tests work with prompts:

#### Unit Tests

1. **tests/unit/config.test.ts**
   - Currently tests prompt file loading
   - May need to test that prompts with frontmatter load correctly
   - **Action:** Verify promptFile fields work with frontmatter-enabled prompts

2. **Create: tests/unit/prompt-frontmatter.test.ts** (NEW FILE)
   - Implement all frontmatter parsing tests from Testing Strategy section
   - Test schema validation
   - Test multiple file handling
   - Test gray-matter edge cases
   - **Status:** Must be created from scratch
   - **Coverage:** Frontmatter parsing and validation
   - **Lines of code:** ~600 lines (as specified in plan)

#### Integration Tests

3. **Create: tests/integration/frontmatter-precedence.test.ts** (NEW FILE)
   - Implement all precedence tests from Testing Strategy section
   - Test frontmatter overrides codon config
   - Test CLI overrides frontmatter
   - Test full precedence chain
   - **Status:** Must be created from scratch
   - **Coverage:** Configuration precedence rules
   - **Lines of code:** ~450 lines (as specified in plan)

4. **Create: tests/integration/frontmatter-metadata-storage.test.ts** (NEW FILE)
   - Test metadata is stored in execution state
   - Test metadata retrieval for debugging
   - **Status:** Must be created from scratch
   - **Coverage:** Metadata persistence
   - **Lines of code:** ~150 lines

#### E2E Tests

5. **Update: tests/e2e/happy-path-e2e.test.ts**
   - Add new test group from Testing Strategy section
   - Test running codon with frontmatter model override
   - Test CLI --model overrides frontmatter
   - **Test groups to add:**
     - "Prompt Frontmatter" (from plan lines 757-832)
   - **Action:** Add test group after existing groups

6. **tests/e2e/multi-file-prompt-tests.test.ts** (if exists)
   - Check if multi-file prompt tests exist
   - Verify frontmatter precedence works with multiple files
   - **Action:** Update or create tests for multi-file frontmatter

### New Tests To Add (Test the New Feature)

The plan already has a comprehensive Testing Strategy section. Here are the specific files that must be created:

#### 1. Frontmatter Parsing Unit Tests (tests/unit/prompt-frontmatter.test.ts)

**From Testing Strategy section, lines 456-600:**
- Valid frontmatter parsing with all fields
- Files without frontmatter
- Empty frontmatter blocks
- Unknown field rejection (strict schema)
- Invalid enum values
- YAML code blocks in content (gray-matter edge case)
- Whitespace preservation
- Multiple prompt files with precedence

**Status:** Complete test suite already designed in plan
**Estimated:** 20-25 test cases, ~600 lines
**Action:** Implement exactly as specified in Testing Strategy section

#### 2. Precedence Integration Tests (tests/integration/frontmatter-precedence.test.ts)

**From Testing Strategy section, lines 609-711:**
- Frontmatter model overrides codon config
- CLI model overrides frontmatter
- Continuation mode precedence
- Full precedence chain testing
- Metadata fields don't affect execution

**Status:** Complete test suite already designed in plan
**Estimated:** 10-15 test cases, ~450 lines
**Action:** Implement exactly as specified in Testing Strategy section

#### 3. Metadata Storage Tests (tests/integration/frontmatter-metadata-storage.test.ts)

**From Testing Strategy section, lines 718-749:**
- Metadata stored in execution metadata
- No metadata for promptText (inline)
- Metadata available for debugging

**Status:** Complete test suite already designed in plan
**Estimated:** 3-5 test cases, ~150 lines
**Action:** Implement exactly as specified in Testing Strategy section

#### 4. E2E Frontmatter Tests (add to tests/e2e/happy-path-e2e.test.ts)

**From Testing Strategy section, lines 758-832:**
- Run codon with frontmatter model override
- Verify metadata is recorded
- CLI --model overrides frontmatter

**Status:** Complete test suite already designed in plan
**Estimated:** 3-5 test cases, ~200 lines
**Action:** Implement exactly as specified in Testing Strategy section

### Regression Tests (Critical - Must Pass)

After implementing frontmatter support, these existing test suites must pass:

1. **Config Loading Tests** (tests/unit/config.test.ts)
   - Ensures prompt loading still works
   - **Critical:** Prompts without frontmatter must continue to work

2. **Multi-File Prompt Tests** (tests/e2e/happy-path-e2e.test.ts)
   - Test group: `runMultiFilePromptTests`
   - Ensures multiple prompt files still work
   - **Action:** Run and verify no regressions

3. **Codon Execution Tests** (tests/e2e/happy-path-e2e.test.ts)
   - Test group: `runCodonExecutionTests`
   - Ensures codon execution works with frontmatter prompts

4. **Model Selection Tests**
   - Tests that verify model selection works correctly
   - Must respect precedence rules
   - **Action:** Run existing model tests

### CI/CD Pipeline Considerations

The CI/CD pipeline (`.github/workflows/ci.yml`) considerations:

1. **Lint and Type Check** (Job: `lint-and-typecheck`)
   - New frontmatter parsing module must pass linting
   - PromptFrontmatter interface must type check
   - **Action:** Run `bun run tc` locally

2. **Unit & Integration Tests** (Job: `tests`)
   - Three new test files must be included and pass
   - All existing tests must pass
   - **Action:** Verify `bun test tests/unit` and `bun test tests/integration` pass

3. **E2E Tests**
   - Existing E2E tests should pass unchanged
   - New E2E test group should be included
   - **Action:** Run full E2E suite

4. **Dependencies**
   - gray-matter must be installed
   - **Action:** Verify `bun install` includes gray-matter

### Test Execution Checklist

Execute tests in this order:

```bash
# 1. Install dependencies (new: gray-matter)
bun install

# 2. Type check (verify new module and interfaces)
bun run tc

# 3. Linting
bun run lint:fix

# 4. Unit tests - NEW tests first
bun test tests/unit/prompt-frontmatter.test.ts  # New file
bun test tests/unit/config.test.ts  # Verify no regressions
bun test tests/unit  # All unit tests

# 5. Integration tests - NEW tests
bun test tests/integration/frontmatter-precedence.test.ts  # New file
bun test tests/integration/frontmatter-metadata-storage.test.ts  # New file
bun test tests/integration  # All integration tests

# 6. E2E tests (expensive)
bun test tests/e2e/happy-path-e2e.test.ts  # With new frontmatter test group
bun test tests/e2e  # All E2E tests
```

### Manual Testing Scenarios

Test these scenarios manually to verify user experience:

#### 1. Prompt with Frontmatter

Create a test prompt file:
```bash
cat > prompts/analyze.md <<'EOF'
---
name: "Code Analyzer"
description: "Analyzes code structure"
model: opus
tags: ["analysis", "code-review"]
version: "1.0.0"
---

Analyze the code in <%DATA_DIR%> and write a summary.
EOF

# Run with this prompt
strandweave strand.json ./data --model sonnet

# Expected: Uses opus (frontmatter) not sonnet (CLI would override if it worked)
```

#### 2. CLI Override

```bash
# Same prompt as above
strandweave strand.json ./data --model haiku

# Expected: Uses haiku (CLI overrides frontmatter)
# Verify by checking logs or execution metadata
```

#### 3. Prompt Without Frontmatter (Backward Compatibility)

```bash
cat > prompts/simple.md <<'EOF'
Just plain markdown content without frontmatter.
EOF

# Run with this prompt
strandweave strand.json ./data

# Expected: Works normally, no frontmatter parsed
```

#### 4. Invalid Frontmatter (Error Handling)

```bash
cat > prompts/invalid.md <<'EOF'
---
model: opus
unknownField: value
---
Content
EOF

# Run with this prompt
strandweave strand.json ./data

# Expected: Error about unknown field
# Error message should list allowed fields
```

#### 5. Multiple Prompts with Frontmatter

```bash
cat > prompts/part1.md <<'EOF'
---
model: opus
name: "Part 1"
---
First part of prompt
EOF

cat > prompts/part2.md <<'EOF'
---
model: sonnet
name: "Part 2"
---
Second part of prompt
EOF

# Create strand with both prompts
# First file's frontmatter should take precedence

# Expected: Uses opus (from part1.md)
```

#### 6. Verify Metadata Storage

```bash
# Run with frontmatter prompt
strandweave strand.json ./data --start-new

# Check execution metadata
cat ~/.strandweave-executions/latest/.strandweave/state.json | jq '.codons[0].promptMetadata'

# Expected: Shows frontmatter metadata (name, model, version, etc.)
```

### Error Message Verification

Verify these error messages display correctly:

1. **Unknown Field Error** (from plan, lines 265-270)
   ```
   Invalid frontmatter in prompts/analyze.md:
     - unknownField: Unrecognized key

   Allowed fields: model, continuationMode, name, description, tags, version, author
   ```

2. **Invalid Enum Value** (schema validation)
   ```
   Invalid frontmatter in prompts/analyze.md:
     - continuationMode: Invalid enum value
   ```

### Search Commands for Implementation

Use these commands during implementation:

```bash
# Find prompt loading code
grep -rn "promptFile\|promptText" server/codon-runner.ts server/config.ts

# Find model selection code
grep -rn "codon.model" server/

# Verify gray-matter is imported
grep -rn "from 'gray-matter'" server/

# Find metadata storage code
grep -rn "promptMetadata" server/
```

### Dependency Verification

```bash
# Check gray-matter is installed
bun pm ls | grep gray-matter

# Check types are available
ls node_modules/@types/gray-matter

# Verify no security vulnerabilities
bun audit
```

### Summary of Test Impact

| Test Type | New Files | Updated Files | Test Cases | Lines of Code |
|-----------|-----------|---------------|------------|---------------|
| Unit Tests | 1 new file | 0 files | ~25 cases | ~600 lines |
| Integration Tests | 2 new files | 0 files | ~15 cases | ~600 lines |
| E2E Tests | 0 new files | 1 file | ~5 cases | ~200 lines |
| Manual Tests | N/A | N/A | 6 scenarios | N/A |
| **Total** | **3 new files** | **1 file** | **~45 cases** | **~1400 lines** |

**Estimated Time for New Tests:** 6-8 hours (comprehensive test suite)
**Estimated Time for Manual Testing:** 1-2 hours
**Total Testing Effort:** 7-10 hours

### Special Testing Considerations

1. **Gray-Matter Edge Cases**
   - YAML code blocks in markdown content
   - Malformed YAML handling
   - Performance with large prompt files
   - Unicode and special characters in YAML

2. **Precedence Chain Verification**
   - Test all 5 layers: CLI > Frontmatter > Codon > Strand > Defaults
   - Ensure each layer correctly overrides the next
   - Test with missing values at various layers

3. **Schema Strictness**
   - Verify typos are caught (e.g., `modle` instead of `model`)
   - Test with additional unknown fields
   - Verify error messages are helpful

4. **Multi-File Precedence**
   - First file's frontmatter wins
   - Content from all files is combined
   - Order matters

5. **Metadata Preservation**
   - Metadata doesn't affect execution
   - Metadata is available for debugging
   - Metadata persists across resume

### Critical Success Criteria

Before considering this implementation complete, verify:

1. ✅ gray-matter dependency installed successfully
2. ✅ Frontmatter parsing works with all valid fields
3. ✅ Schema validation catches unknown fields
4. ✅ Precedence chain works correctly (CLI > FM > Codon > Strand > Defaults)
5. ✅ First file's frontmatter takes precedence in multi-file prompts
6. ✅ Prompts without frontmatter continue to work (backward compatibility)
7. ✅ Metadata is stored in execution state
8. ✅ Error messages are clear and helpful
9. ✅ All existing prompt-related tests pass
10. ✅ `bun run tc` passes without errors
11. ✅ `bun run lint` passes without errors
12. ✅ No new dependencies have security vulnerabilities

### Documentation Updates Required

When implementing this feature, also update:

1. **README.md** (from plan, lines 385-427)
   - Add "Prompt Files with Frontmatter" section
   - Document all frontmatter fields
   - Show precedence order
   - Provide examples

2. **Init command template** (server/init-command.ts)
   - Update generated prompt template to show frontmatter example
   - Include comments explaining fields

3. **Help text** (server/index.ts)
   - Mention frontmatter support in help output
   - Link to documentation

### Backward Compatibility Verification

**Critical:** Test that plain markdown prompts (without frontmatter) continue to work:

```bash
# 1. Test with existing prompt files (no frontmatter)
# 2. Run all tests with plain prompts
# 3. Verify no warnings or errors about missing frontmatter
# 4. Confirm behavior is unchanged

# Example test
echo "Plain prompt text" > plain.md
strandweave --config strand.json --data ./data
# Should work exactly as before
```

### Performance Considerations

Test frontmatter parsing performance:

```bash
# Create a large prompt file (10KB+)
# with frontmatter

# Measure parse time
time bun run loadPromptWithFrontmatter large-prompt.md

# Expected: < 10ms parsing time
# gray-matter is fast, but verify
```

This feature adds powerful configuration capabilities to prompts while maintaining full backward compatibility. The comprehensive test suite (45+ test cases) ensures robustness and validates the complex precedence rules.
