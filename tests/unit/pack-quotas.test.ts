/**
 * Resource quotas and portable-member-name gates added in phase 2
 * (issues 10/11): oversized members are refused BEFORE their bytes are
 * read (sparse files prove no allocation happened), and names that
 * cannot extract on every supported platform (Windows reserved devices,
 * trailing dots, control characters, case-fold collisions) are
 * `non-portable-path` errors for native and extension members alike.
 */

import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  computeClosure,
  extendClosure,
  MAX_MEMBER_BYTES,
  portableNameProblem,
  RESERVED_LOCK_PATH,
} from "../../server/pack/closure.js";
import { buildLock, serializeLock } from "../../server/pack/lock.js";
import { readCanonicalTar, type TarMember, writeCanonicalTar } from "../../server/pack/tar.js";

const FIXTURE = path.resolve(process.cwd(), "tests/fixtures/pack-fixture");

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function copyFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pack-quota-"));
  tempDirs.push(root);
  const hankDir = path.join(root, "pack-fixture");
  fs.cpSync(FIXTURE, hankDir, { recursive: true });
  return hankDir;
}

describe("closure resource quotas (phase-2 issue 11)", () => {
  it("refuses an over-quota member before reading it (sparse file, no allocation)", () => {
    const hankDir = copyFixture();
    // Inside the copy tree: the loader's tree scan is lstat-only, so the
    // size gate in the walker is what must fire — before any read.
    const huge = path.join(hankDir, "tpl", "huge.bin");
    const fd = fs.openSync(huge, "w");
    fs.ftruncateSync(fd, MAX_MEMBER_BYTES + 1);
    fs.closeSync(fd);

    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(false);
    const finding = closure.findings.find((f) => f.category === "closure-too-large");
    expect(finding?.detail).toContain("huge.bin");
    expect(finding?.detail).toContain(String(MAX_MEMBER_BYTES));
  });

  it("refuses an over-quota root config before reading it", () => {
    const hankDir = copyFixture();
    // Sparse-extend hank.json past the member quota: the size gate must
    // fire on the stat, before the bytes are ever read — a read would
    // surface as invalid-json (the extension is NUL padding).
    const fd = fs.openSync(path.join(hankDir, "hank.json"), "r+");
    fs.ftruncateSync(fd, MAX_MEMBER_BYTES + 1);
    fs.closeSync(fd);

    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(false);
    const finding = closure.findings.find((f) => f.category === "closure-too-large");
    expect(finding?.where).toBe("hank.json");
    expect(closure.findings.some((f) => f.category === "invalid-json")).toBe(false);
  });

  it("refuses an over-quota global prompt before the loader reads it", () => {
    const hankDir = copyFixture();
    // The loader consumes this file's CONTENTS (loadGlobalSystemPrompt),
    // so the gate must fire before the loader runs. Making the file
    // unreadable proves it: a loader read would surface as load-error.
    const prompt = path.join(hankDir, "prompts", "global-system.md");
    const fd = fs.openSync(prompt, "r+");
    fs.ftruncateSync(fd, MAX_MEMBER_BYTES + 1);
    fs.closeSync(fd);
    fs.chmodSync(prompt, 0o000);

    const closure = computeClosure(hankDir);
    fs.chmodSync(prompt, 0o644);
    expect(closure.ok).toBe(false);
    const finding = closure.findings.find((f) => f.category === "closure-too-large");
    expect(finding?.where).toBe("globalSystemPromptFile");
    expect(finding?.detail).toContain("global-system.md");
    expect(closure.findings.some((f) => f.category === "load-error")).toBe(false);
  });

  // The reservation logic is what's under test, not the production ceiling:
  // lower the quota so the flood is a few hundred files, not MAX_MEMBERS+2
  // (which timed out on the Windows runner).
  it("reserves the member quota while walking a copy tree, before each read", () => {
    const maxMembers = 200;
    const hankDir = copyFixture();
    const flood = path.join(hankDir, "tpl", "flood");
    fs.mkdirSync(flood);
    for (let i = 0; i <= maxMembers; i++) {
      fs.writeFileSync(path.join(flood, `f${String(i).padStart(6, "0")}`), "");
    }
    // The LAST name in walk order is unreadable: the count reservation
    // must refuse the tree before this file is ever opened — buffering
    // first and accounting later would surface it as missing-file instead.
    const last = path.join(flood, "zz-unreadable");
    fs.writeFileSync(last, "x");
    fs.chmodSync(last, 0o000);

    const closure = computeClosure(hankDir, { quotas: { maxMembers } });
    fs.chmodSync(last, 0o644);
    expect(closure.ok).toBe(false);
    expect(
      closure.findings.some(
        (f) => f.category === "closure-too-large" && f.detail.includes(`${maxMembers} members`),
      ),
    ).toBe(true);
    expect(closure.findings.some((f) => f.detail.includes("unreadable"))).toBe(false);
  });

  // The reader charges the same quotas as the walk, but pack prepends
  // hank.lock to the closure: a closure exactly at quota must round-trip,
  // and the lock must not buy a closure member past it.
  it("reads back a bundle whose closure sits exactly at the member and byte quotas", () => {
    const hankDir = copyFixture();
    const probe = computeClosure(hankDir);
    expect(probe.ok).toBe(true);
    const quotas = {
      maxMembers: probe.files.length,
      maxTotalBytes: probe.files.reduce((sum, entry) => sum + entry.bytes.length, 0),
    };
    for (const under of [
      { maxMembers: quotas.maxMembers - 1 },
      { maxTotalBytes: quotas.maxTotalBytes - 1 },
    ]) {
      const tight = computeClosure(hankDir, { quotas: under });
      expect(tight.ok).toBe(false);
      expect(tight.findings.some((f) => f.category === "closure-too-large")).toBe(true);
    }
    const closure = computeClosure(hankDir, { quotas });
    expect(closure.ok).toBe(true);

    const lockBytes = Buffer.from(serializeLock(buildLock(closure)), "utf8");
    const members: TarMember[] = [
      { path: RESERVED_LOCK_PATH, bytes: lockBytes, mode: "644" },
      ...closure.files.map((entry) => ({
        path: entry.bundlePath,
        bytes: entry.bytes,
        mode: entry.mode,
      })),
    ];
    const tar = writeCanonicalTar(members);
    const full = { ...quotas, maxMemberBytes: MAX_MEMBER_BYTES };
    expect(readCanonicalTar(tar, full).map((m) => m.path)).toEqual(members.map((m) => m.path));
    expect(() => readCanonicalTar(tar, { ...full, maxMembers: quotas.maxMembers - 1 })).toThrow(
      "maxMembers",
    );
    expect(() =>
      readCanonicalTar(tar, { ...full, maxTotalBytes: quotas.maxTotalBytes - 1 }),
    ).toThrow("maxTotalBytes");
    // The exemption is for the leading lock only: a lock-named member
    // elsewhere, or an oversized lock, is still refused.
    expect(() => readCanonicalTar(tar, { ...full, maxMemberBytes: lockBytes.length - 1 })).toThrow(
      "maxMemberBytes",
    );
    const lockLast = writeCanonicalTar([...members.slice(1), members[0]]);
    expect(() => readCanonicalTar(lockLast, full)).toThrow("maxMembers");
  });
});

