# Complete Guide to Phase Configuration

This guide covers all the ways you can configure phases in Tadpole Runner, from simple single-phase workflows to complex multi-phase automations with workspace setup, file tracking, and environment management.

## Table of Contents
1. [Basic Phase Structure](#basic-phase-structure)
2. [Prompt Configuration](#prompt-configuration)
3. [Model Selection](#model-selection)
4. [Continuation Modes](#continuation-modes)
5. [Workspace Setup](#workspace-setup)
6. [File Tracking](#file-tracking)
7. [Environment Variables](#environment-variables)
8. [Output Configuration](#output-configuration)
9. [Complete Examples](#complete-examples)
10. [Best Practices](#best-practices)
11. [Common Patterns](#common-patterns)

## Basic Phase Structure

Every phase must have these required fields:

```json
{
  "id": "unique-phase-id",           // Must be unique across all phases
  "name": "Human Readable Name",     // Displayed in UI/logs
  "model": "sonnet",                 // "sonnet" or "opus"
  "continuationMode": "fresh"        // "fresh" or "continue-previous"
}
```

Plus one of these prompt sources:
- `promptFile`: Path to a markdown file with the prompt
- `promptText`: Inline prompt text

## Prompt Configuration

### Single Prompt File
```json
{
  "id": "analyze",
  "name": "Code Analysis",
  "promptFile": "./prompts/analyze.md",
  "model": "sonnet",
  "continuationMode": "fresh"
}
```

### Multiple Prompt Files
When you need to combine multiple prompt files:
```json
{
  "promptFile": [
    "./prompts/base-instructions.md",
    "./prompts/specific-task.md",
    "./prompts/output-format.md"
  ]
}
```
Files are concatenated with double newlines between them.

### Inline Prompt Text
For simple prompts or dynamic content:
```json
{
  "promptText": "Please analyze the files in the src/ directory and suggest improvements."
}
```

### System Prompt Additions
Add system-level instructions that Claude will follow:
```json
{
  "appendSystemPromptFile": "./prompts/coding-standards.md",
  // OR
  "appendSystemPromptText": "Always write TypeScript with strict mode enabled.",
  // OR multiple files
  "appendSystemPromptFile": [
    "./prompts/project-context.md",
    "./prompts/style-guide.md"
  ]
}
```

### Template Variables
Both prompts and system prompts support template variables that are replaced at runtime:

- `<%EXECUTION_DIR%>` - The execution directory path (recommended)
- `<%DATA_DIR%>` - The data directory path (`execution-dir/read_only_data_source`)
- `<%PROJECT_DIR%>` - **Deprecated** but still works, maps to execution directory

Example usage:
```markdown
Please analyze the code in <%DATA_DIR%>/src and create documentation in <%EXECUTION_DIR%>/docs
```

This ensures Claude reads from your original data but writes to the execution directory, keeping your project clean. Note that `<%DATA_DIR%>` works consistently whether your data source is a file or directory.

## Model Selection

### Claude 3.5 Sonnet
```json
{
  "model": "sonnet"
}
```
- **Speed**: Fast (typically 5-30 seconds per response)
- **Cost**: $3 per million input tokens, $15 per million output tokens
- **Best for**: Most coding tasks, analysis, refactoring, documentation
- **Context**: 200K tokens

### Claude 3 Opus
```json
{
  "model": "opus"
}
```
- **Speed**: Slower (typically 30-120 seconds per response)
- **Cost**: Higher than Sonnet
- **Best for**: Complex reasoning, architecture decisions, nuanced analysis
- **Context**: 200K tokens

## Continuation Modes

### Fresh Start
Each phase starts a new conversation:
```json
{
  "continuationMode": "fresh"
}
```

### Continue Previous
Maintains conversation context from the previous phase:
```json
{
  "continuationMode": "continue-previous"
}
```

### Multi-Phase Workflow Example
```json
[
  {
    "id": "design",
    "name": "Design API",
    "continuationMode": "fresh",
    "promptText": "Design a REST API for a todo application"
  },
  {
    "id": "implement",
    "name": "Implement API",
    "continuationMode": "continue-previous",
    "promptText": "Now implement the API you just designed in TypeScript"
  },
  {
    "id": "test",
    "name": "Write Tests",
    "continuationMode": "continue-previous",
    "promptText": "Write comprehensive tests for the implementation"
  }
]
```

## Workspace Setup

### Copy Operations
Copy files or directories before the phase starts:

```json
{
  "workspaceSetup": [
    {
      "type": "copy",
      "copy": {
        "from": "./templates/express-starter",
        "to": "backend"
      }
    }
  ]
}
```

### Command Execution
Run shell commands to prepare the environment:

```json
{
  "workspaceSetup": [
    {
      "type": "command",
      "command": {
        "run": "npm init -y",
        "workingDirectory": "project"
      }
    }
  ]
}
```

### Combined Setup
A complete setup sequence:

```json
{
  "workspaceSetup": [
    // First, copy template files
    {
      "type": "copy",
      "copy": {
        "from": "./templates/react-app",
        "to": "frontend"
      }
    },
    // Then install dependencies in the copied directory
    {
      "type": "command",
      "command": {
        "run": "npm install",
        "workingDirectory": "lastCopied"  // Special value: uses "frontend" from above
      }
    },
    // Run any other setup commands
    {
      "type": "command",
      "command": {
        "run": "npm run build",
        "workingDirectory": "lastCopied"
      }
    }
  ]
}
```

### Working Directory Options
- `"project"`: Run in the project root (where you run the command from)
- `"lastCopied"`: Run in the destination of the last copy operation

## File Tracking

### Basic Patterns
```json
{
  "trackedFiles": [
    "*.js",           // All JS files in root
    "src/**/*.ts",    // All TS files in src (recursive)
    "docs/**/*",      // Everything in docs
    "config/*.json"   // JSON files in config
  ]
}
```

### Advanced Patterns
```json
{
  "trackedFiles": [
    "**/*.{ts,tsx}",        // TypeScript and TSX files
    "src/**/!(*.test).ts",  // Exclude test files
    "!node_modules",        // Exclude node_modules
    "!**/*.log",            // Exclude all log files
    "build/index.js"        // Include specific build output
  ]
}
```

### Pattern Reference
- `*` - Any characters except `/`
- `**` - Any characters including `/`
- `?` - Single character
- `[abc]` - Character class
- `!(pattern)` - Negation
- `{a,b,c}` - Brace expansion

## Environment Variables

### Phase-Specific Variables
```json
{
  "env": {
    "API_KEY": "phase-specific-key",
    "NODE_ENV": "development",
    "DEBUG": "true"
  }
}
```

### System Variables (TADPOLE_ prefix)
Set in your shell before running the server:
```bash
export TADPOLE_GITHUB_TOKEN=ghp_xxxxx
export TADPOLE_API_ENDPOINT=https://api.example.com
```

Claude will see these as:
- `GITHUB_TOKEN=ghp_xxxxx`
- `API_ENDPOINT=https://api.example.com`

## Output Configuration

Tadpole can automatically copy files from the execution directory to a `tadpole-results` directory where you run the command from. This makes it easy to access the output of your phases without navigating to the execution directory.

### Basic Output Configuration

Add an `outputFiles` array to your phase configuration (one or more copy groups):

```json
{
  "id": "analyze",
  "name": "Code Analysis", 
  "promptFile": "./prompts/analyze.md",
  "model": "sonnet",
  "continuationMode": "fresh",
  "trackedFiles": ["analysis.md"],
  "outputFiles": [
    {
      "copy": ["analysis.md"]
    }
  ]
}
```

This will copy `analysis.md` from the execution directory to `tadpole-results/analysis.md` when the phase completes successfully.

### Before-copy Commands

You can run shell commands before copying files in each output group using the `beforeCopy` array. These are especially useful when you need to rename files before copying them to the `tadpole-results` in the directory where you run tadpole. 

**Please note**: if one of the `beforeCopy` commands fails, the whole copy group fails and nothing is copied to `tadpole-results` for this specific group. Tadpole will however attempt to run remaining copy groups.

```json
{
  "outputFiles": [
    {
      "beforeCopy": [
        {
          "type": "command",
          "command": {
            "run": "mv analysis.md $(date +%Y_%m_%d)_analysis.md"
          }
        }
      ],
      "copy": ["*_analysis.md"]
    }
  ]
}
```

This example renames the analysis file with a timestamp before copying it.

### Copy Patterns

The `copy` array supports glob patterns for flexible file selection:

```json
{
  "outputFiles": [
    {
      "copy": [
        "*.md",                    // All markdown files
        "reports/**/*",            // Everything in reports directory
        "src/**/*.{ts,js}",        // TypeScript and JavaScript files in src
        "!src/**/*.test.*"         // Exclude test files
      ]
    }
  ]
}
```

### Output File Lifecycle

1. Phase executes and modifies files in the execution directory
2. Phase completes successfully
3. For each output group, `beforeCopy` commands run (if specified)
4. Files matching each group's `copy` patterns are copied to `tadpole-results/`. Subdirectories are recreated recursively inside `tadpole-results/` if needed.
5. Files accumulate in `tadpole-results/` across multiple phases

### Complete Output Example

```json
{
  "id": "documentation-phase",
  "name": "Generate Documentation",
  "promptFile": "./prompts/generate-docs.md",
  "model": "sonnet", 
  "continuationMode": "fresh",
  "trackedFiles": ["docs/**/*.md", "README.md"],
  "outputFiles": [
    {
      "beforeCopy": [
        {
          "type": "command",
          "command": {
            "run": "mkdir -p versioned-docs/$(date +%Y-%m-%d)"
          }
        },
        {
          "type": "command", 
          "command": {
            "run": "cp -r docs/* versioned-docs/$(date +%Y-%m-%d)/"
          }
        }
      ],
      "copy": [
        "versioned-docs/**/*",
        "README.md"
      ]
    }
  ]
}
```

## Complete Examples

### Example 1: Simple Analysis Phase
```json
{
  "id": "analyze-codebase",
  "name": "Codebase Analysis",
  "model": "sonnet",
  "continuationMode": "fresh",
  "promptFile": "./prompts/analyze.md",
  "trackedFiles": ["analysis.md"],
  "outputFiles": [
    {
      "copy": ["analysis.md"]
    }
  ]
}
```

### Example 2: Full Stack Application Setup
```json
[
  {
    "id": "setup-backend",
    "name": "Setup Express Backend",
    "model": "sonnet",
    "continuationMode": "fresh",
    "promptText": "Create an Express.js backend with TypeScript, including user authentication",
    "workspaceSetup": [
      {
        "type": "copy",
        "copy": {
          "from": "./templates/express-ts",
          "to": "backend"
        }
      },
      {
        "type": "command",
        "command": {
          "run": "npm install && npm run build",
          "workingDirectory": "lastCopied"
        }
      }
    ],
    "trackedFiles": [
      "backend/src/**/*.ts",
      "backend/package.json"
    ],
    "env": {
      "PORT": "3001"
    }
  },
  {
    "id": "setup-frontend",
    "name": "Create React Frontend",
    "model": "sonnet",
    "continuationMode": "continue-previous",
    "promptText": "Now create a React frontend that connects to the backend you just created",
    "workspaceSetup": [
      {
        "type": "command",
        "command": {
          "run": "npx create-react-app frontend --template typescript",
          "workingDirectory": "project"
        }
      }
    ],
    "trackedFiles": [
      "frontend/src/**/*.{ts,tsx}",
      "frontend/package.json"
    ]
  },
  {
    "id": "integrate",
    "name": "Integrate Frontend and Backend",
    "model": "sonnet",
    "continuationMode": "continue-previous",
    "promptText": "Connect the frontend to the backend API and create a working login flow",
    "trackedFiles": [
      "frontend/src/**/*.{ts,tsx}",
      "backend/src/**/*.ts"
    ]
  }
]
```

### Example 3: Migration Workflow
```json
[
  {
    "id": "analyze-legacy",
    "name": "Analyze Legacy Code",
    "model": "opus",  // Use more capable model for analysis
    "continuationMode": "fresh",
    "promptFile": "./prompts/analyze-for-migration.md",
    "trackedFiles": ["migration-plan.md"],
    "appendSystemPromptFile": "./prompts/migration-guidelines.md"
  },
  {
    "id": "create-tests",
    "name": "Create Test Suite",
    "model": "sonnet",
    "continuationMode": "continue-previous",
    "promptText": "Based on your analysis, create comprehensive tests for the legacy code before we migrate it",
    "trackedFiles": ["tests/**/*.test.js"]
  },
  {
    "id": "migrate-code",
    "name": "Perform Migration",
    "model": "sonnet",
    "continuationMode": "continue-previous",
    "promptFile": "./prompts/migrate-to-typescript.md",
    "trackedFiles": [
      "src/**/*.ts",
      "src/**/*.js"  // Track both old and new files
    ]
  },
  {
    "id": "verify",
    "name": "Verify Migration",
    "model": "sonnet",
    "continuationMode": "continue-previous",
    "promptText": "Run the tests and verify the migration was successful. Fix any issues.",
    "workspaceSetup": [
      {
        "type": "command",
        "command": {
          "run": "npm test",
          "workingDirectory": "project"
        }
      }
    ]
  }
]
```

## Best Practices

### 1. Phase Granularity
- Keep phases focused on a single logical task
- If a phase prompt exceeds 500 lines, consider splitting it
- Each phase should produce a clear, verifiable output

### 2. Model Selection Strategy
```json
{
  // Use Opus for complex reasoning
  "model": "opus",  // Design decisions, architecture planning

  // Use Sonnet for implementation
  "model": "sonnet"  // Coding, refactoring, documentation
}
```

### 3. File Tracking Strategy
- Track only files that the phase will create/modify
- Exclude large binary files and dependencies
- Use specific patterns to improve performance

### 4. Workspace Setup Tips

#### Performance Calculations

**Setup Time Estimation:**
```
T_setup = T_copy + T_commands
```

Where:
- `T_copy = ∑(S_i / R_disk)` for each copied item
- `S_i` = size of item i in bytes
- `R_disk` = disk read/write rate
- `T_commands = ∑(T_cmd_i)` for each command

**Copy vs Symlink Performance:**
```
T_symlink = O(1) ≈ 1ms
T_copy = O(n) = S_total / R_disk
```

#### Best Practices
- Test commands locally first
- Ensure commands are idempotent (safe to run multiple times)
- Use `&&` for command chaining, not separate command blocks
- Add error handling: `command || echo 'Command failed but continuing'`
- Consider copy time when using large templates: `T_copy ≈ size_GB × 10s` (typical SSD)

### 5. Continuation Strategy
- Use `fresh` when starting a new logical task
- Use `continue-previous` for multi-step processes
- Don't rely on continuation after very long phases (>100 messages)

### 6. Environment Variable Management
```bash
# Create a .env file for development
TADPOLE_API_KEY=xxx
TADPOLE_DB_URL=postgres://...

# Source it before running
source .env && bun run server
```

## Common Patterns

### Pattern 1: Iterative Development
```json
[
  { "id": "v1", "continuationMode": "fresh", "name": "Initial Implementation" },
  { "id": "review", "continuationMode": "continue-previous", "name": "Code Review" },
  { "id": "v2", "continuationMode": "continue-previous", "name": "Apply Improvements" }
]
```

### Pattern 2: Test-Driven Development
```json
[
  { "id": "spec", "name": "Write Specifications" },
  { "id": "tests", "continuationMode": "continue-previous", "name": "Write Tests" },
  { "id": "implement", "continuationMode": "fresh", "name": "Implementation" },
  { "id": "verify", "continuationMode": "fresh", "name": "Run Tests & Fix" }
]
```

### Pattern 3: Documentation Generation
```json
{
  "id": "document",
  "name": "Generate Documentation",
  "model": "sonnet",
  "continuationMode": "fresh",
  "promptFile": "./prompts/document.md",
  "appendSystemPromptText": "Use JSDoc format for all documentation",
  "trackedFiles": [
    "src/**/*.js",  // Read source files
    "docs/**/*.md"  // Write documentation
  ]
}
```

### Pattern 4: Refactoring Workflow
```json
[
  {
    "id": "analyze-code-smells",
    "name": "Identify Issues",
    "model": "opus",
    "promptText": "Analyze the codebase for code smells and anti-patterns",
    "trackedFiles": ["refactoring-plan.md"]
  },
  {
    "id": "refactor-step-1",
    "name": "Refactor Core Module",
    "model": "sonnet",
    "continuationMode": "continue-previous",
    "promptText": "Refactor the core module based on your analysis",
    "trackedFiles": ["src/core/**/*.ts"]
  }
]
```

## Debugging Configuration Issues

### Validation Command
Always validate before running:
```bash
bun run validate --config=my-phases.json
```

### Common Errors

1. **Missing Required Fields**
   ```
   Error: Phase "phase-1" is missing required field 'model'
   ```

2. **Invalid Continuation Mode**
   ```
   Warning: First phase has continuationMode "continue-previous"
   ```

3. **File Not Found**
   ```
   Error: promptFile "./prompts/missing.md" does not exist
   ```

4. **Invalid Glob Pattern**
   ```
   Warning: Pattern "src/**.ts" should be "src/**/*.ts"
   ```

### Configuration Debugging Tips

1. Start with a minimal configuration and add features incrementally
2. Test workspace setup commands in isolation first
3. Use the `--no-autostart` flag to manually control phase execution
4. Check `.tadpole/runs/<runId>/` for Claude's actual output
