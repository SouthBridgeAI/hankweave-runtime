const SHORTNAME_MAP: Record<string, string> = {
  sonnet: "anthropic/claude-sonnet-4-20250514",
  haiku: "anthropic/claude-3-haiku-20240307",
  opus: "anthropic/claude-opus-4-20250514",
  flash: "google/gemini-2.5-flash",
  pro: "google/gemini-2.5-pro",
  gpt5: "openai/gpt-5",
};

export function resolveModel(input: string): string {
  const raw = input.trim();
  if (!raw) {
    return process.env.MODEL?.trim() || "anthropic/claude-sonnet-4-20250514";
  }

  const lowered = raw.toLowerCase();
  if (SHORTNAME_MAP[lowered]) {
    return SHORTNAME_MAP[lowered];
  }

  if (raw.includes("/")) {
    return raw;
  }

  if (
    lowered.startsWith("claude") ||
    lowered.includes("sonnet") ||
    lowered.includes("haiku") ||
    lowered.includes("opus")
  ) {
    return `anthropic/${raw}`;
  }

  if (lowered.startsWith("gemini") || lowered.includes("flash") || lowered.includes("gemini-")) {
    return `google/${raw}`;
  }

  if (
    lowered.startsWith("gpt") ||
    lowered.startsWith("o1") ||
    lowered.startsWith("o3") ||
    lowered.startsWith("o4")
  ) {
    return `openai/${raw}`;
  }

  return raw;
}

export function providerFromModel(model: string): string | undefined {
  const [provider] = model.split("/", 1);
  return provider && model.includes("/") ? provider : undefined;
}

export function detectApiKeySource(model: string): string {
  const provider = providerFromModel(model);

  const providerEnv =
    provider === "anthropic"
      ? "ANTHROPIC_API_KEY"
      : provider === "google"
        ? "GOOGLE_API_KEY"
        : provider === "openai"
          ? "OPENAI_API_KEY"
          : provider === "groq"
            ? "GROQ_API_KEY"
            : provider === "cerebras"
              ? "CEREBRAS_API_KEY"
              : undefined;

  if (providerEnv && process.env[providerEnv]) {
    return providerEnv;
  }

  if (
    process.env.ANTHROPIC_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.GROQ_API_KEY ||
    process.env.CEREBRAS_API_KEY
  ) {
    return "env";
  }

  return "none";
}

export function supportsGeminiEmptyRetry(model: string): boolean {
  return model.startsWith("google/gemini");
}
