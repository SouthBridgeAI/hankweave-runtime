export const PASSTHROUGH_SHIM_PROVIDER_IDS = ["pi"] as const;

export const SUPPORTED_CODON_PROVIDER_IDS = ["anthropic", "pi"] as const;

const passthroughShimProviderSet = new Set<string>(PASSTHROUGH_SHIM_PROVIDER_IDS);
const supportedCodonProviderSet = new Set<string>(SUPPORTED_CODON_PROVIDER_IDS);

export function isPassthroughShimProvider(providerId: string): boolean {
  return passthroughShimProviderSet.has(providerId.toLowerCase());
}

export function isSupportedCodonProvider(providerId: string): boolean {
  return supportedCodonProviderSet.has(providerId.toLowerCase());
}

export function getSupportedCodonProviderIds(): string[] {
  return [...SUPPORTED_CODON_PROVIDER_IDS];
}
