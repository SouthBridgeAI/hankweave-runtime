import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalJsonStringify } from "../../server/pack/canonical-json.js";
import { computeClosure } from "../../server/pack/closure.js";
import { buildLock, computeBundleHash, serializeLock } from "../../server/pack/lock.js";
import { hankLockSchema } from "../../server/pack/lock-schema.js";
import { getMetadata } from "../../server/utils.js";

const FIXTURE = path.resolve(process.cwd(), "tests/fixtures/pack-fixture");

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function copyFixture(): { root: string; hankDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pack-lock-"));
  tempDirs.push(root);
  fs.cpSync(FIXTURE, path.join(root, "pack-fixture"), { recursive: true });
  return { root, hankDir: path.join(root, "pack-fixture") };
}

function lockFor(hankDir: string) {
  const closure = computeClosure(hankDir);
  expect(closure.ok).toBe(true);
  return buildLock(closure);
}

describe("canonical JSON (spec §4.2)", () => {
  it("is independent of input key order", () => {
    expect(canonicalJsonStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJsonStringify({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  it("sorts keys by UTF-8 byte order, not UTF-16 code units", () => {
    // U+10000 encodes as F0 90 80 80; U+FFFD as EF BF BD. In UTF-16,
    // U+10000 (surrogate D800…) sorts FIRST; in UTF-8 bytes it sorts LAST.
    const s = canonicalJsonStringify({ "\u{10000}": 1, "�": 2 });
    expect(s.indexOf("�")).toBeLessThan(s.indexOf("\u{10000}"));
  });

  it("omits undefined object properties", () => {
    expect(canonicalJsonStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("emits no insignificant whitespace", () => {
    expect(canonicalJsonStringify({ a: [1, 2], b: "x" })).toBe('{"a":[1,2],"b":"x"}');
  });

  it("rejects non-finite numbers and undefined array elements", () => {
    expect(() => canonicalJsonStringify({ a: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => canonicalJsonStringify([undefined])).toThrow();
  });

  it("rejects sparse array slots (holes would collapse or corrupt preimages)", () => {
    // A hole is not an element: .map() skips it, so new Array(1) would
    // serialize as [] — the same preimage as a truly empty array — and a
    // double hole as invalid JSON. Holes must fail like undefined does.
    expect(() => canonicalJsonStringify(new Array(1))).toThrow();
    // biome-ignore lint/suspicious/noSparseArray: the hole IS the test
    expect(() => canonicalJsonStringify([1, , 3])).toThrow();
  });

  it("rejects object keys containing lone surrogates (no total byte order)", () => {
    // TextEncoder maps both \uD800 and \uD801 to U+FFFD — distinct keys
    // would compare equal and hashing would depend on insertion order.
    expect(() => canonicalJsonStringify({ "\uD800": 1 })).toThrow(/lone surrogate/);
    // Well-formed astral keys stay fine.
    expect(() => canonicalJsonStringify({ "\u{10000}": 1 })).not.toThrow();
  });
});

describe("hank.lock builder (spec §4.3)", () => {
  it("builds the full lock shape from the fixture", () => {
    const lock = lockFor(FIXTURE);
    expect(lock.v).toBe(1);
    expect(lock.name).toBe("pack-fixture");
    expect(lock.version).toBe("1.0.0");
    expect(lock.bundleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(lock.runtime.min).toBe(getMetadata().version);
    expect(lock).not.toHaveProperty("requirements");
    expect(Object.keys(lock.files)).toContain("hank.json");
    expect(Object.keys(lock.files)).not.toContain("hank.lock");
    expect(lock.files["hank.json"]).toEqual({
      mode: "644",
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("bundleHash covers exactly {v, files, runtime} (phase-1 review, issue 01)", () => {
    const lock = lockFor(FIXTURE);
    const identity = { v: lock.v, files: lock.files, runtime: lock.runtime };
    expect(lock.bundleHash).toBe(computeBundleHash(identity));

    // Member content change → new identity.
    const entry = lock.files["prompts/codon1.md"] as { mode: "644" | "755"; sha256: string };
    const contentTampered = {
      ...lock.files,
      "prompts/codon1.md": { ...entry, sha256: "0".repeat(64) },
    };
    expect(computeBundleHash({ ...identity, files: contentTampered })).not.toBe(lock.bundleHash);

    // Mode flip 644 → 755 with identical bytes → new identity (issue 01
    // acceptance criterion: the exec bit is load-bearing at runtime).
    const modeTampered = {
      ...lock.files,
      "prompts/codon1.md": { ...entry, mode: "755" as const },
    };
    expect(computeBundleHash({ ...identity, files: modeTampered })).not.toBe(lock.bundleHash);

    // Runtime gate change → new identity (issue 01 acceptance criterion).
    expect(computeBundleHash({ ...identity, runtime: { min: "999.0.0" } })).not.toBe(
      lock.bundleHash,
    );
  });

  it("respects --min-runtime override, and the gate is part of the identity", () => {
    const closure = computeClosure(FIXTURE);
    const lock = buildLock(closure, { minRuntime: "9.9.9" });
    expect(lock.runtime.min).toBe("9.9.9");
    expect(lock.bundleHash).not.toBe(buildLock(closure).bundleHash);
  });

  it("serializes canonically with a single trailing newline", () => {
    const lock = lockFor(FIXTURE);
    const text = serializeLock(lock);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toBe(`${canonicalJsonStringify(lock)}\n`);
    // parse → re-serialize is a fixpoint
    expect(`${canonicalJsonStringify(JSON.parse(text))}\n`).toBe(text);
  });

  it("falls back to hank-<bundleHash prefix>/0.0.0 when meta is absent", () => {
    // The fallback must be derivable from bundle bytes alone (name is
    // DERIVED) — never the source directory's basename, which doesn't ship.
    const { hankDir } = copyFixture();
    const p = path.join(hankDir, "hank.json");
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    raw.meta = undefined;
    fs.writeFileSync(p, `${JSON.stringify(raw, null, 2)}\n`);

    const lock = lockFor(hankDir);
    expect(lock.name).toBe(`hank-${lock.bundleHash.slice(0, 12)}`);
    expect(lock.version).toBe("0.0.0");

    // Byte-identical hanks in differently-named directories are the SAME
    // bundle and must carry the same identity AND the same name — the old
    // basename fallback made the displayed name depend on which copy a
    // registry saw first. With a pinned minRuntime the whole serialized
    // lock is byte-identical.
    const renamed = path.join(path.dirname(hankDir), "renamed-copy");
    fs.cpSync(hankDir, renamed, { recursive: true });
    const other = lockFor(renamed);
    expect(other.bundleHash).toBe(lock.bundleHash);
    expect(other.name).toBe(lock.name);
    const lockA = buildLock(computeClosure(hankDir), { minRuntime: "1.0.0" });
    const lockB = buildLock(computeClosure(renamed), { minRuntime: "1.0.0" });
    expect(serializeLock(lockA)).toBe(serializeLock(lockB));
  });
});

describe("authored keys are handled safely", () => {
  it("keeps a codon id of __proto__ in codonInputs (prototype-safe map)", () => {
    const { hankDir } = copyFixture();
    const p = path.join(hankDir, "hank.json");
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    raw.hank[0].id = "__proto__";
    fs.writeFileSync(p, `${JSON.stringify(raw, null, 2)}\n`);

    const lock = lockFor(hankDir);
    expect(Object.keys(lock.codonInputs).sort()).toEqual(["__proto__", "loop-1/codon-2"]);
    expect(serializeLock(lock)).toContain('"__proto__"');
  });

  it("hashes requirements.env into codonInputs trimmed, exactly as hankRequirementsSchema does", () => {
    const baseline = lockFor(FIXTURE);
    const { hankDir } = copyFixture();
    const p = path.join(hankDir, "hank.json");
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    raw.requirements.env = ["  PACK_FIXTURE_TOKEN  "];
    fs.writeFileSync(p, `${JSON.stringify(raw, null, 2)}\n`);

    // The runtime preflight checks the trimmed name, so whitespace around
    // it is not a behavior change and must leave every codon digest alone.
    const lock = lockFor(hankDir);
    expect(lock.codonInputs).toEqual(baseline.codonInputs);

    // A real change to the list IS a behavior change for every codon.
    raw.requirements.env = ["PACK_FIXTURE_TOKEN", "ANOTHER_TOKEN"];
    fs.writeFileSync(p, `${JSON.stringify(raw, null, 2)}\n`);
    const changed = lockFor(hankDir);
    for (const key of Object.keys(baseline.codonInputs)) {
      expect(changed.codonInputs[key]).not.toBe(baseline.codonInputs[key]);
    }
  });
});

describe("directory tree hash (spec §4.4)", () => {
  it.skipIf(process.platform === "win32")(
    "mode bits are load-bearing: chmod +x in the copy tree invalidates the owning codon",
    () => {
      const { hankDir } = copyFixture();
      const before = lockFor(hankDir);

      fs.chmodSync(path.join(hankDir, "tpl/README.md"), 0o755);
      const after = lockFor(hankDir);

      // Tree hash covers mode → the referencing codon's inputs change …
      expect(after.codonInputs["codon-1"]).not.toBe(before.codonInputs["codon-1"]);
      expect(after.codonInputs["loop-1/codon-2"]).toBe(before.codonInputs["loop-1/codon-2"]);
      // … and so do the member's mode and bundleHash — same bytes at 644 vs
      // 755 behave differently, so they are different bundles (issue 01).
      const rel = "tpl/README.md";
      expect(before.files[rel]?.mode).toBe("644");
      expect(after.files[rel]?.mode).toBe("755");
      expect(after.files[rel]?.sha256).toBe(before.files[rel]?.sha256 ?? "missing");
      expect(after.bundleHash).not.toBe(before.bundleHash);
    },
  );

  it("empty directories are excluded: adding one leaves the lock byte-identical", () => {
    const { hankDir } = copyFixture();
    const before = serializeLock(lockFor(hankDir));

    fs.mkdirSync(path.join(hankDir, "tpl/empty-dir"));
    const after = serializeLock(lockFor(hankDir));

    expect(after).toBe(before);
  });

  it("ignored entries are excluded: adding node_modules/.git/log junk leaves the lock byte-identical", () => {
    const { hankDir } = copyFixture();
    const before = serializeLock(lockFor(hankDir));

    fs.mkdirSync(path.join(hankDir, "tpl/node_modules/pkg"), { recursive: true });
    fs.writeFileSync(path.join(hankDir, "tpl/node_modules/pkg/index.js"), "junk\n");
    fs.mkdirSync(path.join(hankDir, "tpl/.git"));
    fs.writeFileSync(path.join(hankDir, "tpl/.git/config"), "[core]\n");
    fs.writeFileSync(path.join(hankDir, "tpl/debug.log"), "noise\n");
    const after = serializeLock(lockFor(hankDir));

    // The default ignore rules keep the junk out of files, bundleHash, and
    // the tpl tree hash feeding codonInputs — the lock cannot tell the
    // difference.
    expect(after).toBe(before);
  });
});

describe("codonInputs — change-aware rerun contract (spec §4.4, §7 check 3)", () => {
  it("keys top-level codons by id and loop children by loopId/id", () => {
    const lock = lockFor(FIXTURE);
    expect(Object.keys(lock.codonInputs).sort()).toEqual(["codon-1", "loop-1/codon-2"]);
    for (const value of Object.values(lock.codonInputs)) {
      expect(value).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("editing one prompt invalidates only the codons referencing it", () => {
    const { hankDir } = copyFixture();
    const before = lockFor(hankDir);

    fs.appendFileSync(path.join(hankDir, "prompts/codon2.md"), "\nEdited.\n");
    const after = lockFor(hankDir);

    expect(after.bundleHash).not.toBe(before.bundleHash);
    expect(after.files["prompts/codon2.md"]).not.toEqual(before.files["prompts/codon2.md"]);
    expect(after.files["prompts/codon1.md"]).toEqual(before.files["prompts/codon1.md"]);
    expect(after.codonInputs["loop-1/codon-2"]).not.toBe(before.codonInputs["loop-1/codon-2"]);
    expect(after.codonInputs["codon-1"]).toBe(before.codonInputs["codon-1"]);
  });

  it("editing a sentinel's prompt invalidates only the codon using that sentinel", () => {
    const { hankDir } = copyFixture();
    const before = lockFor(hankDir);

    fs.appendFileSync(path.join(hankDir, "prompts/check-user.md"), "\nEdited.\n");
    const after = lockFor(hankDir);

    expect(after.codonInputs["codon-1"]).not.toBe(before.codonInputs["codon-1"]);
    expect(after.codonInputs["loop-1/codon-2"]).toBe(before.codonInputs["loop-1/codon-2"]);
  });

  it("empty globalSystemPromptText does not mask the file the runtime actually loads", () => {
    const { hankDir } = copyFixture();
    const p = path.join(hankDir, "hank.json");
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    // Schema-valid ("" is falsy, so the both-present refine passes); the
    // runtime ignores the empty text and loads the file.
    raw.globalSystemPromptText = "";
    fs.writeFileSync(p, `${JSON.stringify(raw, null, 2)}\n`);
    const before = lockFor(hankDir);

    fs.appendFileSync(path.join(hankDir, "prompts/global-system.md"), "\nEdited.\n");
    const after = lockFor(hankDir);

    // The hash must track the file the runtime selects.
    expect(after.codonInputs["codon-1"]).not.toBe(before.codonInputs["codon-1"]);
  });

  it("editing the global system prompt invalidates every codon", () => {
    const { hankDir } = copyFixture();
    const before = lockFor(hankDir);

    fs.appendFileSync(path.join(hankDir, "prompts/global-system.md"), "\nEdited.\n");
    const after = lockFor(hankDir);

    expect(after.codonInputs["codon-1"]).not.toBe(before.codonInputs["codon-1"]);
    expect(after.codonInputs["loop-1/codon-2"]).not.toBe(before.codonInputs["loop-1/codon-2"]);
  });

  it("any overrides edit invalidates every codon (deliberate coarseness)", () => {
    const { hankDir } = copyFixture();
    const before = lockFor(hankDir);

    const p = path.join(hankDir, "hank.json");
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    raw.overrides = { model: "sonnet" };
    fs.writeFileSync(p, `${JSON.stringify(raw, null, 2)}\n`);
    const after = lockFor(hankDir);

    expect(after.codonInputs["codon-1"]).not.toBe(before.codonInputs["codon-1"]);
    expect(after.codonInputs["loop-1/codon-2"]).not.toBe(before.codonInputs["loop-1/codon-2"]);
  });

  it.skipIf(process.platform === "win32")(
    "direct-file copy.from mode flip invalidates the owning codon",
    () => {
      const { hankDir } = copyFixture();
      const filePath = path.join(hankDir, "tpl/README.md");
      const p = path.join(hankDir, "hank.json");
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      raw.hank[0].rigSetup[0].copy.from = "tpl/README.md";
      fs.writeFileSync(p, `${JSON.stringify(raw, null, 2)}\n`);
      const before = lockFor(hankDir);

      // Same bytes, exec bit flipped — the runtime copy preserves it.
      fs.chmodSync(filePath, 0o755);
      const after = lockFor(hankDir);

      expect(after.codonInputs["codon-1"]).not.toBe(before.codonInputs["codon-1"]);
      expect(after.codonInputs["loop-1/codon-2"]).toBe(before.codonInputs["loop-1/codon-2"]);
    },
  );

  it("is spelling-invariant: different relative spellings of the same target agree", () => {
    // Absolute refs are gone (strict refs), but spelling variants remain:
    // "tpl" and "./tpl" resolve to the same directory. codonInputs is a
    // DERIVED field — a function of bundle bytes alone (spec §6 B19) — but
    // the AUTHORED spelling lives inside hank.json, whose bytes differ, so
    // bundleHash differs while the substituted {path, sha256} agrees.
    const plain = copyFixture();
    const dotted = copyFixture();
    const p = path.join(dotted.hankDir, "hank.json");
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    raw.hank[0].rigSetup[0].copy.from = "./tpl";
    fs.writeFileSync(p, `${JSON.stringify(raw, null, 2)}\n`);

    const plainLock = lockFor(plain.hankDir);
    const dottedLock = lockFor(dotted.hankDir);

    // Same members at the same paths (hank.json bytes differ by spelling).
    const plainTpl = Object.keys(plainLock.files).filter((k) => k.startsWith("tpl/"));
    const dottedTpl = Object.keys(dottedLock.files).filter((k) => k.startsWith("tpl/"));
    expect(dottedTpl).toEqual(plainTpl);
    for (const k of plainTpl) {
      expect(dottedLock.files[k]).toEqual(
        plainLock.files[k] as { mode: "644" | "755"; sha256: string },
      );
    }
    // The substitution collapses spelling variants to the bundle path, so
    // the codon fingerprints agree even though the authored strings differ.
    expect(dottedLock.codonInputs).toEqual(plainLock.codonInputs);
  });

  it("reordering codons changes codonInputs (execution order is part of a codon's inputs)", () => {
    // A codon's behavior depends on where it runs in the sequence (earlier
    // codons shape its rig and context), and codonInputs is a sorted map —
    // so without position in the preimage, swapping two codons would leave
    // every digest identical and the partial-rerun comparison blind to a
    // behavior-changing edit.
    const { hankDir } = copyFixture();
    const before = lockFor(hankDir);

    const p = path.join(hankDir, "hank.json");
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    raw.hank.reverse(); // [codon-1, loop-1] → [loop-1, codon-1]
    fs.writeFileSync(p, `${JSON.stringify(raw, null, 2)}\n`);
    const after = lockFor(hankDir);

    expect(Object.keys(after.codonInputs).sort()).toEqual(Object.keys(before.codonInputs).sort());
    expect(after.codonInputs["codon-1"]).not.toBe(before.codonInputs["codon-1"]);
    expect(after.codonInputs["loop-1/codon-2"]).not.toBe(before.codonInputs["loop-1/codon-2"]);
  });

  it("loop container changes invalidate loop children only", () => {
    const { hankDir } = copyFixture();
    const before = lockFor(hankDir);

    const p = path.join(hankDir, "hank.json");
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    raw.hank[1].terminateOn.limit = 5;
    fs.writeFileSync(p, `${JSON.stringify(raw, null, 2)}\n`);
    const after = lockFor(hankDir);

    expect(after.codonInputs["loop-1/codon-2"]).not.toBe(before.codonInputs["loop-1/codon-2"]);
    expect(after.codonInputs["codon-1"]).toBe(before.codonInputs["codon-1"]);
  });
});

describe("prototype-safe lock parsing (phase-2 review)", () => {
  const HASH = "a".repeat(64);
  // Build via JSON.parse so "__proto__" arrives as an OWN property, the
  // way a lock read from disk would carry it.
  const lockJson = (protoSha: string): unknown =>
    JSON.parse(
      `{"v":1,"name":"n","version":"1.0.0","bundleHash":"${HASH}",` +
        `"files":{"__proto__":{"mode":"644","sha256":"${HASH}"},"hank.json":{"mode":"644","sha256":"${HASH}"}},` +
        `"codonInputs":{"__proto__":"${protoSha}"},` +
        `"runtime":{"min":"1.2.3"},"ignoreDefaults":"${HASH}"}`,
    );

  it("preserves own __proto__ entries in files and codonInputs", () => {
    const parsed = hankLockSchema.parse(lockJson(HASH));
    expect(Object.keys(parsed.files).sort()).toEqual(["__proto__", "hank.json"]);
    expect(parsed.files.__proto__).toEqual({ mode: "644", sha256: HASH });
    expect(Object.getPrototypeOf(parsed.files)).toBeNull();
    expect(Object.keys(parsed.codonInputs)).toEqual(["__proto__"]);
    expect(parsed.codonInputs.__proto__).toBe(HASH);
  });

  it("still validates the value stored under a __proto__ key", () => {
    expect(hankLockSchema.safeParse(lockJson("not-a-hash")).success).toBe(false);
  });

  it("rejects a non-SemVer runtime.min, and the GENERATED schema now does too", () => {
    const bad = lockJson(HASH) as { runtime: { min: string } };
    bad.runtime.min = "banana";
    expect(hankLockSchema.safeParse(bad).success).toBe(false);

    // zod-to-json-schema drops .refine predicates; the SemVer rule rides a
    // .regex check precisely so it lands in the generated schema. Guard
    // the generated artifact against regressing to an unrestricted string.
    const generated = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), "schemas/hank.lock.schema.json"), "utf8"),
    );
    const min = generated.definitions.HankweaveBundleLock.properties.runtime.properties.min;
    expect(typeof min.pattern).toBe("string");
    const pattern = new RegExp(min.pattern);
    expect(pattern.test("1.2.3")).toBe(true);
    expect(pattern.test("banana")).toBe(false);
    expect(pattern.test("")).toBe(false);
  });
});
