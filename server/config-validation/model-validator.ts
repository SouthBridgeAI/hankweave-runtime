import type { ModelInfo } from "../llm/index.js";
import { PI_HARNESS } from "../provider-ids.js";

/**
 * Model spellings are validated by the model module (server/llm, spec 72):
 * `Models.current().check(spelling, use)`. What remains here is the
 * migration of model records persisted by earlier versions.
 */

/**
 * Normalize a ModelInfo persisted by a pre-upgrade execution. Continuation
 * runs restore the executionPlan verbatim without re-running model validation,
 * so retired encodings must be migrated here:
 *
 * - The retired "pi" pseudo-provider encoding (providerId "pi", modelId
 *   "<provider>/<model>") and the removed opencode shim's (providerId
 *   "opencode", modelId "<provider>/<model>") map to the real provider by
 *   splitting on the first slash. Legacy entries are treated as
 *   routing-derived, not user-forced, so no harnessOverride is set — a legacy
 *   plan that explicitly forced an Anthropic model onto pi re-routes to the
 *   Agent SDK on resume (release-noted). "openrouter/…" modelIds map to
 *   provider "openrouter" verbatim.
 * - A bare id under either encoding keeps its raw shape: nothing infers a
 *   provider any more. Under "opencode" it now runs on Pi's OpenCode Zen
 *   provider; under "pi" no harness runs it and dispatch says so.
 *
 * Already-normalized entries are returned unchanged. Because harness selection
 * is computed at dispatch from the real provider id, no future routing change
 * requires another migration here.
 */
export function normalizeLegacyProviderModelInfo(modelInfo: ModelInfo): ModelInfo {
  // Persisted state from earlier versions, which matched these
  // case-insensitively and stored the split provider lowercased.
  const provider = modelInfo.providerId.toLowerCase();
  if (provider !== PI_HARNESS && provider !== "opencode") return modelInfo;
  // A record this version wrote carries harness evidence: "opencode" is then
  // Pi's OpenCode Zen provider, not the removed shim's encoding.
  if (modelInfo.provenance?.evidence !== undefined) return modelInfo;
  const raw = modelInfo.modelId;
  const slash = raw.indexOf("/");
  if (slash <= 0) return modelInfo;
  return {
    ...modelInfo,
    providerId: raw.substring(0, slash).toLowerCase(),
    modelId: raw.substring(slash + 1),
    name: raw,
  };
}
