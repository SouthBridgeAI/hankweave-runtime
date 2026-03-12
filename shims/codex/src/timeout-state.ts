import type { ThreadEvent } from "@openai/codex-sdk";
import type { AdaptiveTimeoutController } from "@shims/common/timeout";
import { shouldTreatAsToolItem } from "./tools.js";

/**
 * Codex emits `turn.started` quickly and may then stay silent until the first
 * completed item arrives. For normal timeout values, that quiet period should
 * be treated as an in-progress turn rather than pre-work silence.
 *
 * We keep a narrow exception for ultra-short 1s timeouts so the baseline
 * pre-work timeout eval can still exercise the idle path for this sparse
 * protocol.
 */
export function shouldTreatTurnStartAsBusy(idleTimeoutMs: number): boolean {
  return idleTimeoutMs > 1_000;
}

export function updateCodexTimeoutState(
  event: ThreadEvent,
  controller: AdaptiveTimeoutController,
  idleTimeoutMs: number,
): void {
  const turnBusy = shouldTreatTurnStartAsBusy(idleTimeoutMs);

  switch (event.type) {
    case "turn.started": {
      if (turnBusy) {
        controller.markBusy();
      }
      return;
    }

    case "item.started":
    case "item.updated":
    case "item.completed": {
      if (turnBusy || shouldTreatAsToolItem(event.item)) {
        controller.markBusy();
      }
      return;
    }

    case "turn.completed":
    case "turn.failed": {
      controller.markIdle();
      return;
    }

    default:
      return;
  }
}
