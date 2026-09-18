/**
 * Cross-runtime determinism check for `hankweave pack` (phase-2 gate).
 *
 * The honest scope (spec F20): `hank.lock` bytes and `bundleHash` are
 * cross-runtime identities; the CANONICAL TAR bytes are too; compressed
 * archive bytes are per-zstd-build only and are deliberately not compared.
 *
 * Run under each runtime and compare the printed identity lines:
 *   bun tests/cross-runtime/pack-bundle-hash.test.ts
 *   npx tsx tests/cross-runtime/pack-bundle-hash.test.ts
 *
 * Same checkout ⇒ every `identity:` line must match between runs.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBundleHank } from "../../server/bundle-resolver.js";
import { computeClosure, RESERVED_LOCK_PATH } from "../../server/pack/closure.js";
import { buildLock, serializeLock } from "../../server/pack/lock.js";
import { readCanonicalTar, writeCanonicalTar } from "../../server/pack/tar.js";
import { detectZstdBackend, zstdCompress } from "../../server/pack/zstd.js";

const FIXTURE = path.resolve(process.cwd(), "tests/fixtures/pack-fixture");
const sha256 = (data: Buffer | string): string =>
  crypto.createHash("sha256").update(data).digest("hex");

const closure = computeClosure(FIXTURE);
assert.equal(closure.ok, true, "fixture closure must succeed");

// Pin runtime.min so two Hankweave versions produce comparable output.
const lock = buildLock(closure, { minRuntime: "1.0.0" });
const lockBytes = Buffer.from(serializeLock(lock), "utf8");
const tar = writeCanonicalTar([
  { path: RESERVED_LOCK_PATH, bytes: lockBytes, mode: "644" },
  ...closure.files.map((f) => ({ path: f.bundlePath, bytes: f.bytes, mode: f.mode })),
]);

// Recompute once more in-process: any nondeterminism inside one runtime
// fails here without needing the second runtime at all.
const closure2 = computeClosure(FIXTURE);
assert.equal(closure2.ok, true);
const lock2 = buildLock(closure2, { minRuntime: "1.0.0" });
assert.equal(serializeLock(lock2), lockBytes.toString("utf8"), "lock bytes must be repeatable");

console.log(`identity: bundleHash ${lock.bundleHash}`);
console.log(`identity: lockSha256 ${sha256(lockBytes)}`);
console.log(`identity: tarSha256 ${sha256(tar)}`);
assert.deepEqual(writeCanonicalTar(readCanonicalTar(tar)), tar);
console.log(`identity: tarReadRoundTrip ${sha256(writeCanonicalTar(readCanonicalTar(tar)))}`);

// The read path under each runtime: a compressed bundle verifies against its
// embedded lock and extracts the exact closure bytes. The resolver enforces
// runtime.min, so this bundle carries its own lock pinned below any real
// version (the 1.0.0 lock above exists only for identity comparison).
// Runtimes without zstd (Deno) still check the format identities above.
if (detectZstdBackend()) {
  const runnableLock = buildLock(closure, { minRuntime: "0.0.0" });
  const runnableLockBytes = Buffer.from(serializeLock(runnableLock), "utf8");
  const runnableTar = writeCanonicalTar([
    { path: RESERVED_LOCK_PATH, bytes: runnableLockBytes, mode: "644" },
    ...closure.files.map((f) => ({ path: f.bundlePath, bytes: f.bytes, mode: f.mode })),
  ]);
  const publication = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-runtime-"));
  let extractedDir: string | undefined;
  try {
    const output = path.join(publication, "roundtrip.hank");
    fs.writeFileSync(output, zstdCompress(runnableTar));
    const resolved = await resolveBundleHank(output);
    extractedDir = resolved.hankDir;
    assert.equal(resolved.bundleHash, runnableLock.bundleHash);
    assert.deepEqual(
      fs.readFileSync(path.join(resolved.hankDir, RESERVED_LOCK_PATH)),
      runnableLockBytes,
    );
    for (const file of closure.files) {
      assert.deepEqual(fs.readFileSync(path.join(resolved.hankDir, file.bundlePath)), file.bytes);
    }
    console.log(`identity: bundleReadRoundTrip ${resolved.bundleHash}`);
  } finally {
    if (extractedDir) fs.rmSync(extractedDir, { recursive: true, force: true });
    fs.rmSync(publication, { recursive: true, force: true });
  }
}

// Exercise authored ignore rules and the diagnostic paths introduced by
// replaying phase 2 onto the shared HankDir walk. Identity output must not
// contain runtime-specific JSON parse notes or temporary absolute paths.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pack-runtime-"));
try {
  fs.cpSync(FIXTURE, scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, ".gitignore"), "tpl/README.md\n");
  const filtered = computeClosure(scratch);
  assert.equal(filtered.ok, true);
  assert.equal(filtered.files.some((f) => f.bundlePath === "tpl/README.md"), false);
  const filteredLock = serializeLock(buildLock(filtered, { minRuntime: "1.0.0" }));
  console.log(`identity: filteredLockSha256 ${sha256(filteredLock)}`);

  fs.writeFileSync(path.join(scratch, "tpl/.gitignore"), "*.log\n");
  const nested = computeClosure(scratch);
  assert.equal(nested.ok, false);
  const nestedErrors = nested.findings.filter((f) => f.severity === "error");
  assert.equal(nestedErrors[0]?.category, "invalid-ignore-rules");
  assert.equal(JSON.stringify(nestedErrors).includes(scratch), false);
  console.log(`identity: nestedRules ${JSON.stringify(nestedErrors)}`);

  fs.rmSync(path.join(scratch, ".gitignore"));
  fs.mkdirSync(path.join(scratch, ".gitignore"));
  const unreadable = computeClosure(scratch);
  assert.equal(unreadable.ok, false);
  const rulesErrors = unreadable.findings.filter((f) => f.severity === "error");
  assert.equal(rulesErrors[0]?.category, "copy-tree-error");
  assert.equal(JSON.stringify(rulesErrors).includes(scratch), false);
  console.log(`identity: invalidRules ${JSON.stringify(rulesErrors)}`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log("PASS pack-bundle-hash");
