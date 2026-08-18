import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { SentinelManager } from "../../server/sentinels/sentinel-manager.js";
import { CodonId } from "../../server/types/branded-types.js";
import type {
  HankweaveGenerateObjectOptions,
  HankweaveGenerateTextOptions,
} from "../../server/types/llm-call-types.js";
import type { SentinelConfig } from "../../server/types/sentinel-types.js";
import { createMockLlm } from "../utils/mock-llm.js";
import { createTestSentinelManager, fileUpdatedEvent } from "../utils/sentinel-test-harness.js";

/**
 * A codon can load sentinel configs from different directories. Each sentinel
 * must resolve its own file refs (systemPromptFile, structuredOutput.schemaFile)
 * against the directory its OWN config was loaded from — not the first config's
 * directory.
 */
describe("SentinelManager - per-config directories", () => {
  let testDir: string;
  let dirA: string;
  let dirB: string;
  let manager: SentinelManager;

  const makeConfig = (id: string): SentinelConfig => ({
    id,
    name: `Sentinel ${id}`,
    model: "anthropic/claude-3-5-sonnet-20241022",
    trigger: { type: "event", on: ["file.updated"] },
    execution: { strategy: "immediate" },
    userPromptText: "Analyze",
    systemPromptFile: "./prompt.md",
    structuredOutput: {
      schemaFile: "./schema.ts",
      output: "object",
    },
  });

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `test-sentinel-config-dirs-${Date.now()}`);
    // Same-named relative refs at different directory depths
    dirA = path.join(testDir, "sentinels", "a");
    dirB = path.join(testDir, "sentinels", "b", "nested");
    await fs.mkdir(dirA, { recursive: true });
    await fs.mkdir(dirB, { recursive: true });

    await fs.writeFile(path.join(dirA, "prompt.md"), "SYSTEM PROMPT FROM A");
    await fs.writeFile(path.join(dirB, "prompt.md"), "SYSTEM PROMPT FROM B");
    await fs.writeFile(path.join(dirA, "schema.ts"), "z.object({ fromA: z.string() })");
    await fs.writeFile(path.join(dirB, "schema.ts"), "z.object({ fromB: z.string() })");

    manager = createTestSentinelManager();
    await manager.initialize();
  });

  afterEach(async () => {
    await manager.shutdown();
    try {
      await fs.rm(testDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  async function loadAndTrigger(options: {
    configDirectory?: string;
    configDirectories?: Map<string, string>;
  }) {
    const capturedObjectCalls = new Map<string, HankweaveGenerateObjectOptions>();

    const mockLlm = createMockLlm();
    const mockTextCall = async (_id: string, opts: HankweaveGenerateTextOptions) =>
      mockLlm.generateText(opts);
    const mockObjectCall = async (sentinelId: string, opts: HankweaveGenerateObjectOptions) => {
      capturedObjectCalls.set(sentinelId, opts);
      return {
        object: sentinelId === "sentinel-a" ? { fromA: "x" } : { fromB: "x" },
        finishReason: "stop" as const,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    };

    const { loadedIds } = await manager.loadSentinelsForCodon(
      [makeConfig("sentinel-a"), makeConfig("sentinel-b")],
      CodonId("test-codon"),
      {
        ...options,
        llmCallOverride: mockTextCall,
        llmObjectCallOverride: mockObjectCall,
      },
    );

    await manager.handleEvent(fileUpdatedEvent());
    await manager.completeAllWork();

    return { loadedIds, capturedObjectCalls };
  }

  test("each sentinel resolves file refs against its own config directory", async () => {
    const { loadedIds, capturedObjectCalls } = await loadAndTrigger({
      configDirectories: new Map([
        ["sentinel-a", dirA],
        ["sentinel-b", dirB],
      ]),
    });

    expect(loadedIds.sort()).toEqual(["sentinel-a", "sentinel-b"]);

    const callA = capturedObjectCalls.get("sentinel-a");
    const callB = capturedObjectCalls.get("sentinel-b");
    expect(callA?.system).toContain("SYSTEM PROMPT FROM A");
    expect(callB?.system).toContain("SYSTEM PROMPT FROM B");

    // Each sentinel evaluated its own schema file
    expect(callA?.schema?.safeParse({ fromA: "x" }).success).toBe(true);
    expect(callA?.schema?.safeParse({ fromB: "x" }).success).toBe(false);
    expect(callB?.schema?.safeParse({ fromB: "x" }).success).toBe(true);
    expect(callB?.schema?.safeParse({ fromA: "x" }).success).toBe(false);
  });

  test("per-config directories win over the batch-level configDirectory", async () => {
    // Mimics the old runtime behavior of flattening to the first config's
    // directory: without per-config dirs, sentinel-b would silently read
    // sentinel-a's prompt.md and schema.ts.
    const { loadedIds, capturedObjectCalls } = await loadAndTrigger({
      configDirectory: dirA,
      configDirectories: new Map([
        ["sentinel-a", dirA],
        ["sentinel-b", dirB],
      ]),
    });

    expect(loadedIds.sort()).toEqual(["sentinel-a", "sentinel-b"]);
    expect(capturedObjectCalls.get("sentinel-b")?.system).toContain("SYSTEM PROMPT FROM B");
    expect(capturedObjectCalls.get("sentinel-b")?.schema?.safeParse({ fromB: "x" }).success).toBe(
      true,
    );
  });
});
