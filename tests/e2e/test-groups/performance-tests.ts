import { expect, test } from "bun:test";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
}

export function runPerformanceTests(testState: TestState) {
  test("events are delivered with reasonable latency", () => {
    // Check that events are delivered promptly after actions
    const assistantActions = testState.client?.getEventsByType("assistant.action") || [];
    const tokenUsageEvents = testState.client?.getEventsByType("token.usage") || [];

    // Pair each assistant action with a token.usage event inside the 5s
    // window after it. The old `expect(latency).toBeLessThan(10000)` inside
    // the window was unreachable (the search window is 5000ms), so finding a
    // pairing IS the latency contract. Not every action pairs (the final
    // token.usage of a codon fires at completion, which can trail the last
    // action by more than 5s), so assert at least one pairing exists.
    const pairedActions = assistantActions.filter((action) => {
      const actionTime = new Date(action.timestamp).getTime();
      return tokenUsageEvents.some((t) => {
        const tokenTime = new Date(t.timestamp).getTime();
        return tokenTime >= actionTime && tokenTime <= actionTime + 5000;
      });
    });

    expect(assistantActions.length).toBeGreaterThan(0);
    expect(tokenUsageEvents.length).toBeGreaterThan(0);
    expect(pairedActions.length).toBeGreaterThan(0);
  });

  test("event stream preserves causal codon lifecycle order", () => {
    // Timestamp monotonicity across the whole stream was NEVER a runtime
    // contract: timestamps are event-CREATION times, while journal/broadcast
    // order is APPEND order, and async emit paths invert them by a few ms in
    // dense bursts. The old assertion only survived because this client used
    // to MISS the dense boot burst (the autostart-vs-handshake race — fixed
    // by handshake backfill, which promptly falsified it). What the runtime
    // DOES guarantee is causal order on the delivered stream: a codon starts
    // before it completes, and this single-threaded runtime completes one
    // codon before starting the next.
    const events = testState.client?.getEvents() || [];
    const lifecycle = events
      .filter((e) => e.type === "codon.started" || e.type === "codon.completed")
      .map((e) => `${e.type}:${(e.data as { codonId: string }).codonId}`);

    expect(lifecycle.length).toBeGreaterThanOrEqual(6);
    for (const codonId of ["codon-1", "codon-2", "codon-3"]) {
      const started = lifecycle.indexOf(`codon.started:${codonId}`);
      const completed = lifecycle.indexOf(`codon.completed:${codonId}`);
      expect(started).toBeGreaterThanOrEqual(0);
      expect(completed).toBeGreaterThan(started);
    }
    // Sequential runtime: codon N completes before codon N+1 starts.
    expect(lifecycle.indexOf("codon.completed:codon-1")).toBeLessThan(
      lifecycle.indexOf("codon.started:codon-2"),
    );
    expect(lifecycle.indexOf("codon.completed:codon-2")).toBeLessThan(
      lifecycle.indexOf("codon.started:codon-3"),
    );
  });
}
