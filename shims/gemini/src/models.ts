export function formatGeminiOutputModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return "google/gemini-2.5-flash";
  }
  return trimmed.includes("/") ? trimmed : `google/${trimmed}`;
}

export function normalizeModelForGeminiCli(model: string): {
  requested: string;
  outputModel: string;
  geminiModel: string;
} {
  const trimmed = model.trim();
  if (!trimmed) {
    return {
      requested: "gemini-2.5-flash",
      outputModel: "google/gemini-2.5-flash",
      geminiModel: "gemini-2.5-flash",
    };
  }

  const short = trimmed.toLowerCase();
  if (short === "flash") {
    return {
      requested: trimmed,
      outputModel: "google/gemini-2.5-flash",
      geminiModel: "gemini-2.5-flash",
    };
  }
  if (short === "pro") {
    return {
      requested: trimmed,
      outputModel: "google/gemini-2.5-pro",
      geminiModel: "gemini-2.5-pro",
    };
  }
  if (trimmed.includes("/")) {
    const [, rest] = trimmed.split(/\/(.*)/s, 2);
    const geminiModel = rest || trimmed;
    return {
      requested: trimmed,
      outputModel: formatGeminiOutputModel(trimmed),
      geminiModel,
    };
  }
  return {
    requested: trimmed,
    outputModel: formatGeminiOutputModel(trimmed),
    geminiModel: trimmed,
  };
}

export function getApiKeySource(): string {
  if (
    process.env.GOOGLE_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_GENAI_USE_VERTEXAI === "true" ||
    process.env.GOOGLE_GENAI_USE_GCA === "true"
  ) {
    return "env";
  }
  return "none";
}
