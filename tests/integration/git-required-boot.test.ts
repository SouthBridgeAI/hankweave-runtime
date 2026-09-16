/**
 * git is mandatory. Checkpoints, rollback, and crash recovery are all built
 * on the shadow git repository, so a machine without git must fail the boot
 * loudly instead of the old behaviour: log "Checkpointing disabled" and run
 * on without a single save point.
 *
 * Two layers assert it: `assertGitAvailable()` (what the CLI runs before the
 * execution directory is created, wiped, or copied into) and
 * `HankweaveRuntime.start()`, which must reject before it initializes state,
 * the event journal, or the WebSocket server.
 *
 * "No git" is simulated by pointing PATH at an empty directory for the
 * duration of a test; `spawn` inherits `process.env`, so the lookup fails
 * with ENOENT the same way it does on a bare host.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertGitAvailable, GitUnavailableError } from "../../server/checkpoint-git.js";
import { HankweaveRuntime } from "../../server/hankweave-runtime.js";

const savedPath = process.env.PATH;
let emptyBinDir: string;

const hideGit = () => {
  process.env.PATH = emptyBinDir;
};
const restoreGit = () => {
  process.env.PATH = savedPath;
};

beforeEach(() => {
  emptyBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "hw-no-git-"));
});

afterEach(() => {
  restoreGit();
  fs.rmSync(emptyBinDir, { recursive: true, force: true });
});

describe("assertGitAvailable", () => {
  test("resolves when git is on PATH", async () => {
    await expect(assertGitAvailable()).resolves.toBeUndefined();
  });

  test("throws GitUnavailableError, naming the fix, when git cannot be run", async () => {
    hideGit();
    const error = await assertGitAvailable().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitUnavailableError);
    const message = (error as Error).message;
    expect(message).toContain("git is required");
    expect(message).toContain("Install git");
    // The spawn failure is preserved for anyone who needs the OS's reason.
    expect((error as Error).cause).toBeDefined();
  });
});

describe("HankweaveRuntime.start() without git", () => {
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

  test("rejects with GitUnavailableError before touching state, journal, or lock", async () => {
    runtime = makeRuntime();
    hideGit();
    const error = await runtime.start().catch((e: unknown) => e);
    restoreGit();

    expect(error).toBeInstanceOf(GitUnavailableError);
    // Nothing downstream of the git check ran: no journal, no state file, no lock.
    expect(fs.existsSync(path.join(execDir, ".hankweave", "events"))).toBe(false);
    expect(fs.existsSync(path.join(execDir, ".hankweave", "state.json"))).toBe(false);
    expect(fs.existsSync(path.join(execDir, ".hankweave", "runtime.lock"))).toBe(false);
    expect(fs.existsSync(path.join(execDir, ".hankweave", "checkpoints"))).toBe(false);
  });
});
