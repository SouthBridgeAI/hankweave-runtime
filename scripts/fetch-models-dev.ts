import fs from "node:fs/promises";
import path from "node:path";
import {
  type ModelInfo,
  type ModelsData,
  type ModelsDevApiResponse,
  modelsDataSchema,
  modelsDevApiResponseSchema,
  type ProviderInfo,
} from "../server/llm/models-dev-schema";

const MODELS_DEV_URL = "https://models.dev/api.json";
const OUTPUT_PATH = path.join(process.cwd(), "server/llm/models-dev-data.json");
const BACKUP_PATH = path.join(process.cwd(), "server/llm/models-dev-data.backup.json");

// Remove the filter - we'll keep all providers in the data for fun!
// Only providers with SDK support will actually be used at runtime
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, retries = MAX_RETRIES): Promise<Response> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`Attempt ${attempt}/${retries}: Fetching ${url}`);
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status} ${response.statusText}`);
      }

      return response;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(`Attempt ${attempt} failed:`, errorMessage);

      if (attempt === retries) {
        throw error;
      }

      // Exponential backoff
      const delay = RETRY_DELAY * 2 ** (attempt - 1);
      console.log(`Retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }

  throw new Error("All retry attempts failed");
}

function transformRawData(apiResponse: ModelsDevApiResponse): ProviderInfo[] {
  const providers: ProviderInfo[] = [];

  for (const [providerId, providerData] of Object.entries(apiResponse)) {
    // No longer filtering providers - keep them all for fun!
    console.log(`Processing provider: ${providerId}`);

    const models: ModelInfo[] = [];

    for (const [modelId, modelData] of Object.entries(providerData.models)) {
      try {
        // Skip models with invalid limits (0 or negative values)
        if (modelData.limit.context <= 0 || modelData.limit.output <= 0) {
          console.warn(
            `Skipping ${providerId}/${modelId}: Invalid limits (context: ${modelData.limit.context}, output: ${modelData.limit.output})`,
          );
          continue;
        }

        const transformedModel: ModelInfo = {
          providerId,
          modelId,
          name: modelData.name,
          attachment: modelData.attachment,
          reasoning: modelData.reasoning,
          tool_call: modelData.tool_call,
          temperature: modelData.temperature,
          cost: modelData.cost || undefined,
          limit: {
            context: modelData.limit.context,
            output: modelData.limit.output,
          },
          modalities: {
            input: modelData.modalities.input,
            output: modelData.modalities.output,
          },
          knowledge: modelData.knowledge,
          release_date: modelData.release_date,
          last_updated: modelData.last_updated,
        };

        models.push(transformedModel);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.warn(`Failed to transform model ${providerId}/${modelId}:`, errorMessage);
        // Skip this model but continue with others
      }
    }

    if (models.length > 0) {
      providers.push({
        id: providerId,
        name: providerData.name,
        models,
      });
    }
  }

  return providers;
}

async function backupExistingData(): Promise<void> {
  try {
    await fs.access(OUTPUT_PATH);
    const existingData = await fs.readFile(OUTPUT_PATH, "utf-8");
    await fs.writeFile(BACKUP_PATH, existingData);
    console.log("✓ Backed up existing data");
  } catch (error) {
    // No existing file or backup failed - not critical
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn("Warning: Failed to backup existing data:", errorMessage);
    }
  }
}

async function restoreFromBackup(): Promise<void> {
  try {
    const backupData = await fs.readFile(BACKUP_PATH, "utf-8");
    await fs.writeFile(OUTPUT_PATH, backupData);
    console.log("✓ Restored from backup");
  } catch (error) {
    console.error("✗ No backup available or restore failed");
    throw error;
  }
}

async function ensureDirectoryExists(): Promise<void> {
  const dir = path.dirname(OUTPUT_PATH);
  await fs.mkdir(dir, { recursive: true });
}

async function fetchModelsData(): Promise<void> {
  console.log("🚀 Starting models.dev data fetch...");
  console.log(`API URL: ${MODELS_DEV_URL}`);
  console.log(`Output: ${OUTPUT_PATH}`);
  console.log("Fetching ALL providers (no filter applied)");
  console.log();

  try {
    // Ensure output directory exists
    await ensureDirectoryExists();

    // Backup existing data before making changes
    await backupExistingData();

    // Fetch the raw data with retry logic
    const response = await fetchWithRetry(MODELS_DEV_URL);
    const rawData = await response.json();

    console.log("✓ Successfully fetched raw data from models.dev");

    // Validate the raw API response structure
    console.log("📋 Validating API response structure...");
    const validatedApiResponse = modelsDevApiResponseSchema.parse(rawData);
    console.log("✓ API response structure is valid");

    // Transform the data to our internal format
    console.log("🔄 Transforming data to internal format...");
    const providers = transformRawData(validatedApiResponse);

    const transformedData: ModelsData = {
      version: "1.0.0",
      lastUpdated: new Date().toISOString(),
      providers,
    };

    // Validate our transformed data against our schema
    console.log("📋 Validating transformed data...");
    const validatedData = modelsDataSchema.parse(transformedData);
    console.log("✓ Transformed data is valid");

    // Write the new data
    console.log("💾 Writing data to file...");
    await fs.writeFile(OUTPUT_PATH, JSON.stringify(validatedData, null, 2));

    // Verify the written file can be loaded and validated
    console.log("🔍 Verifying written file...");
    const verification = await fs.readFile(OUTPUT_PATH, "utf-8");
    const verifiedData = modelsDataSchema.parse(JSON.parse(verification));

    // Success summary
    const totalModels = verifiedData.providers.reduce(
      (sum, provider) => sum + provider.models.length,
      0,
    );
    console.log();
    console.log("🎉 Success!");
    console.log(`📊 Downloaded data for ${verifiedData.providers.length} providers`);
    console.log(`🤖 Total models: ${totalModels}`);
    console.log(`📁 Saved to: ${OUTPUT_PATH}`);

    // Show provider summary
    console.log("\n📋 Provider Summary:");
    for (const provider of verifiedData.providers) {
      console.log(`  • ${provider.name}: ${provider.models.length} models`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("\n❌ Failed to fetch models data:", errorMessage);

    if (error instanceof Error && error.name === "ZodError") {
      console.error("\n🔍 Validation errors:");
      const zodError = error as unknown as {
        errors: Array<{ path: Array<string | number>; message: string }>;
      };
      zodError.errors.forEach((err, index) => {
        console.error(`  ${index + 1}. Path: ${err.path.join(".")} - ${err.message}`);
      });
    }

    // Try to restore from backup
    console.log("\n🔄 Attempting to restore from backup...");
    try {
      await restoreFromBackup();
    } catch {
      console.error("Backup restoration also failed");
    }

    process.exit(1);
  }
}

// Add command line help
function showHelp() {
  console.log(`
📚 Models.dev Data Fetcher

Usage:
  bun scripts/fetch-models-dev.ts [--help]

This script fetches model data from models.dev API and saves it as JSON.

Options:
  --help    Show this help message

Files:
  Output:  ${OUTPUT_PATH}
  Backup:  ${BACKUP_PATH}

Note: This script fetches ALL providers from models.dev.
      Only providers with SDK support will be usable at runtime.
`);
}

// Handle command line arguments
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  showHelp();
  process.exit(0);
}

// Run if called directly
if (import.meta.main) {
  fetchModelsData().catch((error) => {
    console.error("Unhandled error:", error);
    process.exit(1);
  });
}

export { fetchModelsData };
