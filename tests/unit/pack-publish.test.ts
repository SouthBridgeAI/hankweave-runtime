/**
 * Destination-alias canonicalization and publication serialization
 * (phase-2 review): the output path is vetted as a PHYSICAL location —
 * symlinked parents resolved, host-filesystem name folding caught via
 * directory-entry identity — and the bundle+sidecar pair publishes under
 * a per-hank lock so concurrent packs cannot interleave their commits.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeClosure } from "../../server/pack/closure.js";
import {
  acquirePublishLock,
  atomicPublish,
  resolveBundleDestination,
} from "../../server/pack/pack-command.js";

const FIXTURE = path.resolve(process.cwd(), "tests/fixtures/pack-fixture");

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function copyFixture(): { root: string; hankDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pack-publish-"));
  tempDirs.push(root);
  const hankDir = path.join(root, "pack-fixture");
  fs.cpSync(FIXTURE, hankDir, { recursive: true });
  return { root, hankDir };
}

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pack-publish-lock-"));
  tempDirs.push(dir);
  return dir;
}

/** Whether THIS machine's temp filesystem folds name case (default macOS
 * APFS, Windows). Decides if the case-alias vector can run for real. */
const caseInsensitiveFs = (() => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "case-probe-"));
  try {
    fs.writeFileSync(path.join(probe, "Probe.tmp"), "");
    return fs.existsSync(path.join(probe, "probe.tmp"));
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
})();

describe.skipIf(process.platform === "win32")("output destination aliasing", () => {
  it("refuses an output spelled through a symlinked parent onto pack inputs", () => {
    const { root, hankDir } = copyFixture();
    fs.symlinkSync(hankDir, path.join(root, "out-link"));
    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(true);

    // The same three guards that hold for literal spellings must hold for
    // the physical location behind a symlinked parent.
    expect(() =>
      resolveBundleDestination(closure, path.join(root, "out-link", "prompts", "codon1.md")),
    ).toThrow(/captured source file/);
    expect(() =>
      resolveBundleDestination(closure, path.join(root, "out-link", "hank.json")),
    ).toThrow(/pack input/);
    expect(() =>
      resolveBundleDestination(closure, path.join(root, "out-link", "tpl", "new.hank")),
    ).toThrow(/copy\.from tree/);
  });

  it.skipIf(!caseInsensitiveFs)(
    "refuses an output that aliases a captured source where names fold",
    () => {
      const { hankDir } = copyFixture();
      const closure = computeClosure(hankDir);
      expect(closure.ok).toBe(true);
      // "CODON1.MD" and the captured codon1.md are the same directory
      // entry here — the rename would destroy the input. No string
      // comparison sees it; the lstat-identity check must.
      expect(() =>
        resolveBundleDestination(closure, path.join(hankDir, "prompts", "CODON1.MD")),
      ).toThrow(/captured source file|pack input/);
    },
  );

  it("still allows an ordinary overwrite of a previous bundle", () => {
    const { root, hankDir } = copyFixture();
    const out = path.join(root, "bundle.hank");
    fs.writeFileSync(out, "old bundle bytes");
    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(true);
    expect(resolveBundleDestination(closure, out)).toBe(fs.realpathSync.native(out));
  });
});

describe("atomic publication (phase-2 issue 04)", () => {
  it("a mid-write failure leaves the existing destination intact and no staging litter", () => {
    const dir = tempDir();
    const dest = path.join(dir, "bundle.hank");
    fs.writeFileSync(dest, "previous bundle bytes");

    // Inject the crash INSIDE the staging write — after the staging file
    // exists, before any byte could reach the destination.
    const spy = spyOn(fs, "writeSync").mockImplementation(() => {
      throw new Error("injected disk failure");
    });
    try {
      expect(() => atomicPublish(dest, Buffer.from("new bundle bytes"))).toThrow(
        "injected disk failure",
      );
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(dest, "utf8")).toBe("previous bundle bytes");
    expect(fs.readdirSync(dir)).toEqual(["bundle.hank"]);
  });

  it("a failed commit rename cleans up the staging file and touches nothing else", () => {
    const dir = tempDir();
    const dest = path.join(dir, "occupied.hank");
    // A directory at the destination makes the final rename itself fail —
    // a real commit-point failure, no mocking.
    fs.mkdirSync(dest);
    expect(() => atomicPublish(dest, Buffer.from("bytes"))).toThrow();
    expect(fs.statSync(dest).isDirectory()).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(["occupied.hank"]);
  });

  it("the rename is the commit: success replaces the old bytes entirely", () => {
    const dir = tempDir();
    const dest = path.join(dir, "bundle.hank");
    fs.writeFileSync(dest, "previous bundle bytes");
    atomicPublish(dest, Buffer.from("new bundle bytes"));
    expect(fs.readFileSync(dest, "utf8")).toBe("new bundle bytes");
    expect(fs.readdirSync(dir)).toEqual(["bundle.hank"]);
  });
});

describe("publication lock (phase-2 review)", () => {
  it("is exclusive while held and reusable after release", () => {
    const dir = tempDir();
    const lockPath = path.join(dir, ".hankweave-pack-lock");
    const release = acquirePublishLock(dir);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(() => acquirePublishLock(dir)).toThrow(/another hankweave pack/);
    release();
    expect(fs.existsSync(lockPath)).toBe(false);
    acquirePublishLock(dir)();
  });

  it("takes over a stale lock left by a dead process, or with garbage content", () => {
    const dir = tempDir();
    const lockPath = path.join(dir, ".hankweave-pack-lock");

    const dead = spawnSync("true").pid;
    expect(dead).toBeGreaterThan(0);
    fs.writeFileSync(lockPath, `${dead}\n`);
    const takeovers: Array<[string, number | null]> = [];
    const notify = (file: string, pid: number | null) => takeovers.push([file, pid]);
    const release = acquirePublishLock(dir, notify);
    release();
    expect(takeovers).toEqual([[lockPath, dead]]);

    for (const contents of ["not-a-pid", `${process.pid}junk`, "", "999999999999999999999"]) {
      fs.writeFileSync(lockPath, contents);
      acquirePublishLock(dir, notify)();
      expect(takeovers.at(-1)).toEqual([lockPath, null]);
    }
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
