import { computeRetryDelayMs, resolveFailureAction } from "./error-classification.js";
import type { Codon, FailureReason } from "./types/types.js";

/**
 * What the runtime should do after a codon failure. A discriminated union so
 * the retry-only numbers are reachable exactly when they are meaningful.
 */
export type RetryDecision =
  | {
      action: "retry";
      /** 1-based number of the retry about to be made. */
      attempt: number;
      maxAttempts: number;
      /**
       * Sleep this long from the moment the decision is returned, THEN launch
       * attempt `attempt`. Not a pacing hint for anything after that launch —
       * if the attempt fails too, decide() issues a fresh decision with its
       * own delay. Already backed off and clamped; honors a provider
       * Retry-After.
       */
      delayBeforeThisAttemptMs: number;
    }
  | { action: "shutdown" | "stay-active" | "continue" };

/**
 * Owns per-codon retry bookkeeping and the failure-policy decision.
 *
 * Decides *whether and when*; the runtime performs the effects (emitting
 * events, sleeping, respawning the codon). Retry deliberately does NOT live in
 * CodonRunner — a runner's lifetime is a single attempt, and a retry is a
 * respawn that needs the orchestrator's rig-setup, checkpoint and state
 * machinery.
 *
 * Counters are in-memory and per-run: a server restart mid-retry loses them,
 * matching the documented retryConfig behaviour.
 */
export class RetryCoordinator {
  private readonly attempts = new Map<string, number>();

  /**
   * @param log Where policy decisions are narrated. Injected rather than taking
   *   a Logger so the coordinator stays trivially testable.
   */
  constructor(private readonly log: (message: string) => void = () => {}) {}

  /**
   * Resolve the failure policy for a codon, including retry pacing.
   *
   * Pure with respect to this coordinator's state — call recordAttempt() when
   * the retry is actually taken. Splitting the two keeps a decision that the
   * caller abandons (e.g. because shutdown started during the delay) from
   * silently consuming an attempt.
   */
  decide(codonId: string, codon: Codon, failureReason: FailureReason | undefined): RetryDecision {
    const onFailure = codon.onFailure || "abort";
    const retriable = failureReason?.retriable === true;
    const attempts = this.getAttempts(codonId);
    const maxAttempts = codon.retryConfig?.maxAttempts ?? 3;

    this.log(
      `Resolving failure policy for codon ${codonId}: onFailure=${onFailure}, retriable=${retriable}`,
    );

    const action = resolveFailureAction({ onFailure, retriable, attempts, maxAttempts });

    if (action === "retry") {
      // resolveFailureAction only returns "retry" while attempts < maxAttempts,
      // so no separate budget check is needed here.
      return {
        action,
        attempt: attempts + 1,
        maxAttempts,
        delayBeforeThisAttemptMs: computeRetryDelayMs({
          baseDelayMs: codon.retryConfig?.delayMs ?? 1000,
          attempts,
          retryAfterMs: failureReason?.retryAfterMs,
          maxDelayMs: codon.retryConfig?.maxDelayMs,
        }),
      };
    }

    if (action === "shutdown" && onFailure === "retry") {
      this.log(
        retriable
          ? `Codon ${codonId} exhausted ${maxAttempts} retry attempts, aborting`
          : `Codon ${codonId} has onFailure=retry but error is not retriable (${
              failureReason?.message || failureReason?.type || "no failure reason"
            }), falling back to abort`,
      );
    } else if (action === "continue") {
      this.log(`Ignoring failure for codon ${codonId} due to onFailure: 'ignore' configuration`);
    }

    return { action };
  }

  /** Consume one attempt. Call when the retry is actually being taken. */
  recordAttempt(codonId: string): void {
    this.attempts.set(codonId, this.getAttempts(codonId) + 1);
  }

  /**
   * Forget a codon's attempts. Called when it reaches a terminal non-failed
   * state, so a later re-entry (a loop iteration, a manual restart) starts from
   * a full budget rather than inheriting a spent one.
   */
  reset(codonId: string): void {
    this.attempts.delete(codonId);
  }

  /** Retries already made for this codon (0 if none). */
  getAttempts(codonId: string): number {
    return this.attempts.get(codonId) ?? 0;
  }
}
