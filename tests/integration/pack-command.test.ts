/**
 * End-to-end `hankweave pack` gate (phase-2 plan §Gate). Drives
 * runPackCommand through the in-process entry point with a captured IO,
 * verifying: determinism (byte-identical repacks, mtime immunity), archive
 * shape (tar -tf interop, verbatim configs), lock/sidecar agreement,
 * output-destination guards, --check purity, structured findings, and
 * the snapshot contract (source mutation between closure and archive
 * cannot reach the bundle).
 */

import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { computeClosure, RESERVED_LOCK_PATH } from "../../server/pack/closure.js";
import { buildLock, serializeLock } from "../../server/pack/lock.js";
import { hankLockSchema } from "../../server/pack/lock-schema.js";
import { type PackIo, runPackCommand } from "../../server/pack/pack-command.js";
import { type TarMember, writeCanonicalTar } from "../../server/pack/tar.js";
import { systemTar } from "../helpers/system-tar.js";

const FIXTURE = path.resolve(process.cwd(), "tests/fixtures/pack-fixture");

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pack-cmd-"));
  tempDirs.push(dir);
  return dir;
}

function copyFixture(): string {
  const root = tempDir();
  const hankDir = path.join(root, "pack-fixture");
  fs.cpSync(FIXTURE, hankDir, { recursive: true });
  return hankDir;
}

interface RunResult {
  code: number;
  stdout: string[];
  stderr: string[];
}

function run(argv: string[], terminal: Partial<PackIo> = {}): RunResult {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = runPackCommand(argv, {
    ...terminal,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
  });
  return { code, stdout, stderr };
}

function listArchive(bundlePath: string): string[] {
  // zstd-compressed tar: system bsdtar reads it directly. Windows tar ends
  // listing lines with CRLF.
  return execFileSync(systemTar(), ["-tf", bundlePath], { encoding: "utf8" }).trim().split(/\r?\n/);
}

function extractMember(bundlePath: string, member: string): Buffer {
  return execFileSync(systemTar(), ["-xOf", bundlePath, member]);
}

// CLI paths use JSON escaping, including doubled Windows backslashes.
const shown = (p: string) => JSON.stringify(p).slice(1, -1);

