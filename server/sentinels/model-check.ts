import type { HarnessCheckOptions, HarnessCheckResult, HarnessModelCheck } from "../llm/index.js";
import { isProbeableProvider, type ProbeOutcome, probeModel } from "../provider-probe.js";
import { PROVIDER_DEFINITIONS } from "./provider-config.js";

type CheckFailure = Extract<HarnessCheckResult, { ok: false }>;

function failure(kind: CheckFailure["kind"], message: string): CheckFailure {
  return { ok: false, kind, message, candidates: [] };
}

/**
 * The key a sentinel for this provider would call with (its
 * HANKWEAVE_SENTINEL_ override first; undefined on ambient credentials), or
 * the failure when the AI SDK has no client or no credentials for it.
 */
function sentinelCredentials(
  provider: string,
  processEnv: NodeJS.ProcessEnv,
): { ok: true; key: string | undefined } | CheckFailure {
  const def = PROVIDER_DEFINITIONS.find((d) => d.id === provider);
  if (!def)
    return failure("no-credentials", `The AI SDK has no client for provider '${provider}'.`);
  const sentinelVar = `HANKWEAVE_SENTINEL_${def.apiKeyEnvVar}`;
  const key = processEnv[sentinelVar] || processEnv[def.apiKeyEnvVar];
  if (key || def.detectAmbientCredentials?.()) return { ok: true, key };
  const ambient = def.detectAmbientCredentials ? ", and ambient detection" : "";
  return failure(
    "no-credentials",
    `No credentials for sentinel provider '${provider}' (checked ${sentinelVar}, ${def.apiKeyEnvVar}` +
      `${ambient}).`,
  );
}

/** The check's answer from the provider's model list. */
function fromProbe(outcome: ProbeOutcome, provider: string, target: string): HarnessCheckResult {
  if (outcome.status === "found") {
    return {
      ok: true,
      evidence: outcome.record.source,
      probe: outcome.record,
      row: { name: outcome.record.name, limit: outcome.record.limit },
    };
  }
  return outcome.status === "absent"
    ? failure("unknown-model", `${provider}'s API does not list '${target}' (${outcome.source}).`)
    : failure(
        "unreachable",
        `Could not check '${target}' with ${provider}'s model list: ${outcome.reason}.`,
      );
}

/**
 * Sentinels run on the AI SDK (spec 72): a check of the same shape as the
 * codon harnesses' but its own list, never offered a codon model. It runs
 * the providers it has a client for (PROVIDER_DEFINITIONS). Evidence: the
 * catalog lists the id; on a miss, the provider's model list when a key
 * exists. A sentinel that fails this check is skipped at runtime, as one
 * whose provider is unavailable always was; only a wrongly written name is a
 * config error.
 */
export class AiSdkModelCheck implements HarnessModelCheck {
  readonly harness = "ai-sdk";
  readonly label = "the AI SDK";

  providers(): readonly string[] {
    return PROVIDER_DEFINITIONS.map((def) => def.id);
  }

  runs(provider: string): boolean {
    return PROVIDER_DEFINITIONS.some((def) => def.id === provider);
  }

  async check(
    provider: string,
    modelId: string,
    _env: NodeJS.ProcessEnv,
    opts: HarnessCheckOptions,
  ): Promise<HarnessCheckResult> {
    // Sentinels read keys from the process environment at runtime
    // (ProviderHealth), not the codons' HANKWEAVE_ pass-through, so that is
    // the environment checked here.
    const processEnv = process.env;
    const credentials = sentinelCredentials(provider, processEnv);
    if (!credentials.ok) return credentials;
    const { key } = credentials;
    const target = `${provider}/${modelId}`;
    if (opts.knownToCatalog(provider, modelId)) return { ok: true, evidence: "catalog" };
    if (!opts.network || !isProbeableProvider(provider) || !key) {
      return failure("unknown-model", `The model catalog does not list '${target}'.`);
    }
    // The key the sentinel would call with (its HANKWEAVE_SENTINEL_ override first).
    const outcome = await probeModel(provider, modelId, key, {
      env: processEnv,
      timeoutMs: opts.timeoutMs,
    });
    return fromProbe(outcome, provider, target);
  }
}
