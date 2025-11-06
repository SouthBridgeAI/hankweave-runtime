# Plan 1: Models.dev Data Download and Schema Implementation

## Global Intent
The Tadpole chronicler system needs to make real LLM calls to various providers (Anthropic, OpenAI, etc.) while tracking costs and managing provider availability. This plan creates the foundational data layer that contains model information, costs, and capabilities.

## Context & Why This Is Being Built
- **Current State**: Chroniclers use mock LLM calls and have no cost awareness
- **Goal**: Enable real LLM calls with cost tracking and provider management
- **This Plan's Role**: Create the data foundation that all other components will rely on for model information

## What's Done So Far
- Nothing yet - this is the first plan in the sequence

## Objective
Create a system to download model data from models.dev once, validate it against a schema, and store it in version control for use by the LLM provider system.

## Context
- Documentation for models.dev API is available at `/Users/hrishioa/Dropbox/Projects/Southbridge/tadpole/external-docs/models-dev.md`
- The data will be used by the LLM provider manager to provide cost information and model capabilities
- We'll download the data once and commit it to version control (no mock test files)

## Important Note
**The code examples below are suggestions**. Feel free to modify them as needed and add comments to explain your implementation decisions.

## Implementation Steps

### 1. Review models.dev Documentation
- Read the external documentation if needed to understand the API structure
- Identify the exact endpoints and data format provided by models.dev
- Note any authentication requirements or rate limits

### 2. Create the Data Schema (`server/llm/models-dev-schema.ts`)
Create an annotated Zod schema that represents the structure we need:

```typescript
import { z } from 'zod';

// Individual model cost schema
export const modelCostSchema = z.object({
  input: z.number().nonnegative(), // Cost per million input tokens
  output: z.number().nonnegative(), // Cost per million output tokens
});

// Model limits schema
export const modelLimitsSchema = z.object({
  context: z.number().positive().int(), // Max context tokens
  output: z.number().positive().int(), // Max output tokens
});

// Individual model schema
export const modelInfoSchema = z.object({
  providerId: z.string().min(1), // e.g., "anthropic", "openai"
  modelId: z.string().min(1), // e.g., "claude-3-5-sonnet-20241022"
  name: z.string().min(1), // Human-readable name
  cost: modelCostSchema,
  limits: modelLimitsSchema,
  // Optional fields that might be useful
  description: z.string().optional(),
  releaseDate: z.string().datetime().optional(),
  deprecated: z.boolean().optional(),
});

// Root data structure
export const modelsDataSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/), // Semver format
  lastUpdated: z.string().datetime(),
  models: z.array(modelInfoSchema),
});

// Type exports
export type ModelInfo = z.infer<typeof modelInfoSchema>;
export type ModelsData = z.infer<typeof modelsDataSchema>;
```

### 3. Create the Download Script (`scripts/fetch-models-dev.ts`)

```typescript
import { modelsDataSchema, type ModelsData } from '../server/llm/models-dev-schema';
import fs from 'fs/promises';
import path from 'path';

const MODELS_DEV_URL = 'https://models.dev/api/models'; // Check actual URL
const OUTPUT_PATH = path.join(process.cwd(), 'server/llm/models-dev-data.json');
const BACKUP_PATH = path.join(process.cwd(), 'server/llm/models-dev-data.backup.json');

async function fetchModelsData(): Promise<void> {
  console.log('Fetching models data from models.dev...');

  try {
    // Fetch the raw data
    const response = await fetch(MODELS_DEV_URL);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const rawData = await response.json();

    // Transform the data to our format
    // Note: This transformation will depend on the actual models.dev format
    const transformedData: ModelsData = {
      version: '1.0.0',
      lastUpdated: new Date().toISOString(),
      models: transformRawData(rawData), // Implement based on actual format
    };

    // Validate against schema
    const validatedData = modelsDataSchema.parse(transformedData);

    // Backup existing file if it exists
    try {
      const existingData = await fs.readFile(OUTPUT_PATH, 'utf-8');
      await fs.writeFile(BACKUP_PATH, existingData);
      console.log('Backed up existing data');
    } catch (error) {
      // No existing file, that's fine
    }

    // Write the new data
    await fs.writeFile(
      OUTPUT_PATH,
      JSON.stringify(validatedData, null, 2)
    );

    console.log(`Successfully wrote ${validatedData.models.length} models to ${OUTPUT_PATH}`);

    // Verify the written file can be loaded and validated
    const verification = await fs.readFile(OUTPUT_PATH, 'utf-8');
    const verifiedData = modelsDataSchema.parse(JSON.parse(verification));
    console.log('Verification successful');

  } catch (error) {
    console.error('Failed to fetch models data:', error);

    // Try to restore from backup
    try {
      const backupData = await fs.readFile(BACKUP_PATH, 'utf-8');
      await fs.writeFile(OUTPUT_PATH, backupData);
      console.log('Restored from backup');
    } catch (backupError) {
      console.error('No backup available');
    }

    process.exit(1);
  }
}

function transformRawData(raw: any): ModelInfo[] {
  // This function needs to be implemented based on the actual models.dev response
  // For now, a placeholder that shows the expected transformation

  // Example transformation (adjust based on actual API):
  if (Array.isArray(raw)) {
    return raw.map(model => ({
      providerId: model.provider || extractProvider(model.id),
      modelId: model.id,
      name: model.name || model.id,
      cost: {
        input: model.pricing?.input || 0,
        output: model.pricing?.output || 0,
      },
      limits: {
        context: model.contextWindow || 100000,
        output: model.maxOutput || 4096,
      },
      description: model.description,
      releaseDate: model.releaseDate,
      deprecated: model.deprecated || false,
    }));
  }

  // Handle other formats...
  throw new Error('Unexpected data format from models.dev');
}

function extractProvider(modelId: string): string {
  // Extract provider from model ID if not provided separately
  if (modelId.includes('claude')) return 'anthropic';
  if (modelId.includes('gpt')) return 'openai';
  if (modelId.includes('gemini')) return 'google';
  // Add more mappings as needed
  return 'unknown';
}

// Run if called directly
if (import.meta.main) {
  fetchModelsData();
}
```

