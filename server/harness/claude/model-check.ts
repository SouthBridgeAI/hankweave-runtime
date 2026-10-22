import { claudeHarnessSteps } from "../../claude-agent-sdk-manager.js";
import type {
  HarnessCheckOptions,
  HarnessCheckResult,
  HarnessCheckStep,
  HarnessModelCheck,
} from "../../llm/index.js";
import {
  AMAZON_BEDROCK_PROVIDER_ID,
  CLAUDE_AGENT_SDK_HARNESS,
  runsOnClaudeAgentSdk,
} from "../../provider-ids.js";
import { probeApiKey, probeModel } from "../../provider-probe.js";

/**
 * The Claude Agent SDK's answer to "can you run provider/model here?" (spec
 * 72, stage 2). Claude Code has no local catalog — it sends any id and the
 * API decides — so the evidence is chosen by the execution provider, never
 * by which keys happen to exist:
 * - anthropic: hankweave's catalog lists the id (no network, like the
 *   self-test always was); on a miss only, with an API key or base URL, the
 *   Anthropic model list (`GET /v1/models/<id>`, cached 30 days).
 * - amazon-bedrock: the catalog's Bedrock rows only; never Anthropic's API.
 * First of all, the SDK's prerequisites: SDK present, CLI found, credentials.
 */
export class ClaudeModelCheck implements HarnessModelCheck {
  readonly harness = CLAUDE_AGENT_SDK_HARNESS;
  readonly label = "the Claude Agent SDK";
  private version = "unknown";

  providers(): readonly string[] {
    return ["anthropic", AMAZON_BEDROCK_PROVIDER_ID];
  }

  runs(provider: string, modelId: string): boolean {
    return runsOnClaudeAgentSdk(provider, modelId);
  }

  async check(
    provider: string,
    modelId: string,
    env: NodeJS.ProcessEnv,
    opts: HarnessCheckOptions,
  ): Promise<HarnessCheckResult> {
    const bedrock = provider === AMAZON_BEDROCK_PROVIDER_ID;
    const { steps, sdkVersion } = await claudeHarnessSteps({ bedrock, env });
    this.version = sdkVersion;
    const failed = steps.find((step) => !step.passed);
    if (failed) {
      return failed.name === "authentication"
        ? { ok: false, kind: "no-credentials", message: failed.message, candidates: [], steps }
        : {
            ok: false,
            kind: "harness-unavailable",
            message: `The Claude Agent SDK's CLI could not be found or started: ${failed.message}`,
            candidates: [],
            steps,
          };
    }
    const target = `${provider}/${modelId}`;
    if (opts.knownToCatalog(provider, modelId)) {
      return { ok: true, evidence: "catalog", steps: [...steps, catalogStep(target, true)] };
    }
    if (bedrock) {
      return {
        ok: false,
        kind: "unknown-model",
        message:
          `The model catalog does not list '${target}', and Bedrock's model list cannot be asked ` +
          "(hankweave does not sign AWS requests). Use a listed Bedrock id, or declare it in a 'models' block.",
        candidates: [],
        steps: [...steps, catalogStep(target, false)],
      };
    }
    return this.askAnthropic(target, modelId, env, opts, steps);
  }

  /** A catalog miss on the anthropic route: ask Anthropic's model list when a key or base URL allows it. */
  private async askAnthropic(
    target: string,
    modelId: string,
    env: NodeJS.ProcessEnv,
    opts: HarnessCheckOptions,
    steps: HarnessCheckStep[],
  ): Promise<HarnessCheckResult> {
    const key = probeApiKey("anthropic", env);
    // The model list needs a key; a gateway behind ANTHROPIC_BASE_URL without
    // one is declared in a 'models' block instead.
    if (!key) {
      return unknown(
        `Could not ask Anthropic about '${target}' (no ANTHROPIC_API_KEY; the Claude login cannot list models) ` +
          "and the model catalog does not list it.",
        steps,
      );
    }
    if (!opts.network) {
      return unknown(
        `The model catalog does not list '${target}', and online model checks are off, so Anthropic's model list was not asked.`,
        steps,
      );
    }
    const outcome = await probeModel("anthropic", modelId, key ?? "", {
      env,
      timeoutMs: opts.timeoutMs,
    });
    switch (outcome.status) {
      case "found":
        return {
          ok: true,
          evidence: "anthropic GET /v1/models",
          probe: outcome.record,
          row: { name: outcome.record.name, limit: outcome.record.limit },
          steps: [
            ...steps,
            {
              name: "model_catalog",
              passed: true,
              message: `${outcome.record.source} lists '${target}'`,
            },
          ],
        };
      case "absent":
        return unknown(`Anthropic's API does not list '${target}' (${outcome.source}).`, steps);
      default:
        return {
          ok: false,
          kind: "unreachable",
          message:
            `Could not check '${target}' with Anthropic's model list: ${outcome.reason}. ` +
            "A gateway behind ANTHROPIC_BASE_URL that does not serve /v1/models can declare the id in a 'models' block; " +
            "or run with noOnlineModelChecks to validate from cached catalogs only.",
          candidates: [],
          steps,
        };
    }
  }

  // fallow-ignore-next-line unused-class-member -- called through HarnessModelCheck
  info() {
    return {
      shim: { name: "claude-agent-sdk-manager", version: this.version },
      agent: { name: "claude-agent-sdk", version: this.version },
    };
  }
}

function catalogStep(target: string, passed: boolean): HarnessCheckStep {
  return {
    name: "model_catalog",
    passed,
    message: passed
      ? `The model catalog lists '${target}'`
      : `The model catalog does not list '${target}'`,
  };
}

function unknown(message: string, steps: HarnessCheckStep[]): HarnessCheckResult {
  return {
    ok: false,
    kind: "unknown-model",
    message,
    candidates: [],
    steps: [...steps, { name: "model_catalog", passed: false, message }],
  };
}