describe("portable member names (phase-2 issue 10)", () => {
  it("classifies the name vectors", () => {
    expect(portableNameProblem("prompts/a.md")).toBeNull();
    expect(portableNameProblem("..templates/a.md")).toBeNull(); // dots inside names are fine
    expect(portableNameProblem("a\\b")).toMatch(/backslash/);
    expect(portableNameProblem("a\nb")).toMatch(/control characters/);
    expect(portableNameProblem("a\u001bb")).toMatch(/control characters/);
    expect(portableNameProblem("tpl/CON")).toMatch(/reserved device name/);
    expect(portableNameProblem("tpl/con.txt")).toMatch(/reserved device name/);
    expect(portableNameProblem("tpl/aux.md")).toMatch(/reserved device name/);
    expect(portableNameProblem("tpl/lpt9")).toMatch(/reserved device name/);
    expect(portableNameProblem("tpl/console.md")).toBeNull(); // prefix, not the device
    expect(portableNameProblem("tpl/trailing.")).toMatch(/dot or space/);
    expect(portableNameProblem("tpl/trailing ")).toMatch(/dot or space/);
    // Win32 filename components cannot contain : * ? " < > | — legal POSIX
    // names, but the bundle could not be faithfully extracted on Windows.
    expect(portableNameProblem("a:b")).toMatch(/reserved on Windows/);
    expect(portableNameProblem("a*b")).toMatch(/reserved on Windows/);
    expect(portableNameProblem("a?b")).toMatch(/reserved on Windows/);
    expect(portableNameProblem('a"b')).toMatch(/reserved on Windows/);
    expect(portableNameProblem("a<b>c")).toMatch(/reserved on Windows/);
    expect(portableNameProblem("a|b")).toMatch(/reserved on Windows/);
  });

  it("rejects a Windows-reserved filename swept in by a copy tree", () => {
    const hankDir = copyFixture();
    fs.writeFileSync(path.join(hankDir, "tpl", "con.md"), "device name\n");
    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(false);
    expect(
      closure.findings.some(
        (f) => f.category === "non-portable-path" && f.detail.includes("con.md"),
      ),
    ).toBe(true);
  });

  it("rejects an extension member that case-collides with a native member", () => {
    const closure = computeClosure(FIXTURE);
    expect(closure.ok).toBe(true);
    expect(() =>
      extendClosure(closure, [
        { bundlePath: "PROMPTS/CODON1.MD", bytes: Buffer.from("x\n", "utf8") },
      ]),
    ).toThrow(/case-insensitive/);
    // And two additions colliding by case with each other.
    expect(() =>
      extendClosure(closure, [
        { bundlePath: "extra/Notes.md", bytes: Buffer.from("x\n", "utf8") },
        { bundlePath: "extra/notes.md", bytes: Buffer.from("y\n", "utf8") },
      ]),
    ).toThrow(/case-insensitive/);
  });

  it("rejects an extension member with a reserved or control-character name", () => {
    const closure = computeClosure(FIXTURE);
    expect(closure.ok).toBe(true);
    const bytes = Buffer.from("x\n", "utf8");
    expect(() => extendClosure(closure, [{ bundlePath: "aux.txt", bytes }])).toThrow(
      /reserved device name/,
    );
    expect(() => extendClosure(closure, [{ bundlePath: "a\nb.txt", bytes }])).toThrow(
      /control characters/,
    );
    expect(() => extendClosure(closure, [{ bundlePath: "notes.txt ", bytes }])).toThrow(
      /dot or space/,
    );
  });
});
