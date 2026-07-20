import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface ProviderCredentialStatus {
  available: boolean;
  apiKeySource: string;
  envVars: readonly string[];
}

interface ProviderCredentialConfig {
  envVars: readonly string[];
  apiKeySource: string;
  runtimeProvider: string;
}

const PROVIDER_CREDENTIALS: Record<string, ProviderCredentialConfig> = {
  anthropic: {
    envVars: ["ANTHROPIC_API_KEY"],
    apiKeySource: "ANTHROPIC_API_KEY",
    runtimeProvider: "anthropic",
  },
  google: {
    envVars: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
    apiKeySource: "env",
    runtimeProvider: "google",
  },
  openai: {
    envVars: ["OPENAI_API_KEY"],
    apiKeySource: "env",
    runtimeProvider: "openai",
  },
  openrouter: {
    envVars: ["OPENROUTER_API_KEY"],
    apiKeySource: "env",
    runtimeProvider: "openrouter",
  },
  zai: {
    envVars: ["ZAI_API_KEY"],
    apiKeySource: "env",
    runtimeProvider: "zai",
  },
};

function getConfiguredEnvValue(envVars: readonly string[]): string | undefined {
  for (const envVar of envVars) {
    const value = process.env[envVar]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function hasConfiguredEnvValue(envVars: readonly string[]): boolean {
  return getConfiguredEnvValue(envVars) !== undefined;
}

export async function configureModelRuntime(): Promise<ModelRuntime> {
  // pi 0.80.8 replaced the synchronous AuthStorage/ModelRegistry pair with the
  // async ModelRuntime facade. Runtime API keys are an in-memory overlay on top
  // of the runtime's credential store, so env-provided keys take precedence over
  // anything on disk while still letting pi's dynamic provider catalogs refresh.
  const modelRuntime = await ModelRuntime.create();

  for (const config of Object.values(PROVIDER_CREDENTIALS)) {
    const value = getConfiguredEnvValue(config.envVars);
    if (value) {
      await modelRuntime.setRuntimeApiKey(config.runtimeProvider, value);
    }
  }

  return modelRuntime;
}

export function getKnownApiKeyStatus(): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(PROVIDER_CREDENTIALS).map(([provider, config]) => [
      provider,
      hasConfiguredEnvValue(config.envVars),
    ]),
  );
}

export function getProviderCredentialStatus(provider: string): ProviderCredentialStatus {
  const normalizedProvider = provider.toLowerCase();
  const config = PROVIDER_CREDENTIALS[normalizedProvider];

  if (!config) {
    const hasAnyKnownKey = Object.values(PROVIDER_CREDENTIALS).some((entry) =>
      hasConfiguredEnvValue(entry.envVars),
    );

    return {
      available: true,
      apiKeySource: hasAnyKnownKey ? "env" : "none",
      envVars: [],
    };
  }

  const available = hasConfiguredEnvValue(config.envVars);
  return {
    available,
    apiKeySource: available ? config.apiKeySource : "none",
    envVars: config.envVars,
  };
}

export function shouldEnforceProviderCredential(provider: string): boolean {
  return provider.toLowerCase() in PROVIDER_CREDENTIALS;
}

export function formatMissingApiKeyMessage(provider: string): string {
  const status = getProviderCredentialStatus(provider);
  if (status.envVars.length === 0) {
    return `Missing API key for provider '${provider}'.`;
  }

  return `Missing API key for provider '${provider}'. Set ${status.envVars.join(" or ")}.`;
}
