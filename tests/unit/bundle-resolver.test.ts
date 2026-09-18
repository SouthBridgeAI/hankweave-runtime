import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BundleError,
  bundleExtractionRoot,
  resolveBundleHank,
} from "../../server/bundle-resolver.js";
import { computeClosure, MAX_ARCHIVE_BYTES, sha256Hex } from "../../server/pack/closure.js";
import { buildLock, computeBundleHash, serializeLock } from "../../server/pack/lock.js";
import type { HankLock } from "../../server/pack/lock-schema.js";
import { type TarMember, writeCanonicalTar } from "../../server/pack/tar.js";
import { zstdCompress } from "../../server/pack/zstd.js";

const dirs: string[] = [];
const closure = computeClosure(path.resolve("tests/fixtures/pack-fixture"));
const template = buildLock(closure, { minRuntime: "0.0.0" });
const fixtureMembers = closure.files.map((f) => ({
  path: f.bundlePath,
  bytes: f.bytes,
  mode: f.mode,
}));
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-test-"));
  dirs.push(dir);
  return dir;
}
function archive(
  lock: HankLock = structuredClone(template),
  members: TarMember[] = fixtureMembers,
): string {
  return rawArchive([
    { path: "hank.lock", bytes: Buffer.from(serializeLock(lock)), mode: "644" },
    ...members,
  ]);
}
function rawArchive(members: TarMember[]): string {
  const file = path.join(temp(), "fixture.hank");
  fs.writeFileSync(file, zstdCompress(writeCanonicalTar(members)));
  return file;
}
async function resolve(file: string) {
  const resolved = await resolveBundleHank(file);
  dirs.push(resolved.hankDir);
  return resolved;
}
async function refused(file: string, reason: string): Promise<void> {
  const mkdir = spyOn(fs, "mkdtempSync");
  try {
    await expect(resolveBundleHank(file)).rejects.toThrow(BundleError);
    await expect(resolveBundleHank(file)).rejects.toThrow(reason);
    await expect(resolveBundleHank(file)).rejects.toThrow(file);
    expect(mkdir).not.toHaveBeenCalled();
  } finally {
    mkdir.mockRestore();
  }
}

