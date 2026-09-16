#!/usr/bin/env bun
/**
 * Resume-rollback repro and preflight-abort coverage for issue #228, fully
 * offline and keyless via the local pi mock-provider pattern (see
 * pi-local-mock.test.ts for the mechanism).
 *
 * Scenario built by every test: a two-codon hank where codon-one completes
 * (with an archiveOnSuccess file) and codon-two fails (mock returns 500),
 * leaving a failed execution thread with real checkpoints on disk.
 *
 * 1. Resume repro: relaunching triggers the automatic rollback to codon-one's
 *    completion checkpoint. It must complete WITHOUT the bogus
 *    "Target checkpoint ... not found in manifest" error line, restore the
 *    worktree to the codon-one tree (content, not just paths), keep the
 *    at-target archive entry archived, and the failed codon's checkpointed
 *    file must remain recoverable from the error:<codon> commit.
 *
 * 2. Same resume with NO archiveOnSuccess anywhere: the manifest is empty,
 *    which is exactly the shape that made the old list-order lookup log the
 *    bogus error on every ordinary resume.
 *
 * 3. Aborted direct rollback: rollback.toCheckpoint against a historical SHA
 *    that no longer resolves must fail before the RunCompleted transition —
 *    the current run must not be completed and the workspace stays untouched.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type LaunchedServer, launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import { getFreePort } from "../utils/test-helpers.js";

const CODON1_CONTENT = "content written during codon one";
const CODON2_CONTENT = "content written during failed codon two";
const BOGUS_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

/** Minimal OpenAI chat-completions endpoint whose behavior can be flipped to failure. */
function startMockProvider(): {
  server: ReturnType<typeof Bun.serve>;
  behavior: { fail: boolean };
} {
  const behavior = { fail: false };
  let requestCount = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      requestCount++;

      if (behavior.fail) {
        return new Response(
          JSON.stringify({ error: { message: "mock provider exploded", type: "server_error" } }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }

      const chunk = (data: object) => `data: ${JSON.stringify(data)}\n\n`;
      const base = {
        id: `chatcmpl-mock-${requestCount}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "mock-1",
      };
      const body = [
        chunk({
          ...base,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        }),
        chunk({
          ...base,
          choices: [{ index: 0, delta: { content: "MOCK OK" }, finish_reason: null }],
        }),
        chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
        chunk({
          ...base,
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        }),
        "data: [DONE]\n\n",
      ].join("");

      return new Response(body, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    },
  });
  return { server, behavior };
}

/**
 * Recursive relative listing of every file under a workspace, with sizes, so
 * "workspace untouched" assertions compare actual content shape rather than
 * top-level names.
 */
function listWorkspace(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        // POSIX separators so assertions read the same on Windows.
        const rel = path.relative(root, full).split(path.sep).join("/");
        out.push(`${rel}:${fs.statSync(full).size}`);
      }
    }
  };
  walk(root);
  return out.sort();
}

interface FailedScenario {
  executionDir: string;
  configPath: string;
  agentRoot: string;
  env: Record<string, string>;
  behavior: { fail: boolean };
  /** codon-one's completion checkpoint SHA recorded in state.json */
  completionSha: string;
  /** codon-two's error checkpoint SHA recorded in state.json */
  errorSha: string;
}

describe("resume rollback after codon failure (issue #228)", () => {
  const cleanups: Array<() => void> = [];
  afterAll(() => {
    for (const fn of cleanups) {
      try {
        fn();
      } catch {
        // best-effort
      }
    }
  });

  function readState(executionDir: string): {
    runs: Array<{
      runId: string;
      status: string;
      codons: Array<{
        codonId: string;
        status: string;
        completionCheckpoint?: string;
        errorCheckpoint?: string;
      }>;
    }>;
    currentRunId: string | null;
  } {
    const statePath = path.join(executionDir, ".hankweave", "state.json");
    return JSON.parse(fs.readFileSync(statePath, "utf-8"));
  }

  function writeState(executionDir: string, state: unknown): void {
    const statePath = path.join(executionDir, ".hankweave", "state.json");
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  }

  /** Read a file out of a checkpoint commit in the shadow repo. */
  async function gitShow(executionDir: string, sha: string, filePath: string): Promise<string> {
    const gitEnv = {
      GIT_DIR: path.join(executionDir, ".hankweave", "checkpoints", ".hankweavecheckpoints"),
      GIT_WORK_TREE: path.join(executionDir, "agentRoot"),
    };
    const proc = Bun.spawn(["git", "show", `${sha}:${filePath}`], {
      env: { ...process.env, ...gitEnv },
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) throw new Error(`git show ${sha}:${filePath} failed`);
    return out;
  }

  /**
   * Run the hank to the failed state: codon-one completes (its .md file and
   * archiveOnSuccess file in place), codon-two starts with its rig directory,
   * writes a checkpointed file, and fails against the 500-ing mock.
   */
  async function buildFailedScenario(
    prefix: string,
    options: { archive?: boolean } = {},
  ): Promise<FailedScenario> {
    const archive = options.archive ?? true;
    const { server: mock, behavior } = startMockProvider();
    cleanups.push(() => mock.stop(true));

    const piDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-pi-`));
    cleanups.push(() => fs.rmSync(piDir, { recursive: true, force: true }));
    fs.writeFileSync(
      path.join(piDir, "models.json"),
      JSON.stringify({
        providers: {
          mocklocal: {
            baseUrl: `http://127.0.0.1:${mock.port}/v1`,
            api: "openai-completions",
            apiKey: "test-key-never-checked",
            models: [
              {
                id: "mock-1",
                name: "Local Mock Model",
                contextWindow: 128000,
                maxTokens: 4096,
                cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      }),
    );

    // Hank (config) dir separate from the execution dir: the runtime writes
    // its own copy of the config into the execution dir, and a co-located
    // config trips the changed-hash safety check on relaunch.
    const hankDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-hank-`));
    cleanups.push(() => fs.rmSync(hankDir, { recursive: true, force: true }));
    const executionDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-exec-`));
    cleanups.push(() => fs.rmSync(executionDir, { recursive: true, force: true }));

    // rigSetup copy source, relative to the hank (config) directory
    fs.mkdirSync(path.join(hankDir, "rig-template"), { recursive: true });
    fs.writeFileSync(path.join(hankDir, "rig-template", "seed.txt"), "rig seed file");

    const configPath = path.join(hankDir, "hank.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        // Present up front so the runtime's ensureSchemaUrl does not rewrite
        // the file after hashing it (which would trip the changed-config
        // safety prompt on relaunch).
        $schema: "https://unpkg.com/hankweave@latest/schemas/hank.schema.json",
        hank: [
          {
            id: "codon-one",
            name: "Codon One",
            promptText: "Reply with exactly: MOCK OK",
            model: "pi/mocklocal/mock-1",
            continuationMode: "fresh",
            checkpointedFiles: ["*.md"],
            ...(archive ? { archiveOnSuccess: ["archive-me.txt"] } : {}),
          },
          {
            id: "codon-two",
            name: "Codon Two",
            promptText: "Reply with exactly: MOCK OK",
            model: "pi/mocklocal/mock-1",
            continuationMode: "fresh",
            checkpointedFiles: ["*.md", "codon2-rig/**/*"],
            rigSetup: [{ type: "copy", copy: { from: "rig-template", to: "codon2-rig" } }],
          },
        ],
      }),
    );

    const env = { PI_CODING_AGENT_DIR: piDir, PI_OFFLINE: "1" };
    const agentRoot = path.join(executionDir, "agentRoot");

    const port = await getFreePort();
    let server: LaunchedServer | undefined;
    try {
      server = await launchHankweave({
        port,
        configPath,
        executionDir,
        reuseTestDirectory: true,
        logPrefix: `[${prefix}-run1]`,
        extraArgs: ["--force", "--no-autostart"],
        sendPreviousEvents: true,
        env,
      });
      await server.waitForEvent("server.ready", 30_000);

      // Files that belong to codon-one's completion tree, written before the
      // codon runs so its completion checkpoint captures them.
      fs.writeFileSync(path.join(agentRoot, "codon1-output.md"), CODON1_CONTENT);
      if (archive) {
        fs.writeFileSync(
          path.join(agentRoot, "archive-me.txt"),
          "archived at codon-one completion",
        );
      }

      server.sendCommand({ id: "start-1", type: "codon.next" } as never);
      await server.waitForCodonCompletion("codon-one", undefined, 60_000);

      // The failed codon's checkpointed file, written before codon-two runs so
      // the error checkpoint captures it.
      fs.writeFileSync(path.join(agentRoot, "codon2-output.md"), CODON2_CONTENT);

      behavior.fail = true;
      server.sendCommand({ id: "start-2", type: "codon.next" } as never);
      await server.waitForState((s) => {
        const run = s.runs[0];
        const codon = run?.codons.find((c) => c.codonId === "codon-two");
        return codon?.status === "failed" && Boolean(codon.errorCheckpoint);
      }, 120_000);
    } finally {
      await server?.stop(15_000).catch(() => {});
    }
    behavior.fail = false;

    // Sanity on the recorded checkpoints
    const state = readState(executionDir);
    const run = state.runs.find((r) => r.codons.some((c) => c.codonId === "codon-two"));
    if (!run) throw new Error("scenario: no run with codon-two");
    const codonOne = run.codons.find((c) => c.codonId === "codon-one");
    const codonTwo = run.codons.find((c) => c.codonId === "codon-two");
    if (!codonOne?.completionCheckpoint) throw new Error("scenario: no completion checkpoint");
    if (!codonTwo?.errorCheckpoint) throw new Error("scenario: no error checkpoint");

    // The scenario the issue describes: failed codon's files on disk,
    // including an un-checkpointed scratch file inside the rig directory.
    expect(fs.existsSync(path.join(agentRoot, "codon2-output.md"))).toBe(true);
    expect(fs.existsSync(path.join(agentRoot, "codon2-rig", "seed.txt"))).toBe(true);
    fs.writeFileSync(
      path.join(agentRoot, "codon2-rig", "scratch.txt"),
      "never checkpointed scratch",
    );
    // archiveOnSuccess moved the file out of the workspace into rigArchive/
    if (archive) {
      expect(fs.existsSync(path.join(agentRoot, "archive-me.txt"))).toBe(false);
      expect(
        fs.existsSync(path.join(executionDir, "rigArchive", "codon-one", "archive-me.txt")),
      ).toBe(true);
    }

    return {
      executionDir,
      configPath,
      agentRoot,
      env,
      behavior,
      completionSha: codonOne.completionCheckpoint,
      errorSha: codonTwo.errorCheckpoint,
    };
  }

  test("resume repro: rollback completes cleanly, no bogus manifest error, error commit keeps the failed file", async () => {
    const scenario = await buildFailedScenario("rb228-repro");

    const port = await getFreePort();
    let server: LaunchedServer | undefined;
    try {
      server = await launchHankweave({
        port,
        configPath: scenario.configPath,
        executionDir: scenario.executionDir,
        reuseTestDirectory: true,
        logPrefix: "[rb228-repro-resume]",
        extraArgs: ["--no-autostart"],
        sendPreviousEvents: true,
        env: scenario.env,
      });
      await server.waitForEvent("server.ready", 30_000);

      // The startup rollback ran during start(); its events are journaled and
      // arrive via the handshake backfill.
      await server.waitForEvent("rollback.completed", 30_000);

      // Worktree CONTENT matches the codon-one completion tree
      const codon1File = path.join(scenario.agentRoot, "codon1-output.md");
      expect(fs.existsSync(codon1File)).toBe(true);
      expect(fs.readFileSync(codon1File, "utf-8")).toBe(CODON1_CONTENT);
      // The failed codon's files are gone from the worktree (designed
      // retry-from-last-success semantics)...
      expect(fs.existsSync(path.join(scenario.agentRoot, "codon2-output.md"))).toBe(false);
      expect(fs.existsSync(path.join(scenario.agentRoot, "codon2-rig"))).toBe(false);

      // ...but the checkpointed one is recoverable from the error:<codon> commit
      const errorCommitContent = await gitShow(
        scenario.executionDir,
        scenario.errorSha,
        "codon2-output.md",
      );
      expect(errorCommitContent).toBe(CODON2_CONTENT);

      // Root cause (a): the misleading logger error is gone from server.log
      const serverLog = server.serverLogFile();
      expect(serverLog).not.toContain("not found in manifest");

      // The archive entry recorded AT the rollback target stays archived:
      // file still in rigArchive/, not restored into the workspace, and its
      // manifest entry intact (the old code's "restore everything" fallback
      // would have wrongly un-archived it).
      expect(
        fs.existsSync(
          path.join(scenario.executionDir, "rigArchive", "codon-one", "archive-me.txt"),
        ),
      ).toBe(true);
      expect(fs.existsSync(path.join(scenario.agentRoot, "archive-me.txt"))).toBe(false);
      const manifest = JSON.parse(
        fs.readFileSync(
          path.join(scenario.executionDir, ".hankweave", "archive-manifest.json"),
          "utf-8",
        ),
      );
      expect(manifest.entries.length).toBe(1);
      expect(manifest.entries[0].sourcePath).toBe("archive-me.txt");

      // A continuation run was created for the retry
      const state = readState(scenario.executionDir);
      expect(state.runs.length).toBeGreaterThanOrEqual(2);
    } finally {
      await server?.stop(15_000).catch(() => {});
    }
  }, 300_000);

  test("resume repro without archiveOnSuccess: empty manifest, no bogus manifest error", async () => {
    // The issue's own minimal fixture: a plain two-codon hank with no
    // archiveOnSuccess at all. The manifest is empty, so the old list-order
    // lookup could never find the target and logged the error every resume.
    const scenario = await buildFailedScenario("rb228-noarch", { archive: false });

    const port = await getFreePort();
    let server: LaunchedServer | undefined;
    try {
      server = await launchHankweave({
        port,
        configPath: scenario.configPath,
        executionDir: scenario.executionDir,
        reuseTestDirectory: true,
        logPrefix: "[rb228-noarch-resume]",
        extraArgs: ["--no-autostart"],
        sendPreviousEvents: true,
        env: scenario.env,
      });
      await server.waitForEvent("server.ready", 30_000);
      await server.waitForEvent("rollback.completed", 30_000);

      expect(fs.readFileSync(path.join(scenario.agentRoot, "codon1-output.md"), "utf-8")).toBe(
        CODON1_CONTENT,
      );
      expect(fs.existsSync(path.join(scenario.agentRoot, "codon2-output.md"))).toBe(false);
      expect(server.serverLogFile()).not.toContain("not found in manifest");
      expect(server.getEvents().some((e) => e.type === "rollback.archiveRestore")).toBe(false);
    } finally {
      await server?.stop(15_000).catch(() => {});
    }
  }, 300_000);

  test("failed direct rollback: historical SHA that no longer resolves fires no RunCompleted", async () => {
    const scenario = await buildFailedScenario("rb228-direct");

    // First resume: the automatic rollback succeeds and creates a
    // continuation run, making the failed codon-two a HISTORICAL codon.
    {
      const port = await getFreePort();
      const server = await launchHankweave({
        port,
        configPath: scenario.configPath,
        executionDir: scenario.executionDir,
        reuseTestDirectory: true,
        logPrefix: "[rb228-direct-resume]",
        extraArgs: ["--no-autostart"],
        sendPreviousEvents: true,
        env: scenario.env,
      });
      try {
        await server.waitForEvent("server.ready", 30_000);
        await server.waitForEvent("rollback.completed", 30_000);
      } finally {
        await server.stop(15_000).catch(() => {});
      }
    }

    // Corrupt the HISTORICAL error checkpoint: still recorded in state, but
    // no longer resolvable in the checkpoint repository.
    const state = readState(scenario.executionDir);
    const failedRun = state.runs.find((r) =>
      r.codons.some((c) => c.codonId === "codon-two" && c.status === "failed"),
    );
    if (!failedRun) throw new Error("no failed historical run");
    const codonTwo = failedRun.codons.find((c) => c.codonId === "codon-two");
    if (!codonTwo) throw new Error("no codon-two");
    codonTwo.errorCheckpoint = BOGUS_SHA;
    writeState(scenario.executionDir, state);

    const port = await getFreePort();
    let server: LaunchedServer | undefined;
    try {
      server = await launchHankweave({
        port,
        configPath: scenario.configPath,
        executionDir: scenario.executionDir,
        reuseTestDirectory: true,
        logPrefix: "[rb228-direct-cmd]",
        extraArgs: ["--no-autostart"],
        sendPreviousEvents: true,
        env: scenario.env,
      });
      await server.waitForEvent("server.ready", 30_000);
      const stateBefore = readState(scenario.executionDir);
      const runsBefore = stateBefore.runs.length;
      const workspaceBefore = listWorkspace(scenario.agentRoot);

      const commandSentAt = new Date().toISOString();
      server.sendCommand({
        id: "direct-rollback",
        type: "rollback.toCheckpoint",
        data: { checkpointSha: BOGUS_SHA },
      } as never);

      await server.waitForEvent(
        "error",
        30_000,
        (e) => {
          const text = JSON.stringify(e.data);
          return text.includes("Rollback failed") && text.includes("not found in repository");
        },
        commandSentAt,
      );

      // It really took the direct-rollback path (historical checkpoint)...
      expect(server.serverLogFile()).toContain("Executing direct rollback");

      // ...and aborted before mutating anything: no rollback.started, no
      // RunCompleted transition for the current run, no new run, workspace
      // identical.
      const eventsAfter = server.getEvents().filter((e) => e.timestamp > commandSentAt);
      expect(eventsAfter.some((e) => e.type === "rollback.started")).toBe(false);
      expect(eventsAfter.some((e) => e.type === "rollback.completed")).toBe(false);
      expect(
        eventsAfter.some(
          (e) =>
            e.type === "state.transition" &&
            (e.data as { transitionType?: string }).transitionType === "RunCompleted",
        ),
      ).toBe(false);

      const stateAfter = readState(scenario.executionDir);
      expect(stateAfter.runs.length).toBe(runsBefore);
      const currentRun = stateAfter.runs.find((r) => r.runId === stateAfter.currentRunId);
      expect(currentRun?.status).not.toBe("completed");
      expect(listWorkspace(scenario.agentRoot)).toEqual(workspaceBefore);
    } finally {
      await server?.stop(15_000).catch(() => {});
    }
  }, 300_000);
});
