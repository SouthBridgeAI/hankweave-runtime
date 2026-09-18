/**
 * git is mandatory. Checkpoints, rollback, and crash recovery are all built
 * on the shadow git repository, so a machine without git must fail the boot
 * loudly instead of the old behaviour: log "Checkpointing disabled" and run
 * on without a single save point.
 *
 * The CLI and `HankweaveRuntime.start()` share one cached Git probe. The CLI
 * checks before the execution directory is created, wiped, or copied into;
 * direct runtime startup checks before opening the workspace or initializing
 * state, the event journal, or the WebSocket server.
 *
 * "No git" is simulated by pointing PATH at an empty directory for the
 * duration of a test; the probe uses `process.env`, so the lookup fails
 * with ENOENT the same way it does on a bare host.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertGitAvailable,
  GitMissingError,
  resetGitProbeForTests,
} from "../../server/git-support.js";
import { HankweaveRuntime } from "../../server/hankweave-runtime.js";
import { StateManager } from "../../server/state-manager.js";
import { Workspace } from "../../server/workspace/index.js";

const savedPath = process.env.PATH;
let emptyBinDir: string;

const hideGit = () => {
  process.env.PATH = emptyBinDir;
};
const restoreGit = () => {
  process.env.PATH = savedPath;
};

beforeEach(() => {
  resetGitProbeForTests();
  emptyBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "hw-no-git-"));
});

afterEach(() => {
  restoreGit();
  resetGitProbeForTests();
  fs.rmSync(emptyBinDir, { recursive: true, force: true });
});

describe("assertGitAvailable", () => {
  test("passes when git is on PATH", () => {
    expect(() => assertGitAvailable("hankweave run")).not.toThrow();
  });

  test("throws GitMissingError, naming the fix, when git cannot be run", () => {
    hideGit();
    expect(() => assertGitAvailable("hankweave run")).toThrow(GitMissingError);
    expect(() => assertGitAvailable("hankweave run")).toThrow("git is required");
    expect(() => assertGitAvailable("hankweave run")).toThrow("Install git");
  });

  test("reuses the CLI probe at runtime startup", () => {
    assertGitAvailable("hankweave run");
    hideGit();
    expect(() => assertGitAvailable("runtime startup")).not.toThrow();
  });
});

describe("HankweaveRuntime.start() workspace preflight", () => {
  let execDir: string;
  let runtime: HankweaveRuntime | undefined;

  const makeRuntime = (): HankweaveRuntime =>
    new HankweaveRuntime({
      autostart: false,
      headless: true,
      port: 0,
      cwd: execDir,
      executionPath: execDir,
      agentRootPath: execDir,
      rigArchivePath: path.join(execDir, "rigArchive"),
      dataPathInExecutionDir: execDir,
      readOnlySourceDataPath: execDir,
      dataHash: "test-hash",
      isNewExecution: true,
      isResuming: false,
      linkType: "symlink",
      codons: [],
      socketLogFile: path.join(execDir, ".hankweave/logs/socket.jsonl"),
      serverLogFile: path.join(execDir, ".hankweave/logs/server.log"),
      outputDirectory: execDir,
      sentinel: {
        enablePersistence: false,
        healthCheckGracePeriodMs: 0,
        waitForAllHealthChecks: false,
      },
      logParsingInterval: 5,
      dataHashTimeLimit: 5000,
      toolResultTruncateLength: 2500,
      withoutProxy: true,
      handshakeHistoryLimit: 50,
      version: "1.0.0",
      lockFile: path.join(execDir, ".hankweave/runtime.lock"),
    });

  beforeEach(() => {
    fs.mkdirSync(path.resolve("tests", "test-area"), { recursive: true });
    execDir = fs.mkdtempSync(path.resolve("tests", "test-area", "rt-no-git-"));
    fs.mkdirSync(path.join(execDir, ".hankweave", "logs"), { recursive: true });
  });

  afterEach(() => {
    // start() rejects before a server, lock, or journal exists, so there is
    // nothing to shut down; shutdown() would only log a journal-not-open error.
    runtime = undefined;
    fs.rmSync(execDir, { recursive: true, force: true });
  });

  test("rejects with GitMissingError before touching state, journal, or lock", async () => {
    runtime = makeRuntime();
    hideGit();
    const error = await runtime.start().catch((e: unknown) => e);
    restoreGit();

    expect(error).toBeInstanceOf(GitMissingError);
    // Nothing downstream of the git check ran: no journal, no state file, no lock.
    expect(fs.existsSync(path.join(execDir, ".hankweave", "events"))).toBe(false);
    expect(fs.existsSync(path.join(execDir, ".hankweave", "state.json"))).toBe(false);
    expect(fs.existsSync(path.join(execDir, ".hankweave", "runtime.lock"))).toBe(false);
    expect(fs.existsSync(path.join(execDir, ".hankweave", "checkpoints"))).toBe(false);
  });

  test("checks existing ownership before opening the workspace", async () => {
    const lockPath = path.join(execDir, ".hankweave", "runtime.lock");
    const incumbent = JSON.stringify({ pid: process.pid, lastHeartbeat: new Date().toISOString() });
    fs.writeFileSync(lockPath, incumbent);
    const open = spyOn(Workspace, "open");
    try {
      runtime = makeRuntime();
      expect(open).not.toHaveBeenCalled();
      await expect(runtime.start()).rejects.toThrow("refusing to touch");
      expect(open).not.toHaveBeenCalled();
      expect(fs.readFileSync(lockPath, "utf8")).toBe(incumbent);
      expect(fs.existsSync(path.join(execDir, ".hankweave", "checkpoints"))).toBe(false);
    } finally {
      open.mockRestore();
    }
  });

  test("a malformed archive rejects opening before execution state initialization", async () => {
    const statePath = path.join(execDir, ".hankweave", "state.json");
    const manifestPath = path.join(execDir, ".hankweave", "archive-manifest.json");
    const stateBefore = '{"unread":"execution state"}';
    const invalidManifest = '{"version":"1.0.0","entries":[{}]}';
    fs.writeFileSync(statePath, stateBefore);
    fs.writeFileSync(manifestPath, invalidManifest);
    const initializeState = spyOn(StateManager.prototype, "initialize");
    try {
      runtime = makeRuntime();
      await expect(runtime.start()).rejects.toThrow();
      expect(initializeState).not.toHaveBeenCalled();
      expect(fs.readFileSync(statePath, "utf8")).toBe(stateBefore);
      expect(fs.readFileSync(manifestPath, "utf8")).toBe(invalidManifest);
      expect(fs.existsSync(path.join(execDir, ".hankweave", "events"))).toBe(false);
      expect(fs.existsSync(path.join(execDir, ".hankweave", "runtime.lock"))).toBe(false);
    } finally {
      initializeState.mockRestore();
    }
  });
});
