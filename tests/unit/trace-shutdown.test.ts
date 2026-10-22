import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExecutionLayout } from "../../server/execution-layout.js";
import { HankweaveRuntime, type RuntimeShutdownResult } from "../../server/hankweave-runtime.js";
import { RuntimeLock } from "../../server/runtime-lock.js";
import { ShutdownWatchdog } from "../../server/shutdown-watchdog.js";
import { createTraceSnapshot } from "../../server/trace-watcher.js";
import { Logger } from "../../server/utils.js";

let root: string;
let dir: string;
let lock: RuntimeLock;
beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trace-shutdown-")));
  dir = path.join(root, "execution");
  fs.mkdirSync(path.join(dir, ".hankweave/events"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".hankweave/state.json"), '{"runs":[]}');
  fs.writeFileSync(path.join(dir, ".hankweave/events/events.jsonl"), "event\n");
  lock = await RuntimeLock.acquire(dir);
});
afterEach(async () => {
  await lock.release();
  fs.rmSync(root, { recursive: true, force: true });
});
function runtime() {
  let finishShutdown!: (result: RuntimeShutdownResult) => void;
  const stopped = new Promise<RuntimeShutdownResult>((resolve) => {
    finishShutdown = resolve;
  });
  return Object.assign(Object.create(HankweaveRuntime.prototype), {
    stopped,
    finishShutdown,
    config: { executionPath: dir },
    logger: new Logger(path.join(dir, ".hankweave/logs/server.log")),
    watchdog: new ShutdownWatchdog({ timeoutMs: 5_000, log() {} }),
    emit() {},
    clients: new Map(),
    pendingToolUses: new Map(),
    sentinelManager: { shutdown: async () => {} },
    eventJournal: { close: async () => {} },
    stopAgentsForShutdown: async () => {},
    finalizeRunForShutdown: () => null,
    stateManager: { waitForPendingTransitions: async () => {}, getCurrentRun: () => null },
    eventJournalAppendQueue: Promise.resolve(),
    flushShutdownTelemetry: async () => {},
    closeConnectionsForShutdown() {},
    closeJournalForShutdown: async () => true,
    finalizeJournalForShutdown: async () => {},
  });
}

test("the command releases after snapshot and finalization, before uploading", async () => {
  const rt = runtime();
  const order: string[] = [];
  let snapshotPath = "";
  rt.prepareTraceUpload = async () => {
    await expect(RuntimeLock.acquire(dir)).rejects.toThrow(/in use/);
    const snapshot = await createTraceSnapshot(dir);
    snapshotPath = snapshot.executionPath;
    order.push("snapshot");
    return {
      dispose: snapshot.dispose,
      upload: async () => {
        const successor = await RuntimeLock.acquire(dir);
        try {
          fs.rmSync(dir, { recursive: true });
          expect(
            fs.readFileSync(path.join(snapshotPath, ".hankweave/events/events.jsonl"), "utf8"),
          ).toBe("event\n");
          order.push("upload");
        } finally {
          await successor.release();
        }
      },
    };
  };
  rt.finalizeJournalForShutdown = async () => {
    await expect(RuntimeLock.acquire(dir)).rejects.toThrow(/in use/);
    fs.rmSync(path.join(dir, ".hankweave/events/events.jsonl"));
    order.push("compress");
  };
  await rt.shutdown("test cleanup", false);
  const result = await rt.waitForShutdown();
  await expect(RuntimeLock.acquire(dir)).rejects.toThrow(/in use/);
  await lock.release();
  try {
    await result.trace.upload();
  } finally {
    await result.trace.dispose();
  }
  expect(order).toEqual(["snapshot", "compress", "upload"]);
  expect(fs.existsSync(dir)).toBe(false);
  expect(fs.existsSync(snapshotPath)).toBe(false);
});

test("failed snapshot still allows protected finalization to finish", async () => {
  const rt = runtime();
  rt.prepareTraceUpload = async () => {
    throw new Error("snapshot failed");
  };
  await rt.shutdown("test cleanup", false);
  expect((await rt.waitForShutdown()).trace).toBeUndefined();
});

test("failed writer drain does not report completion to the command", async () => {
  const rt = runtime();
  let completed = false;
  rt.waitForShutdown().then(() => {
    completed = true;
  });
  rt.closeJournalForShutdown = async () => false;
  await expect(rt.shutdown("test cleanup", false)).rejects.toThrow(/Journal failed to close/);
  expect(completed).toBe(false);
  await expect(RuntimeLock.acquire(dir)).rejects.toThrow(/in use/);
});

for (const forced of [false, true]) {
  test(`${forced ? "forced" : "graceful"} metadata failure settles stopped after disabling file writes`, async () => {
    const rt = runtime();
    const stopped = rt.waitForShutdown();
    rt.runtimePortsPublished = true;
    fs.writeFileSync(new ExecutionLayout(dir).metaPath, "null");
    rt.watchdog.arm("test", 0);

    const shutdown = forced
      ? rt.forceShutdown("test cleanup", false)
      : rt.shutdown("SIGINT", false);
    await expect(shutdown).rejects.toThrow("Invalid execution metadata");
    expect(await stopped).toEqual({ exitCode: 1 });
    expect(await rt.waitForShutdown()).toEqual({ exitCode: 1 });
    expect(rt.watchdog.armed).toBe(false);
    await expect(RuntimeLock.acquire(dir)).rejects.toThrow(/in use/);

    await lock.release();
    fs.rmSync(dir, { recursive: true });
    rt.logger.log("after ownership release");
    expect(fs.existsSync(dir)).toBe(false);
  });
}

test("finalization and trace disposal failures still settle stopped", async () => {
  const rt = runtime();
  let disposed = false;
  rt.prepareTraceUpload = async () => ({
    upload: async () => {},
    dispose: async () => {
      disposed = true;
      throw new Error("trace disposal failed");
    },
  });
  rt.finalizeJournalForShutdown = async () => {
    throw new Error("finalization failed");
  };
  await expect(rt.shutdown("SIGINT", false)).rejects.toThrow("trace disposal failed");
  expect(disposed).toBe(true);
  expect(await rt.waitForShutdown()).toEqual({ exitCode: 1 });
});

test("embedded force shutdown bounds a wedged graceful task without signalling safe release", async () => {
  const rt = runtime();
  let resume!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const draining = new Promise<void>((resolve) => {
    entered = resolve;
  });
  rt.stopAgentsForShutdown = async () => {
    entered();
    await paused;
  };
  // Exercise the production timeout with a short window, without global timer mocks.
  const wait = rt.waitForForcedShutdown.bind(rt);
  rt.waitForForcedShutdown = (task: Promise<void>) => wait(task, 10);
  let completed = false;
  rt.waitForShutdown().then(() => {
    completed = true;
  });
  const graceful = rt.shutdown("SIGINT", false);
  await draining;
  try {
    await expect(rt.forceShutdown("force request", false)).rejects.toThrow(
      /Force shutdown timed out.*Retain the execution lock/,
    );
    expect(completed).toBe(false);
    expect(rt.watchdog.armed).toBe(false);
    await expect(RuntimeLock.acquire(dir)).rejects.toThrow(/in use/);
  } finally {
    resume();
    await graceful;
  }
  expect(await rt.waitForShutdown()).toEqual({ exitCode: 0, trace: undefined });
});
