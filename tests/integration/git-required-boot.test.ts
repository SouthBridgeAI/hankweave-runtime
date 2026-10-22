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
import { ExecutionLayout } from "../../server/execution-layout.js";
import {
  assertGitAvailable,
  GitMissingError,
  resetGitProbeForTests,
} from "../../server/git-support.js";
import { HankweaveRuntime } from "../../server/hankweave-runtime.js";
import { RuntimeLock } from "../../server/runtime-lock.js";
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
  let lock: RuntimeLock | undefined;

  const makeRuntime = (lock: RuntimeLock): HankweaveRuntime =>
    new HankweaveRuntime(
      {
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
      },
      lock,
    );

  beforeEach(() => {
    fs.mkdirSync(path.resolve("tests", "test-area"), { recursive: true });
    execDir = fs.mkdtempSync(path.resolve("tests", "test-area", "rt-no-git-"));
    fs.mkdirSync(path.join(execDir, ".hankweave", "logs"), { recursive: true });
  });

  afterEach(async () => {
    // These tests reject before opening a server or journal, or exercise
    // start()'s own failure cleanup, so no additional shutdown is needed.
    runtime = undefined;
    await lock?.release();
    lock = undefined;
    fs.rmSync(execDir, { recursive: true, force: true });
  });

  function expectNoRuntimeWrites(): void {
    expect(fs.readdirSync(execDir, { recursive: true }).sort()).toEqual([
      ".hankweave",
      path.join(".hankweave", "logs"),
    ]);
  }

  async function expectStartupRejectedWithoutWrites(runtime: HankweaveRuntime, message: string) {
    const entries = fs.readdirSync(execDir, { recursive: true }).sort();
    const logPath = path.join(execDir, ".hankweave", "logs", "server.log");
    const logBefore = fs.readFileSync(logPath, "utf8");
    const starting = runtime.start();
    // Check before yielding to the constructor's background provider checks:
    // startup must reject immediately, before its logging or protected writes.
    expect(fs.readdirSync(execDir, { recursive: true }).sort()).toEqual(entries);
    expect(fs.readFileSync(logPath, "utf8")).toBe(logBefore);
    await expect(starting).rejects.toThrow(message);
  }

  test("construction requires a lease even for untyped callers", () => {
    // @ts-expect-error Deliberately exercise an untyped caller omitting the lease.
    expect(() => makeRuntime()).toThrow("requires a held execution lease");
    expectNoRuntimeWrites();
  });

  test("construction rejects another execution's lease before any writes", async () => {
    lock = await RuntimeLock.acquire(path.join(execDir, "other"));
    // Acquiring an in-directory lease creates its execution directory. Only
    // construction of the mismatched runtime must leave this snapshot intact.
    const entries = fs.readdirSync(execDir, { recursive: true }).sort();
    expect(() => makeRuntime(lock as RuntimeLock)).toThrow("does not cover");
    expect(fs.readdirSync(execDir, { recursive: true }).sort()).toEqual(entries);
    await lock.release();
  });

  test("construction rejects a released lease before any writes", async () => {
    lock = await RuntimeLock.acquire(execDir);
    await lock.release();
    expect(() => makeRuntime(lock as RuntimeLock)).toThrow("releasing or released");
    expectNoRuntimeWrites();
  });

  test("startup rejects a lease whose release began after construction", async () => {
    lock = await RuntimeLock.acquire(execDir);
    runtime = makeRuntime(lock);
    const releasing = lock.release();
    await expectStartupRejectedWithoutWrites(runtime, "releasing or released");
    await releasing;
  });

  test("startup rechecks the configured execution path before any writes", async () => {
    lock = await RuntimeLock.acquire(execDir);
    runtime = makeRuntime(lock);
    runtime.config.executionPath = path.join(execDir, "other");
    await expectStartupRejectedWithoutWrites(runtime, "does not cover");
  });

  test("rejects with GitMissingError before touching state or journal", async () => {
    lock = await RuntimeLock.acquire(execDir);
    runtime = makeRuntime(lock);
    hideGit();
    const error = await runtime.start().catch((e: unknown) => e);
    restoreGit();

    expect(error).toBeInstanceOf(GitMissingError);
    // Nothing downstream of the git check ran: no journal or state file.
    expect(fs.existsSync(path.join(execDir, ".hankweave", "events"))).toBe(false);
    expect(fs.existsSync(path.join(execDir, ".hankweave", "state.json"))).toBe(false);
    expect(fs.existsSync(path.join(execDir, ".hankweave", "checkpoints"))).toBe(false);
  });

  test("the command acquires before constructing a competing runtime", async () => {
    const incumbent = await RuntimeLock.acquire(execDir);
    expect(fs.statSync(new ExecutionLayout(execDir).runtimeLockPath).isDirectory()).toBe(true);
    const open = spyOn(Workspace, "open");
    const startCommand = async () => {
      const lock = await RuntimeLock.acquire(execDir);
      try {
        await makeRuntime(lock).start();
      } finally {
        await lock.release();
      }
    };
    try {
      await expect(startCommand()).rejects.toThrow(/in use/);
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
      await incumbent.release();
    }
    expect(fs.existsSync(new ExecutionLayout(execDir).runtimeLockPath)).toBe(false);
  });

  test("a failed startup drains before the command releases ownership", async () => {
    let enter!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const open = spyOn(Workspace, "open").mockImplementation(async () => {
      enter();
      await blocked;
      throw new Error("injected startup failure");
    });
    const command = async () => {
      const lock = await RuntimeLock.acquire(execDir);
      try {
        await makeRuntime(lock).start();
      } finally {
        await lock.release();
      }
    };
    const starting = command().catch((error) => error);
    try {
      await entered;
      await expect(RuntimeLock.acquire(execDir)).rejects.toThrow(/in use/);
    } finally {
      finish();
      expect((await starting).message).toContain("injected startup failure");
      open.mockRestore();
    }
    await (await RuntimeLock.acquire(execDir)).release();
  });

  test("a malformed archive rejects opening before execution state initialization", async () => {
    const metaPath = path.join(execDir, ".hankweave", "execution-meta.json");
    fs.writeFileSync(metaPath, JSON.stringify({ version: "1.2.0", runtime: { port: 1234 } }));
    const statePath = path.join(execDir, ".hankweave", "state.json");
    const manifestPath = path.join(execDir, ".hankweave", "archive-manifest.json");
    const stateBefore = '{"unread":"execution state"}';
    const invalidManifest = '{"version":"1.0.0","entries":[{}]}';
    fs.writeFileSync(statePath, stateBefore);
    fs.writeFileSync(manifestPath, invalidManifest);
    const initializeState = spyOn(StateManager.prototype, "initialize");
    try {
      lock = await RuntimeLock.acquire(execDir);
      runtime = makeRuntime(lock);
      await expect(runtime.start()).rejects.toThrow();
      expect(initializeState).not.toHaveBeenCalled();
      expect(fs.readFileSync(statePath, "utf8")).toBe(stateBefore);
      expect(fs.readFileSync(manifestPath, "utf8")).toBe(invalidManifest);
      expect(JSON.parse(fs.readFileSync(metaPath, "utf8"))).toEqual({ version: "1.2.0" });
      expect(fs.existsSync(path.join(execDir, ".hankweave", "events"))).toBe(false);
    } finally {
      initializeState.mockRestore();
    }
  });
});
