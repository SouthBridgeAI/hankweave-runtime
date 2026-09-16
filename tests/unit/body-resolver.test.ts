import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BodyResolver } from "../../server/body-resolver.js";
import type { WatchedFileUpdate } from "../../server/codon-file-tracker.js";
import type { SentinelConfig } from "../../server/config-validation/sentinel.schema.js";
import type { ServerEvent } from "../../server/schemas/event-schemas.js";
import { CodonId, EventId } from "../../server/types/branded-types.js";
import type {
  HankweaveGenerateTextOptions,
  HankweaveGenerateTextResult,
} from "../../server/types/llm-call-types.js";
import { createTestSentinelManager } from "../utils/sentinel-test-harness.js";

let tempDir: string;
let counter = 0;

beforeEach(async () => {
  tempDir = path.resolve("tests", "test-area", `temp-body-resolver-${Date.now()}-${++counter}`);
  await fs.promises.mkdir(tempDir, { recursive: true });
});

afterEach(async () => {
  await fs.promises.rm(tempDir, { recursive: true, force: true });
});

function update(overrides: Partial<WatchedFileUpdate> = {}): WatchedFileUpdate {
  return {
    path: "notes/plan.md",
    filename: "plan.md",
    content: "hello world",
    action: "modified",
    source: { kind: "tool_use", toolUseId: "toolu_01" },
    ...overrides,
  };
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

describe("BodyResolver.process", () => {
  it("emits the fingerprint form — never a body, whatever the content", () => {
    const resolver = new BodyResolver(tempDir);
    const result = resolver.process(update({ action: "created" }));
    expect(result).toEqual({
      path: "notes/plan.md",
      filename: "plan.md",
      action: "created",
      sha256: sha256("hello world"),
      bytes: 11,
      source: { kind: "tool_use", toolUseId: "toolu_01" },
    });
    expect("content" in result).toBe(false);

    // Repeats and changes alike stay fingerprint-only.
    const repeat = resolver.process(update());
    expect("content" in repeat).toBe(false);
    expect(repeat.sha256).toBe(sha256("hello world"));
    const changed = resolver.process(update({ content: "v2" }));
    expect(changed.sha256).toBe(sha256("v2"));
    expect(changed.bytes).toBe(2);
  });

  it("passes the emission source through untouched", () => {
    const resolver = new BodyResolver(tempDir);
    const codonStart = resolver.process(update({ source: { kind: "codon-start" } }));
    expect(codonStart.source).toEqual({ kind: "codon-start" });
    const toolUse = resolver.process(
      update({ source: { kind: "tool_use", toolUseId: "toolu_99" } }),
    );
    expect(toolUse.source).toEqual({ kind: "tool_use", toolUseId: "toolu_99" });
  });

  it("counts bytes, not code units, for multibyte content", () => {
    const resolver = new BodyResolver(tempDir);
    const result = resolver.process(update({ content: "héllo" }));
    expect(result.bytes).toBe(Buffer.byteLength("héllo", "utf-8"));
    expect(result.sha256).toBe(sha256("héllo"));
  });

  it("fingerprints empty bodies like any other body", () => {
    const resolver = new BodyResolver(tempDir);
    const result = resolver.process(update({ content: "" }));
    expect(result.bytes).toBe(0);
    expect(result.sha256).toBe(sha256(""));
  });
});

describe("BodyResolver.resolve", () => {
  it("serves the retained body when it matches the event's fingerprint", () => {
    const resolver = new BodyResolver(tempDir);
    const emitted = resolver.process(update());
    // No file on disk: only the retained map can satisfy this.
    expect(resolver.resolve(emitted)).toBe("hello world");
  });

  it("falls back to a hash-verified disk read when the map cannot serve", async () => {
    await fs.promises.mkdir(path.join(tempDir, "notes"), { recursive: true });
    await fs.promises.writeFile(path.join(tempDir, "notes", "plan.md"), "hello world");

    const resolver = new BodyResolver(tempDir);
    const emitted = resolver.process(update());
    resolver.clear(); // e.g. resolution raced a rollback
    expect(resolver.resolve(emitted)).toBe("hello world");
  });

  it("serves the as-of-resolution disk body when the file changed after emission", async () => {
    await fs.promises.mkdir(path.join(tempDir, "notes"), { recursive: true });
    const resolver = new BodyResolver(tempDir);
    const emitted = resolver.process(update());
    resolver.clear();
    // The file moved on after the event (documented delayed-rendering case).
    await fs.promises.writeFile(path.join(tempDir, "notes", "plan.md"), "newer body");
    expect(resolver.resolve(emitted)).toBe("newer body");
  });

  it("returns undefined when the body is neither retained nor on disk", () => {
    const resolver = new BodyResolver(tempDir);
    const emitted = resolver.process(update());
    resolver.clear();
    expect(resolver.resolve(emitted)).toBeUndefined();
  });

  it("stops serving pre-clear bodies after clear() (run start / rollback)", () => {
    const resolver = new BodyResolver(tempDir);
    const emitted = resolver.process(update());
    resolver.clear();
    // Same fingerprint, no retained map, no disk file: nothing to vouch for.
    expect(resolver.resolve(emitted)).toBeUndefined();
    // Re-emission after clear repopulates.
    resolver.process(update());
    expect(resolver.resolve(emitted)).toBe("hello world");
  });

  it("resolves each event's own body even after later emissions to the same path", () => {
    // Retention is fingerprint-addressed: an older event view (a sequence
    // trigger's history, a queued sentinel batch) must not see a later body.
    const resolver = new BodyResolver(tempDir);
    const v1 = resolver.process(update({ content: "version one" }));
    const v2 = resolver.process(update({ content: "version two" }));
    expect(resolver.resolve(v1)).toBe("version one");
    expect(resolver.resolve(v2)).toBe("version two");
  });

  it("bounds retained memory: evicted bodies fall back to disk, oversized bodies get one shot", async () => {
    const resolver = new BodyResolver(tempDir);

    // Three ~7 MB bodies exceed the 16 MB retention budget: the oldest entry
    // is evicted, the newest two stay resolvable from memory.
    const bodyA = "a".repeat(7 * 1024 * 1024);
    const bodyB = "b".repeat(7 * 1024 * 1024);
    const bodyC = "c".repeat(7 * 1024 * 1024);
    const eventA = resolver.process(update({ path: "a.md", filename: "a.md", content: bodyA }));
    const eventB = resolver.process(update({ path: "b.md", filename: "b.md", content: bodyB }));
    const eventC = resolver.process(update({ path: "c.md", filename: "c.md", content: bodyC }));

    expect(resolver.resolve(eventB)).toBe(bodyB);
    expect(resolver.resolve(eventC)).toBe(bodyC);
    // a.md was evicted and has no disk copy here.
    expect(resolver.resolve(eventA)).toBeUndefined();
    // ...but with a disk copy, an evicted body still resolves.
    await fs.promises.writeFile(path.join(tempDir, "a.md"), bodyA);
    expect(resolver.resolve(eventA)).toBe(bodyA);

    // A single body larger than the whole budget is never put in the map —
    // it gets a one-shot transient slot: resolvable until the next emission,
    // and it must not evict everything else on its way through.
    const huge = "h".repeat(17 * 1024 * 1024);
    const eventHuge = resolver.process(
      update({ path: "huge.md", filename: "huge.md", content: huge }),
    );
    expect(resolver.resolve(eventHuge)).toBe(huge);
    expect(resolver.resolve(eventC)).toBe(bodyC);
    resolver.process(update({ path: "next.md", filename: "next.md", content: "next" }));
    expect(resolver.resolve(eventHuge)).toBeUndefined();
  });

  it("bounds the entry count too: a flood of tiny bodies cannot grow the map without limit", () => {
    // Each entry costs at least the flat overhead, so 16 MB / 256 B caps the
    // map at 65,536 entries even when every body is empty.
    const resolver = new BodyResolver(tempDir);
    const first = resolver.process(update({ path: "p0.md", filename: "p0.md", content: "" }));
    for (let i = 1; i <= 66000; i++) {
      resolver.process(update({ path: `p${i}.md`, filename: `p${i}.md`, content: "" }));
    }
    // The first entry was evicted (no disk copy → unresolvable), while a
    // recent one is still served from memory.
    expect(resolver.resolve(first)).toBeUndefined();
    const recent = { path: "p66000.md", sha256: first.sha256 };
    expect(resolver.resolve(recent)).toBe("");
  });
});

describe("sentinel resolution — fingerprint events keep content triggers and templates working", () => {
  function fileUpdatedEvent(data: Record<string, unknown>): ServerEvent {
    return {
      id: EventId(`evt-${Math.random().toString(36).slice(2, 11)}`),
      timestamp: new Date().toISOString(),
      type: "file.updated",
      data,
    } as unknown as ServerEvent;
  }

  function captureLlm() {
    const calls: HankweaveGenerateTextOptions[] = [];
    const fn = async (
      _id: string,
      options: HankweaveGenerateTextOptions,
    ): Promise<HankweaveGenerateTextResult> => {
      calls.push(options);
      return { text: "ok", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
    };
    return { calls, fn };
  }

  const templateConfig: SentinelConfig = {
    id: "fingerprint-view",
    name: "Fingerprint View",
    model: "anthropic/claude-3-5-sonnet-20241022",
    trigger: {
      type: "event",
      on: ["file.updated"],
      conditions: [{ operator: "contains", path: "content", value: "TODO" }],
    },
    execution: { strategy: "immediate" },
    userPromptText: "path: <%= it.events[0].data.path %>\nbody: <%= it.events[0].data.content %>",
  };

  it("resolves content for conditions and templates via the manager's lazy view", async () => {
    const resolver = new BodyResolver(tempDir);
    const { calls, fn } = captureLlm();
    const manager = createTestSentinelManager({
      resolveFileBody: (data) => resolver.resolve(data),
    });
    await manager.loadSentinelsForCodon([templateConfig], CodonId("test-codon"), {
      llmCallOverride: fn,
      executionPath: tempDir,
    });

    // A body with a TODO fires; the template sees the resolved body.
    const withTodo = resolver.process(update({ content: "line 1\nTODO: fix\n" }));
    await manager.handleEvent(fileUpdatedEvent(withTodo as unknown as Record<string, unknown>));
    // A body without one does not fire — conditions evaluate the same view.
    const withoutTodo = resolver.process(update({ content: "all done\n" }));
    await manager.handleEvent(fileUpdatedEvent(withoutTodo as unknown as Record<string, unknown>));
    await manager.completeAllWork();

    expect(calls.length).toBe(1);
    const prompt = calls[0].messages?.map((m) => m.content).join("\n") ?? "";
    expect(prompt).toContain("path: notes/plan.md");
    expect(prompt).toContain("TODO: fix");
    await manager.shutdown();
  });

  it("renders each event's own body, and keeps content visible to key-enumeration in templates", async () => {
    const resolver = new BodyResolver(tempDir);
    const { calls, fn } = captureLlm();
    const manager = createTestSentinelManager({
      resolveFileBody: (data) => resolver.resolve(data),
    });
    const config: SentinelConfig = {
      ...templateConfig,
      id: "own-body",
      trigger: { type: "event", on: ["file.updated"] },
      userPromptText:
        "body: <%= it.events[0].data.content %>\nkeys: <%= Object.keys(it.events[0].data).join(',') %>",
    };
    await manager.loadSentinelsForCodon([config], CodonId("test-codon"), {
      llmCallOverride: fn,
      executionPath: tempDir,
    });

    // Two versions of the same path: each trigger's template must render the
    // body its own event described, not the newest one (fingerprint-addressed
    // retention behind the memoized view).
    const v1 = resolver.process(update({ content: "version one" }));
    const v2 = resolver.process(update({ content: "version two" }));
    await manager.handleEvent(fileUpdatedEvent(v1 as unknown as Record<string, unknown>));
    await manager.handleEvent(fileUpdatedEvent(v2 as unknown as Record<string, unknown>));
    await manager.completeAllWork();

    expect(calls.length).toBe(2);
    const prompts = calls.map((c) => c.messages?.map((m) => m.content).join("\n") ?? "");
    expect(prompts[0]).toContain("body: version one");
    expect(prompts[1]).toContain("body: version two");
    // The lazy getter is enumerable: templates that enumerate or spread event
    // data keep seeing `content`, as they did when it was a real field.
    expect(prompts[0]).toContain("content");
    await manager.shutdown();
  });

  it("keeps triggering on path/action without a resolver, and never renders a body", async () => {
    const { calls, fn } = captureLlm();
    const manager = createTestSentinelManager();
    const config: SentinelConfig = {
      ...templateConfig,
      id: "no-resolver",
      trigger: { type: "event", on: ["file.updated"] },
      userPromptText: "path: <%= it.events[0].data.path %>",
    };
    await manager.loadSentinelsForCodon([config], CodonId("test-codon"), {
      llmCallOverride: fn,
      executionPath: tempDir,
    });

    const resolver = new BodyResolver(tempDir);
    const event = resolver.process(update());
    await manager.handleEvent(fileUpdatedEvent(event as unknown as Record<string, unknown>));
    await manager.completeAllWork();

    expect(calls.length).toBe(1);
    const prompt = calls[0].messages?.map((m) => m.content).join("\n") ?? "";
    expect(prompt).toContain("path: notes/plan.md");
    await manager.shutdown();
  });
});
