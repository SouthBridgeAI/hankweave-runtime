#!/usr/bin/env bun
/**
 * Live E2E — integrity of file.updated events in the journal.
 *
 * Three regressions, one per test, all driven by live Haiku codons defined in
 * tests/config/test-events-journal-integrity.config.json. Each test boots its
 * own server with --no-autostart and starts only its scenario's codons, so the
 * journals never cross-contaminate. Constants below mirror that config.
 *
 * 1. Divergent pattern matching
 *    (intermediates/65-watched-patterns-bugs/02-divergent-pattern-matching.md)
 *    The tool-call path must share the resolver's matcher semantics: no
 *    basename magic for deep paths, gitignore rules applied.
 *
 * 2. Read fabricates file.updated
 *    (intermediates/65-watched-patterns-bugs/03-read-bug-explainer.md)
 *    A Read of a watched file must not be journaled as a mutation.
 *
 * 3. Watched-pattern leak across codons
 *    (intermediates/65-watched-patterns-bugs/01-stale-watched-patterns-lifecycle.md)
 *    A codon with no checkpointedFiles must not inherit the watch list of a
 *    previous codon still finalizing in outputFiles.beforeCopy.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CodonId } from "../../server/types/branded-types.js";
import type {
  AssistantActionEvent,
  FileUpdatedEvent,
  ToolResultEvent,
} from "../../server/types/types.js";
import { type LaunchedServer, launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import { getFreePort, waitForCondition } from "../utils/test-helpers.js";

const CONFIG_PATH = "tests/config/test-events-journal-integrity.config.json";

/** Boots a server on the shared config, runs the scenario, always stops it. */
async function withServer(
  logPrefix: string,
  run: (server: LaunchedServer, agentRoot: string) => Promise<void>,
): Promise<void> {
  // outputFiles stages (including the beforeCopy gate the lifecycle test
  // relies on) only run when an output directory is configured.
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "hw-journal-integrity-output-"));
  const server = await launchHankweave({
    port: await getFreePort(),
    configPath: CONFIG_PATH,
    logPrefix,
    extraArgs: ["--no-autostart", "--output", outputDir],
  });
  try {
    await server.waitForEvent("server.ready", 60_000);
    await run(server, path.join(server.executionDir, "agentRoot"));
  } finally {
    await server.stop().catch(() => server.kill().catch(() => {}));
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

function startCodon(server: LaunchedServer, codonId: string): void {
  server.sendCommand({
    id: `start-${codonId}`,
    type: "codon.start",
    data: { codonId: CodonId(codonId) },
  });
}

function toolResults(server: LaunchedServer, codonId: string, toolName: string): ToolResultEvent[] {
  return server
    .getEvents()
    .filter(
      (event): event is ToolResultEvent =>
        event.type === "tool.result" &&
        event.data.codonId === codonId &&
        event.data.toolName === toolName,
    );
}

function fileUpdates(server: LaunchedServer, filePath: string, after = 0): FileUpdatedEvent[] {
  return server
    .getEvents()
    .slice(after)
    .filter(
      (event): event is FileUpdatedEvent =>
        event.type === "file.updated" && event.data.path === filePath,
    );
}

async function expectFileOnDisk(fullPath: string, body: string): Promise<void> {
  expect(
    await waitForCondition(
      () => fs.existsSync(fullPath) && fs.readFileSync(fullPath, "utf8").trim() === body,
      15_000,
    ),
  ).toBe(true);
}

describe("Live E2E — events journal integrity", () => {
  test("tool-path file.updated honors resolver matcher semantics", async () => {
    const codonId = "divergent-matcher";
    // Mirrors the codon's prompt: root file matches "*.md" under both
    // matchers; the deep file matches only via minimatch's matchBase; the
    // third is inside "output/**" but gitignored by the rig's .gitignore.
    const writes = [
      { file: "root-control.md", body: "LIVE_ROOT_CONTROL_BODY" },
      { file: "deep/dir/nested.md", body: "LIVE_DEEP_BASENAME_BODY" },
      { file: "output/tmp/ignored.md", body: "LIVE_GITIGNORED_BODY" },
    ];

    await withServer("[divergent-matcher-live]", async (server, agentRoot) => {
      startCodon(server, codonId);
      await server.waitForCodonCompletion(codonId, undefined, 180_000);

      // Execution evidence first: all three Writes really ran and landed on
      // disk. Without this the matcher assertions below would be vacuous.
      const writeResults = toolResults(server, codonId, "Write");
      expect(writeResults.length).toBeGreaterThanOrEqual(writes.length);
      for (const result of writeResults) {
        expect(result.data.isError).toBe(false);
      }
      for (const { file, body } of writes) {
        await expectFileOnDisk(path.join(agentRoot, file), body);
      }

      // No watched file exists at codon start (the rig creates only
      // .gitignore and empty directories), so every file.updated here comes
      // from the tool-call path.
      //
      // Positive control: the root file matches "*.md" under resolver
      // semantics too, so it must be journaled.
      expect(fileUpdates(server, writes[0].file).length).toBeGreaterThan(0);

      // The regression assertion: a divergent matcher journals the deep
      // basename (matchBase) and the gitignored write. One combined check
      // keeps both divergences visible in one red run.
      expect({
        deepBasenameUpdates: fileUpdates(server, writes[1].file),
        gitignoredUpdates: fileUpdates(server, writes[2].file),
      }).toEqual({ deepBasenameUpdates: [], gitignoredUpdates: [] });
    });
  }, 300_000);

  test("Read of a watched file journals no 'modified' event", async () => {
    const codonId = "read-only-codon";
    const watchedFile = "watched.md";
    const watchedBody = "LIVE_WATCHED_REFERENCE_BODY";

    await withServer("[read-fabricated-live]", async (server, agentRoot) => {
      startCodon(server, codonId);
      await server.waitForCodonCompletion(codonId, undefined, 180_000);

      // Execution evidence: the codon really performed a successful Read of
      // the watched file, and the file is untouched on disk.
      const readActions = server
        .getEvents()
        .filter(
          (event): event is AssistantActionEvent =>
            event.type === "assistant.action" &&
            event.data.codonId === codonId &&
            event.data.action === "tool_use" &&
            event.data.toolName === "Read",
        );
      expect(readActions.length).toBeGreaterThanOrEqual(1);

      const readResults = toolResults(server, codonId, "Read");
      expect(readResults.length).toBeGreaterThanOrEqual(1);
      for (const result of readResults) {
        expect(result.data.isError).toBe(false);
      }
      expect(fs.readFileSync(path.join(agentRoot, watchedFile), "utf8")).toBe(watchedBody);

      const watchedFileUpdates = fileUpdates(server, watchedFile);

      // Positive control: the initial snapshot legitimately journals the
      // pre-existing watched file once, as "created".
      expect(watchedFileUpdates.filter((event) => event.data.action === "created")).toHaveLength(1);

      // The regression assertion: a tracker that treats Read as a mutation
      // fabricates a second event with action "modified" and the full body,
      // although nothing wrote to the file.
      expect(watchedFileUpdates.filter((event) => event.data.action === "modified")).toEqual([]);
    });
  }, 300_000);

  test("a Write in unwatched B does not inherit finalizing A's watched-file subscription", async () => {
    const watchingCodonId = "watching-a";
    const unwatchedCodonId = "unwatched-b";
    const bOutputFile = "created-by-b.txt";
    const bFileContent = "LIVE_CODON_B_WROTE_THIS";
    const finalizingMarker = ".a-finalizing";
    const releaseMarker = ".release-a";

    await withServer("[watched-patterns-lifecycle-live]", async (server, agentRoot) => {
      try {
        startCodon(server, watchingCodonId);
        await server.waitForCodonCompletion(watchingCodonId, undefined, 180_000);

        // A is now held inside outputFiles.beforeCopy until we write the
        // release marker.
        expect(
          await waitForCondition(
            () => fs.existsSync(path.join(agentRoot, finalizingMarker)),
            15_000,
          ),
        ).toBe(true);

        // Exclude A's legitimate initial snapshot from the assertion below.
        const bEventBoundary = server.getEvents().length;

        startCodon(server, unwatchedCodonId);

        const writeAction = (await server.waitForEvent("assistant.action", 180_000, (event) => {
          const action = event as AssistantActionEvent;
          return (
            action.data.codonId === unwatchedCodonId &&
            action.data.action === "tool_use" &&
            action.data.toolName === "Write"
          );
        })) as AssistantActionEvent;
        expect(writeAction.data.toolInput?.file_path).toBeDefined();

        const writeResult = (await server.waitForEvent("tool.result", 180_000, (event) => {
          const result = event as ToolResultEvent;
          return result.data.codonId === unwatchedCodonId && result.data.toolName === "Write";
        })) as ToolResultEvent;
        expect(writeResult.data.isError).toBe(false);

        await expectFileOnDisk(path.join(agentRoot, bOutputFile), bFileContent);

        const bFileUpdates = fileUpdates(server, bOutputFile, bEventBoundary);

        // Let A leave beforeCopy before evaluating the regression assertion,
        // so the spawned hook cannot be stranded by a test failure.
        fs.writeFileSync(path.join(agentRoot, releaseMarker), "release\n");

        // The regression assertion: B declared no checkpointedFiles, so its
        // real Write must not be published as file.updated.
        expect(bFileUpdates).toEqual([]);
      } finally {
        // Failure paths above must still unstick A's beforeCopy gate.
        if (fs.existsSync(agentRoot)) {
          fs.writeFileSync(path.join(agentRoot, releaseMarker), "release\n");
        }
      }
    });
  }, 300_000);
});