describe("hankweave pack end-to-end", () => {
  it("packs the fixture: deterministic bytes, interop listing, verbatim config, sidecar == embedded lock", () => {
    const hankDir = copyFixture();
    const out1 = path.join(tempDir(), "one.hank");
    const out2 = path.join(tempDir(), "two.hank");

    const first = run([hankDir, "-o", out1, "--min-runtime", "1.0.0"]);
    expect(first.stderr.filter((l) => l.startsWith("Error"))).toEqual([]);
    expect(first.code).toBe(0);
    expect(first.stdout.join("\n")).toContain("Portability check");
    expect(first.stdout.join("\n")).toMatch(/0 errors · \d+ warnings/);
    // Bundle details stay on stderr.
    expect(first.stderr.join("\n")).toContain("Packed ");
    expect(first.stdout.join("\n")).not.toContain("Packed ");
    // The destination prints as typed (not realpath'd); runtime.min and the
    // sidecar path are visible. Paths render JSON-escaped (Windows backslashes).
    const details = first.stderr.join("\n");
    expect(details).toContain(`\nPacked ${shown(out1)}\n`);
    expect(details).toContain("\n  runtime.min 1.0.0 · ");
    expect(details).toContain(
      `\n  wrote hank.lock to ${shown(path.join(hankDir, RESERVED_LOCK_PATH))}`,
    );

    // mtime-only changes must not move a byte.
    const later = new Date(Date.now() + 60_000);
    for (const entry of fs.readdirSync(hankDir, { recursive: true, encoding: "utf8" })) {
      const p = path.join(hankDir, entry);
      if (fs.statSync(p).isFile()) fs.utimesSync(p, later, later);
    }
    const second = run([hankDir, "-o", out2, "--min-runtime", "1.0.0"]);
    expect(second.code).toBe(0);
    expect(fs.readFileSync(out1).equals(fs.readFileSync(out2))).toBe(true);

    // Interop: system tar lists hank.lock first, then sorted members.
    const listing = listArchive(out1);
    expect(listing[0]).toBe("hank.lock");
    expect(listing).toContain("hank.json");
    expect(listing).toContain("prompts/codon1.md");
    expect(listing).toContain("tpl/bin/run.sh");
    const sorted = [...listing.slice(1)].sort();
    expect(listing.slice(1)).toEqual(sorted);

    // The config ships verbatim — no rewrites exist.
    expect(
      extractMember(out1, "hank.json").equals(fs.readFileSync(path.join(hankDir, "hank.json"))),
    ).toBe(true);

    // Sidecar lock is byte-identical to the embedded lock and validates
    // against the one authoritative schema.
    const sidecar = fs.readFileSync(path.join(hankDir, RESERVED_LOCK_PATH));
    expect(extractMember(out1, "hank.lock").equals(sidecar)).toBe(true);
    const parsed = hankLockSchema.parse(JSON.parse(sidecar.toString("utf8")));
    expect(parsed.runtime.min).toBe("1.0.0");
    expect(Object.keys(parsed.files)).toContain("hank.json");

    // Codon-scoped invalidation on a real repack: touch one prompt's
    // CONTENT and only the codons referencing it change digests.
    fs.appendFileSync(path.join(hankDir, "prompts/codon1.md"), "\nchanged\n");
    const out3 = path.join(tempDir(), "three.hank");
    expect(run([hankDir, "-o", out3, "--min-runtime", "1.0.0"]).code).toBe(0);
    const lock3 = hankLockSchema.parse(
      JSON.parse(fs.readFileSync(path.join(hankDir, RESERVED_LOCK_PATH), "utf8")),
    );
    expect(lock3.bundleHash).not.toBe(parsed.bundleHash);
    const changed = Object.keys(parsed.codonInputs).filter(
      (key) => parsed.codonInputs[key] !== lock3.codonInputs[key],
    );
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.length).toBeLessThan(Object.keys(parsed.codonInputs).length);
  });

  it.each(["644", "755"])(
    "redirected output shows the published members and preserves archive bytes (mode %s)",
    (mode) => {
      const hankDir = copyFixture();
      const scriptPath = path.join(hankDir, "tpl/bin/run.sh");
      fs.chmodSync(scriptPath, Number.parseInt(mode, 8));
      const prettyPath = path.join(tempDir(), "pretty.hank");
      const terminalPath = path.join(tempDir(), "terminal.hank");
      const pretty = run([hankDir, "-o", prettyPath]);
      const terminal = run([hankDir, "-o", terminalPath], { stdoutIsTTY: true, stderrIsTTY: true });
      expect(pretty.code).toBe(0);
      expect(terminal.code).toBe(0);
      expect(fs.readFileSync(prettyPath).equals(fs.readFileSync(terminalPath))).toBe(true);
      expect(pretty.stdout.join("\n")).toContain("Portability check");
      const tree = pretty.stderr.join("\n");
      expect(tree).toContain("Packed ");
      expect(tree).toContain("├── ");
      expect(tree).toContain("hank.lock");
      // Windows does not preserve POSIX execute bits, even after chmod(755).
      // Match the actual fixture mode; renderer unit tests cover 755 on every OS.
      const scriptIsExecutable = (fs.statSync(scriptPath).mode & 0o111) !== 0;
      expect(tree.includes(" · executable")).toBe(scriptIsExecutable);
      const listing = listArchive(prettyPath);
      for (const member of listing) expect(tree).toContain(path.basename(member));
      expect(tree).toContain(`${listing.length} files`);
      expect(tree).toContain(
        JSON.parse(extractMember(prettyPath, "hank.lock").toString()).bundleHash,
      );
      expect(terminal.stderr.join("\n")).toContain("├──");
    },
  );

  it("uses the same structured layout on terminals and pipes, with --check writing nothing", () => {
    const hankDir = copyFixture();
    const terminal = run([hankDir, "--check"], { stdoutIsTTY: true, stderrIsTTY: true });
    const piped = run([hankDir, "--check"]);
    expect(piped.stdout.join("\n")).toContain("Portability check");
    expect(stripVTControlCharacters(terminal.stdout.join("\n"))).toBe(
      stripVTControlCharacters(piped.stdout.join("\n")),
    );
    expect(terminal.stderr).toEqual([]);
    expect(piped.stderr).toEqual([]);
    expect(fs.existsSync(path.join(hankDir, "hank.lock"))).toBe(false);
  });

  it("pretty lint failures and publication failures never show a success tree", () => {
    const hankDir = copyFixture();
    const failedPublish = run([hankDir, "-o", path.join(hankDir, "missing", "out.hank")]);
    expect(failedPublish.code).toBe(1);
    expect(failedPublish.stderr.join("\n")).not.toContain("Packed ");
    fs.rmSync(path.join(hankDir, "prompts/codon1.md"));
    const failedLint = run([hankDir]);
    expect(failedLint.code).toBe(1);
    expect(failedLint.stdout.join("\n")).toContain("ERROR missing-file");
    expect(failedLint.stderr).toEqual([]);
    expect(fs.existsSync(path.join(hankDir, "hank.lock"))).toBe(false);
  });

  it("--check prints findings and writes nothing", () => {
    const hankDir = copyFixture();
    const before = fs.readdirSync(hankDir, { recursive: true, encoding: "utf8" }).sort();
    const cwdBefore = fs.readdirSync(process.cwd()).sort();

    const result = run(["--check", hankDir]);
    expect(result.code).toBe(0);
    expect(result.stdout.join("\n")).toMatch(/0 errors · \d+ warnings/);
    // Warnings are expected from the fixture's rig commands.
    expect(result.stdout.join("\n")).toContain("WARN ");

    expect(fs.readdirSync(hankDir, { recursive: true, encoding: "utf8" }).sort()).toEqual(before);
    expect(fs.existsSync(path.join(hankDir, RESERVED_LOCK_PATH))).toBe(false);
    expect(fs.readdirSync(process.cwd()).sort()).toEqual(cwdBefore);
  });

  it("lint errors: exit 1, ERROR missing-file on stdout, no artifacts", () => {
    const hankDir = copyFixture();
    fs.rmSync(path.join(hankDir, "prompts/codon1.md"));
    const out = path.join(tempDir(), "broken.hank");

    const result = run([hankDir, "-o", out]);
    expect(result.code).toBe(1);
    expect(result.stdout.join("\n")).toContain("ERROR missing-file");
    expect(result.stdout.join("\n")).toMatch(/[1-9]\d* errors? · \d+ warnings?/);
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.existsSync(path.join(hankDir, RESERVED_LOCK_PATH))).toBe(false);
  });

  it("usage errors exit 2 with the error plus a --help pointer on stderr and touch nothing", () => {
    for (const argv of [["--unknown"], ["-o", "artifact"], ["a", "b"], ["--min-runtime", "v1"]]) {
      const result = run(argv);
      expect(result.code).toBe(2);
      expect(result.stdout).toEqual([]);
      // Exactly two lines: the error, then where to find usage. The full
      // usage block is reserved for --help so the error is not buried.
      expect(result.stderr).toHaveLength(2);
      expect(result.stderr[0]).toStartWith("Error: ");
      expect(result.stderr[1]).toBe("Run 'hankweave pack --help' for usage.");
    }
  });

  it("invalid JSON: fixed finding on stdout, the engine's message as a note on stderr", () => {
    const hankDir = copyFixture();
    fs.writeFileSync(path.join(hankDir, "hank.json"), "{ not json");
    const result = run([hankDir, "--check"]);
    expect(result.code).toBe(1);
    const stdout = result.stdout.join("\n");
    expect(stdout).toContain("ERROR invalid-json");
    expect(stdout).toContain("• not valid JSON");
    expect(result.stderr.filter((l) => l.startsWith("note: hank.json: "))).toHaveLength(1);
  });

  it("pack --help prints usage and exits 0 without reading a hank", () => {
    const result = run(["--help"]);
    expect(result.code).toBe(0);
    const help = result.stdout.join("\n");
    expect(help).toContain("Usage: hankweave pack");
    expect(help).toContain("--no-lock");
    expect(help).toContain("hank.lock next to hank.json");
    expect(help).toContain("Commit hank.lock");
  });

  it("refuses an output destination that aliases a pack input", () => {
    const hankDir = copyFixture();
    const configBytes = fs.readFileSync(path.join(hankDir, "hank.json"));

    // Destination = source config (suffix rule requires .hank, so route
    // through the sidecar and copy-tree guards, which .hank names can hit).
    const insideCopyRoot = path.join(hankDir, "tpl", "evil.hank");
    const result = run([hankDir, "-o", insideCopyRoot]);
    expect(result.code).toBe(1);
    expect(result.stderr.some((l) => l.includes("copy.from tree"))).toBe(true);
    expect(fs.existsSync(insideCopyRoot)).toBe(false);
    // No source mutation happened.
    expect(fs.readFileSync(path.join(hankDir, "hank.json")).equals(configBytes)).toBe(true);
  });

  it("refuses a directory destination and a missing parent directory", () => {
    const hankDir = copyFixture();
    const dirTarget = path.join(tempDir(), "iamdir.hank");
    fs.mkdirSync(dirTarget);
    expect(run([hankDir, "-o", dirTarget]).code).toBe(1);
    expect(fs.statSync(dirTarget).isDirectory()).toBe(true);

    const missingParent = path.join(tempDir(), "no-such-dir", "out.hank");
    const result = run([hankDir, "-o", missingParent]);
    expect(result.code).toBe(1);
    expect(result.stderr.some((l) => l.includes("does not exist"))).toBe(true);
  });

  it("atomically replaces an existing bundle file; a failed pack leaves it intact", () => {
    const hankDir = copyFixture();
    const out = path.join(tempDir(), "replace.hank");
    expect(run([hankDir, "-o", out, "--min-runtime", "1.0.0"]).code).toBe(0);
    const good = fs.readFileSync(out);

    // Break the hank; repack to the same destination fails at lint, and
    // the previous artifact is byte-for-byte intact.
    fs.rmSync(path.join(hankDir, "prompts/codon1.md"));
    expect(run([hankDir, "-o", out]).code).toBe(1);
    expect(fs.readFileSync(out).equals(good)).toBe(true);

    // No staging litter in the destination directory.
    const siblings = fs.readdirSync(path.dirname(out));
    expect(siblings.filter((name) => name.includes("staging"))).toEqual([]);
  });

  it("refuses to publish while another live process holds the pack lock, then takes over once it dies", async () => {
    const hankDir = copyFixture();
    const out = path.join(tempDir(), "locked.hank");
    const lockPath = path.join(hankDir, ".hankweave-pack-lock");

    // A genuinely live OTHER process holds the lock.
    const holder = Bun.spawn(["sleep", "30"]);
    fs.writeFileSync(lockPath, `${holder.pid}\n`);
    try {
      const refused = run([hankDir, "-o", out, "--min-runtime", "1.0.0"]);
      expect(refused.code).toBe(1);
      expect(refused.stderr.some((l) => l.includes("another hankweave pack"))).toBe(true);
      // Nothing published: no bundle, no sidecar, and the holder's lock
      // file is untouched.
      expect(fs.existsSync(out)).toBe(false);
      expect(fs.existsSync(path.join(hankDir, "hank.lock"))).toBe(false);
      expect(fs.readFileSync(lockPath, "utf8")).toBe(`${holder.pid}\n`);
    } finally {
      holder.kill();
      await holder.exited;
    }
    // Wait until the pid is truly gone (child reaped) so the liveness
    // probe sees ESRCH rather than a zombie.
    for (let i = 0; i < 500; i++) {
      try {
        process.kill(holder.pid, 0);
      } catch {
        break;
      }
      await Bun.sleep(10);
    }

    // Same pid, now dead: the stale lock is taken over and the pack
    // publishes normally, removing the lock afterwards.
    fs.writeFileSync(lockPath, `${holder.pid}\n`);
    const succeeded = run([hankDir, "-o", out, "--min-runtime", "1.0.0"]);
    expect(succeeded.code).toBe(0);
    expect(succeeded.stderr.filter((l) => l.includes("took over a stale pack lock"))).toEqual([
      `took over a stale pack lock at ${shown(lockPath)}; left by dead pid ${holder.pid}`,
    ]);
    expect(fs.existsSync(lockPath)).toBe(false);
    const sidecar = fs.readFileSync(path.join(hankDir, RESERVED_LOCK_PATH));
    expect(extractMember(out, RESERVED_LOCK_PATH).equals(sidecar)).toBe(true);
  });

  it("reports unreadable contents when removing a malformed publish lock", () => {
    const hankDir = copyFixture();
    const lockPath = path.join(hankDir, ".hankweave-pack-lock");
    fs.writeFileSync(lockPath, "not a pid");
    const result = run([hankDir, "-o", path.join(tempDir(), "garbage.hank")]);
    expect(result.code).toBe(0);
    expect(result.stderr.filter((l) => l.includes("took over a stale pack lock"))).toEqual([
      `took over a stale pack lock at ${shown(lockPath)}; unreadable holder PID`,
    ]);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("--no-lock preserves existing source locks and emits the same complete bundle", () => {
    const hankDir = copyFixture();
    const normalOut = path.join(tempDir(), "normal.hank");
    expect(run([hankDir, "-o", normalOut]).code).toBe(0);
    const sidecar = path.join(hankDir, RESERVED_LOCK_PATH);
    fs.writeFileSync(sidecar, "existing sidecar bytes");
    const publishLock = path.join(hankDir, ".hankweave-pack-lock");
    fs.writeFileSync(publishLock, `${process.pid}\n`);
    const before = fs.readdirSync(hankDir, { recursive: true });
    const out = path.join(tempDir(), "only.hank");
    const result = run([hankDir, "--no-lock", "-o", out]);
    expect(result.code).toBe(0);
    expect(fs.readFileSync(out).equals(fs.readFileSync(normalOut))).toBe(true);
    expect(
      hankLockSchema.safeParse(JSON.parse(extractMember(out, RESERVED_LOCK_PATH).toString()))
        .success,
    ).toBe(true);
    expect(fs.readFileSync(sidecar, "utf8")).toBe("existing sidecar bytes");
    expect(fs.readFileSync(publishLock, "utf8")).toBe(`${process.pid}\n`);
    expect(fs.readdirSync(hankDir, { recursive: true })).toEqual(before);
    expect(result.stderr.join("\n")).not.toContain("wrote hank.lock to");
  });

  // Root ignores directory permissions and Windows has no chmod-style bits.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a read-only hank directory fails with the lock file named and the reason pack needs it",
    () => {
      const hankDir = copyFixture();
      const out = path.join(tempDir(), "ro.hank");
      fs.chmodSync(hankDir, 0o555);
      try {
        const result = run([hankDir, "-o", out, "--min-runtime", "1.0.0"]);
        expect(result.code).toBe(1);
        const error = result.stderr.find((l) => l.startsWith("Error: "));
        expect(error).toContain(`cannot write ${path.join(hankDir, ".hankweave-pack-lock")}`);
        expect(error).toContain("permission denied");
        expect(error).toContain("pack writes hank.lock");
        expect(fs.existsSync(out)).toBe(false);
        const bundleOnly = run([hankDir, "--no-lock", "-o", out]);
        expect(bundleOnly.code).toBe(0);
        expect(listArchive(out)).toContain(RESERVED_LOCK_PATH);
        expect(fs.existsSync(path.join(hankDir, RESERVED_LOCK_PATH))).toBe(false);
        expect(fs.existsSync(path.join(hankDir, ".hankweave-pack-lock"))).toBe(false);
      } finally {
        fs.chmodSync(hankDir, 0o755);
      }
    },
  );

  it("snapshot contract: mutating a source file after closure never reaches the archive", () => {
    const hankDir = copyFixture();
    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(true);
    const lock = buildLock(closure, { minRuntime: "1.0.0" });

    // Overwrite a captured prompt on disk AFTER the walk.
    fs.writeFileSync(path.join(hankDir, "prompts/codon1.md"), "MUTATED AFTER CLOSURE\n");

    const members: TarMember[] = [
      { path: RESERVED_LOCK_PATH, bytes: Buffer.from(serializeLock(lock), "utf8"), mode: "644" },
      ...closure.files.map((f) => ({ path: f.bundlePath, bytes: f.bytes, mode: f.mode })),
    ];
    const tar = writeCanonicalTar(members);
    const dir = tempDir();
    const tarPath = path.join(dir, "snap.tar");
    fs.writeFileSync(tarPath, tar);
    const shipped = execFileSync(systemTar(), ["-xOf", tarPath, "prompts/codon1.md"]);
    expect(shipped.toString("utf8")).not.toContain("MUTATED");
    const expected = closure.files.find((f) => f.bundlePath === "prompts/codon1.md");
    expect(shipped.equals(expected?.bytes as Buffer)).toBe(true);
  });

  it("default output name derives from meta and lands in cwd", () => {
    const hankDir = copyFixture();
    const raw = JSON.parse(fs.readFileSync(path.join(hankDir, "hank.json"), "utf8"));
    const expectedName = `${raw.meta.name}-${raw.meta.version}.hank`;

    const cwd = tempDir();
    const previousCwd = process.cwd();
    process.chdir(cwd);
    try {
      const result = run([hankDir, "--min-runtime", "1.0.0"]);
      expect(result.code).toBe(0);
      expect(fs.existsSync(path.join(cwd, expectedName))).toBe(true);
    } finally {
      process.chdir(previousCwd);
    }
  });
});