### 4. Add Package.json Script
Add to `package.json`:
```json
{
  "scripts": {
    "fetch-models": "bun scripts/fetch-models-dev.ts"
  }
}
```

### 5. Download Real Data

Run the script to download actual data from models.dev:

```bash
bun run fetch-models
```

**Important**: If the download fails, do NOT proceed with dummy data. Instead:
1. Check the models.dev API documentation
2. Verify the endpoint is correct
3. Check if authentication is needed
4. If the API is not available, pause and reassess the approach

The system should fail gracefully if models data is unavailable, not proceed with incomplete information.

## Testing Requirements

### Unit Tests (`tests/unit/models-dev-schema.test.ts`)
```typescript
import { describe, it, expect } from 'bun:test';
import { modelsDataSchema } from '../../server/llm/models-dev-schema';

describe('Models Dev Schema', () => {
  it('should validate correct data', () => {
    const validData = {
      version: '1.0.0',
      lastUpdated: new Date().toISOString(),
      models: [
        {
          providerId: 'anthropic',
          modelId: 'claude-3-5-sonnet',
          name: 'Claude 3.5 Sonnet',
          cost: { input: 3.0, output: 15.0 },
          limits: { context: 200000, output: 8192 }
        }
      ]
    };

    expect(() => modelsDataSchema.parse(validData)).not.toThrow();
  });

  it('should reject invalid version format', () => {
    const invalidData = {
      version: 'v1', // Invalid format
      lastUpdated: new Date().toISOString(),
      models: []
    };

    expect(() => modelsDataSchema.parse(invalidData)).toThrow();
  });

  it('should reject negative costs', () => {
    const invalidData = {
      version: '1.0.0',
      lastUpdated: new Date().toISOString(),
      models: [
        {
          providerId: 'test',
          modelId: 'test',
          name: 'Test',
          cost: { input: -1, output: 5 }, // Negative input cost
          limits: { context: 1000, output: 100 }
        }
      ]
    };

    expect(() => modelsDataSchema.parse(invalidData)).toThrow();
  });
});
```

Note: We're not creating mock test files. The actual downloaded data file will be used for all testing.

## Potential Issues & Solutions

### Issue 1: models.dev API Changes
**Problem**: The API format might change, breaking our parser.
**Solution**:
- Keep the transformation logic isolated and well-tested
- Version the schema so we can handle multiple formats
- Keep backups of working data files

### Issue 2: Network Failures
**Problem**: Script fails due to network issues.
**Solution**:
- Implement retry logic with exponential backoff
- Always backup existing data before attempting update
- Provide option to restore from backup

### Issue 3: Large Data Size
**Problem**: models.dev might return thousands of models.
**Solution**:
- Filter to only providers we support (anthropic, openai, google, groq)
- Add option to fetch only specific providers
- Consider pagination if API supports it

### Issue 4: Schema Drift
**Problem**: Our schema might become out of sync with what we need.
**Solution**:
- Start with minimal required fields
- Make most fields optional initially
- Add fields as needed rather than trying to capture everything

## Validation Steps

After implementation, run:
```bash
# Validate TypeScript types
bun typecheck

# Fix any linting issues
bun lint:fix

# Run the fetch script
bun fetch-models

# Verify the output file is valid JSON and matches schema
cat server/llm/models-dev-data.json | jq .

# Run tests
bun test tests/unit/models-dev-schema.test.ts
```

## Integration Points

### Files Created/Modified:
- `server/llm/models-dev-schema.ts` - Zod schema definition
- `server/llm/models-dev-data.json` - Data file (in version control)
- `scripts/fetch-models-dev.ts` - Download script
- `package.json` - Add fetch-models script

### Next Steps:
- This data file will be imported by the LLM Provider Manager (Plan 2)
- The schema types will be used throughout the LLM provider system
- The script should be run periodically (weekly?) to update model data

## Success Criteria
1. Schema validates the data structure correctly
2. Script successfully downloads real data from models.dev (or fails clearly if unavailable)
3. Data file is valid JSON and passes schema validation
4. Backup/restore mechanism works
5. All tests pass
6. TypeScript compilation succeeds
7. System fails gracefully if models.dev is unavailable (no dummy data)

## Note for Implementation
This plan is designed to be implemented by an AI agent with human supervision. The human will check the results after implementation.