describe("bundle verification and content-addressed extraction", () => {
  it("verifies a real packed closure and preserves bytes and modes at the bundle's content address", async () => {
    const file = archive();
    const first = await resolve(file);
    expect(first.hankDir).toBe(path.join(bundleExtractionRoot(), template.bundleHash));
    expect(first.extraction).toBe("fresh");
    expect(first.bundlePath).toBe(path.resolve(file));
    expect(first.bundleHash).toBe(template.bundleHash);
    for (const member of fixtureMembers) {
      const target = path.join(first.hankDir, member.path);
      expect(fs.readFileSync(target)).toEqual(Buffer.from(member.bytes));
      if (process.platform !== "win32")
        expect(fs.statSync(target).mode & 0o777).toBe(Number.parseInt(member.mode, 8));
    }
    if (process.platform !== "win32") expect(fs.statSync(first.hankDir).mode & 0o777).toBe(0o700);
    expect(fs.existsSync(path.join(first.hankDir, "hank.lock"))).toBe(true);
    const second = await resolve(file);
    expect(second.hankDir).toBe(first.hankDir);
    expect(second.extraction).toBe("reused");
  });
  it("recreates a removed extraction at the same path, so persisted plan paths resolve again", async () => {
    const file = archive();
    const first = await resolve(file);
    const promptPath = path.join(first.hankDir, fixtureMembers[0].path);
    fs.rmSync(first.hankDir, { recursive: true, force: true });
    const second = await resolve(file);
    expect(second.hankDir).toBe(first.hankDir);
    expect(second.extraction).toBe("fresh");
    expect(fs.readFileSync(promptPath)).toEqual(Buffer.from(fixtureMembers[0].bytes));
  });
  it("repairs an extraction that would no longer pack to the bundle", async () => {
    const file = archive();
    const first = await resolve(file);
    const edited = path.join(first.hankDir, fixtureMembers[0].path);
    fs.chmodSync(edited, 0o644);
    fs.writeFileSync(edited, "edited on disk");
    const repaired = await resolve(file);
    expect(repaired.hankDir).toBe(first.hankDir);
    expect(repaired.extraction).toBe("repaired");
    expect(fs.readFileSync(edited)).toEqual(Buffer.from(fixtureMembers[0].bytes));
    // A stray file inside a copied tree would reach the rig, so it is repaired away.
    const strayInTree = path.join(first.hankDir, "tpl", "stray.txt");
    fs.writeFileSync(strayInTree, "not in the bundle");
    expect((await resolve(file)).extraction).toBe("repaired");
    expect(fs.existsSync(strayInTree)).toBe(false);
    // A file nothing references never reaches a run: the closure ignores it.
    fs.writeFileSync(path.join(first.hankDir, "unreferenced.txt"), "harmless");
    expect((await resolve(file)).extraction).toBe("reused");
    fs.rmSync(path.join(first.hankDir, "prompts"), { recursive: true, force: true });
    expect((await resolve(file)).extraction).toBe("repaired");
    if (process.platform !== "win32") {
      fs.chmodSync(edited, fixtureMembers[0].mode === "755" ? 0o644 : 0o755);
      expect((await resolve(file)).extraction).toBe("repaired");
    }
    expect(fs.readdirSync(bundleExtractionRoot()).filter((n) => n.startsWith(".staging-"))).toEqual(
      [],
    );
    // Seven resolves, each running the closure walker (git init + git
    // check-ignore for ignore rules, ~0.75 s apiece); the default 5 s
    // timeout is not enough.
  }, 30_000);
  it("refuses missing, irregular, oversized and non-zstd input", async () => {
    await refused(path.join(temp(), "missing.hank"), "does not exist");
    await refused(temp(), "not a regular file");
    const file = path.join(temp(), "bad.hank");
    fs.writeFileSync(file, "garbage");
    await refused(file, "not a zstd archive");
    fs.truncateSync(file, MAX_ARCHIVE_BYTES + 1);
    await refused(file, "archive exceeds");
  });
  it("refuses malformed tar and lock ordering/schema", async () => {
    const file = archive();
    fs.writeFileSync(file, zstdCompress(Buffer.from("bad tar")));
    await refused(file, "block-aligned");
    await refused(rawArchive(fixtureMembers), "first bundle member");
    await refused(
      rawArchive([{ path: "hank.lock", bytes: Buffer.from("{}"), mode: "644" }]),
      "Required",
    );
    const lock = { ...template, unexpected: true };
    await refused(archive(lock), "Unrecognized key");
  });
  it.each([
    "../escape",
    "/absolute",
    "a/../b",
    "a//b",
    "./a",
    "a/",
    "a\\b",
    "C:/a",
    ".git/config",
    "a/.GIT/config",
    "hank.lock",
    "CON.txt",
    "x.",
    "a\0b",
  ])("refuses unsafe lock key %s before extraction", async (key) => {
    const lock = structuredClone(template);
    lock.files[key] = lock.files["hank.json"];
    await refused(archive(lock), key.includes("\0") ? "control characters" : key);
  });
  it("requires hank.json and the exact lock member set", async () => {
    const lock = structuredClone(template);
    delete lock.files["hank.json"];
    await refused(archive(lock), "missing hank.json");
    await refused(archive(template, fixtureMembers.slice(1)), fixtureMembers[0].path);
    await refused(
      archive(template, [
        ...fixtureMembers,
        { path: "extra", bytes: Buffer.alloc(0), mode: "644" },
      ]),
      "extra member extra",
    );
  });
  it("names content/mode tampering and stale identity hashes", async () => {
    const tampered = fixtureMembers.map((m) => ({ ...m }));
    tampered[0].bytes = Buffer.from("tampered");
    await refused(archive(template, tampered), `${tampered[0].path}: does not match hank.lock`);
    tampered[0] = { ...fixtureMembers[0], mode: fixtureMembers[0].mode === "644" ? "755" : "644" };
    await refused(archive(template, tampered), "mode");
    const lock = structuredClone(template);
    tampered[0] = { ...fixtureMembers[0], bytes: Buffer.from("consistent new content") };
    lock.files[tampered[0].path].sha256 = sha256Hex(tampered[0].bytes);
    await refused(archive(lock, tampered), "bundleHash does not match");
    lock.bundleHash = computeBundleHash({ v: 1, files: lock.files, runtime: lock.runtime });
    const accepted = await resolve(archive(lock, tampered));
    expect(fs.readFileSync(path.join(accepted.hankDir, tampered[0].path), "utf8")).toBe(
      "consistent new content",
    );
  });
  it("accepts a fully recomputed identity and own __proto__ member", async () => {
    const lock = structuredClone(template);
    lock.files = Object.assign(Object.create(null), lock.files);
    const bytes = Buffer.from("authored file");
    lock.files.__proto__ = { mode: "644", sha256: sha256Hex(bytes) };
    lock.bundleHash = computeBundleHash({ v: 1, files: lock.files, runtime: lock.runtime });
    const resolved = await resolve(
      archive(lock, [...fixtureMembers, { path: "__proto__", bytes, mode: "644" }]),
    );
    expect(fs.readFileSync(path.join(resolved.hankDir, "__proto__"))).toEqual(bytes);
  });
  it("gates a newer runtime before creating a directory", async () => {
    const lock = structuredClone(template);
    lock.runtime.min = "999999.0.0";
    lock.bundleHash = computeBundleHash({ v: 1, files: lock.files, runtime: lock.runtime });
    await refused(archive(lock), "bundle requires hankweave ≥ 999999.0.0");
  });
  it("removes only its partial extraction and names the failing member", async () => {
    const lock = structuredClone(template);
    const bytes = Buffer.from("collision");
    const members = [
      ...fixtureMembers,
      { path: "collision", bytes, mode: "644" as const },
      { path: "collision/child", bytes, mode: "644" as const },
    ];
    for (const m of members.slice(-2))
      lock.files[m.path] = { mode: m.mode, sha256: sha256Hex(m.bytes) };
    lock.bundleHash = computeBundleHash({ v: 1, files: lock.files, runtime: lock.runtime });
    const file = archive(lock);
    fs.writeFileSync(
      file,
      zstdCompress(
        writeCanonicalTar([
          { path: "hank.lock", bytes: Buffer.from(serializeLock(lock)), mode: "644" },
          ...members,
        ]),
      ),
    );
    const mkdir = spyOn(fs, "mkdtempSync");
    try {
      await expect(resolveBundleHank(file)).rejects.toThrow("collision/child: extraction failed");
      const extracted = mkdir.mock.results[0].value as string;
      expect(fs.existsSync(extracted)).toBe(false);
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      mkdir.mockRestore();
    }
  });
});
