/**
 * Tests for Codex ErrorItem handling.
 *
 * The Codex SDK documents ErrorItem as "non-fatal error surfaced as an item".
 * Fatal errors arrive via ThreadErrorEvent / TurnFailedEvent, not as items.
 * The shim must therefore treat ALL ErrorItems as non-fatal (log and continue).
 *
 * Bug (prior behaviour): the shim unconditionally threw for item.type === "error",
 * turning startup warnings (e.g. unstable-feature notices) into fatal crashes.
 *
 * Evidence: execution dir 1773634172699-4jyt-eb469b/, codon "surface-prd-gaps":
 *   item.completed → {type:"error", message:"Under-development features enabled: js_repl..."}
 *   result         → {status:"error", ...}  (zero tokens, no work done)
 */
import { describe, expect, test } from "bun:test";
import type { ThreadEvent } from "@openai/codex-sdk";
import { CodexShim } from "../src/shim.js";

const MINIMAL_ARGS = {
  model: "gpt-5.1-codex-max",
  verbose: false,
  idleTimeout: 30, // 30 s — generous but won't be reached; stream ends after one event
  sandbox: "none" as const,
  selfTest: false,
  version: false,
  help: false,
};

/** Verbatim message from the failing run at 1773634172699-4jyt-eb469b/ */
const UNSTABLE_FEATURE_WARNING =
  "Under-development features enabled: js_repl. " +
  "Under-development features are incomplete and may behave unpredictably. " +
  "To suppress this warning, set `suppress_unstable_features_warning = true` " +
  "in /Users/keithang/.codex/config.toml.";

/** A warning with a different feature name — should also be non-fatal after fix. */
const OTHER_UNSTABLE_FEATURE_WARNING =
  "Under-development features enabled: some_other_feature. " +
  "Under-development features are incomplete and may behave unpredictably. " +
  "To suppress this warning, set `suppress_unstable_features_warning = true` " +
  "in /home/user/.codex/config.toml.";

function makeEventStream(...events: object[]): AsyncGenerator<ThreadEvent> {
  return (async function* () {
    for (const e of events) {
      yield e as unknown as ThreadEvent;
    }
  })();
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Call the private consumeEvents method via type assertion. */
function consumeEvents(shim: CodexShim, events: AsyncGenerator<ThreadEvent>): Promise<void> {
  return (shim as unknown as { consumeEvents(e: AsyncGenerator<ThreadEvent>): Promise<void> }).consumeEvents(events);
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe("Codex unstable-feature warning handling", () => {
  test("consumeEvents should NOT throw for the js_repl unstable-feature warning", async () => {
    const shim = new CodexShim(MINIMAL_ARGS, "test prompt");
    const events = makeEventStream({
      type: "item.completed",
      item: { id: "item_0", type: "error", message: UNSTABLE_FEATURE_WARNING },
    });

    await expect(consumeEvents(shim, events)).resolves.toBeUndefined();
  });

  test("consumeEvents should NOT throw for other unstable-feature warnings", async () => {
    const shim = new CodexShim(MINIMAL_ARGS, "test prompt");
    const events = makeEventStream({
      type: "item.completed",
      item: { id: "item_0", type: "error", message: OTHER_UNSTABLE_FEATURE_WARNING },
    });

    await expect(consumeEvents(shim, events)).resolves.toBeUndefined();
  });

});
