/**
 * Kitchen-sink closure test (phase-1 review wrap-up): ONE messy hank
 * composing every happy-path tricky case from issues 01–07 — see the
 * annotated layout dump in tests/helpers/messy-hank.ts — asserted through
 * GLOBAL invariants (determinism, hash-bytes agreement, in-bundle ref
 * resolution, codon-scoped invalidation, identity sensitivity) rather than
 * per-case values, so the cases are exercised in interaction, not
 * isolation.
 *
 * Whole file is win32-skipped: the fixture's exec bits are integral. Error
 * cases (symlinks, escaping refs, empty copy roots, …) abort the closure —
 * mostly at the loader gate — and live in their own per-case tests by
 * necessity.
 */

import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { hankFileSchema, loadGlobalSystemPrompt } from "../../server/config.js";
import { computeClosure, extendClosure, refKey, sha256Hex } from "../../server/pack/closure.js";
import { buildLock, serializeLock } from "../../server/pack/lock.js";
import { SentinelConfigLoader } from "../../server/sentinels/sentinel-config-loader.js";
import { buildMessyHank } from "../helpers/messy-hank.js";

const tempRoots: string[] = [];
afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function build() {
  const messy = buildMessyHank();
  tempRoots.push(messy.root);
  return messy;
}

const AUX_MEMBERS = [
  { bundlePath: "comments.jsonl", bytes: Buffer.from('{"comment":"A"}\n', "utf8") },
  { bundlePath: "meta/notes.txt", bytes: Buffer.from("auxiliary notes\n", "utf8"), mode: "755" },
] as const;

function lockFor(hankDir: string) {
  const closure = computeClosure(hankDir);
  expect(closure.findings.filter((f) => f.severity === "error")).toEqual([]);
  expect(closure.ok).toBe(true);
  return buildLock(extendClosure(closure, [...AUX_MEMBERS]), { minRuntime: "1.0.0" });
}

describe.skipIf(process.platform === "win32")("pack kitchen sink (issues 01-07 composed)", () => {
  it("walks clean: zero errors, every §4.5 warn category fires, ..templates stays in-dir", () => {
    const { hankDir } = build();
    const closure = computeClosure(hankDir);
    expect(closure.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(closure.ok).toBe(true);

    const warns = new Set(
      closure.findings.filter((f) => f.severity === "warn").map((f) => f.category),
    );
    for (const category of ["home-ref", "network-op", "inline-env", "empty-dir", "ignored-paths"]) {
      expect(warns.has(category as never)).toBe(true);
    }
  });

  it("materializes the full member set: modes, unicode, __proto__, ..templates — no decoys", () => {
    const { hankDir } = build();
    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(true);
    const paths = closure.files.map((f) => f.bundlePath);

    // Bundle layout equals source layout (strict refs).
    expect(paths).toContain("tpl/bin/run.sh");
    expect(paths).toContain("tpl/docs/readme.md");
    // Exec bit preserved in the entry (identity-bearing, issue 01).
    const script = closure.files.find((f) => f.bundlePath === "tpl/bin/run.sh");
    expect(script?.mode).toBe("755");
    // Edge-name members present.
    for (const p of ["..templates/intro.md", "prompts/深い.md", "__proto__/tricky.md"]) {
      expect(paths).toContain(p);
    }
    // Same authored string "../shared/u.md" from two different config
    // anchors resolves to two DIFFERENT members (issue 04).
    expect(paths).toContain("shared/u.md");
    expect(paths).toContain("nested/shared/u.md");
    const uRecords = [...closure.refs.values()].filter((r) => r.raw === "../shared/u.md");
    expect(uRecords.length).toBe(2);
    expect(new Set(uRecords.map((r) => r.bundlePath)).size).toBe(2);

    // Decoys and exclusions: outputs, workspace targets, empty dirs, lock,
    // and default-ignored junk (node_modules incl. its symlink, *.log,
    // .DS_Store — hank-dir.ts).
    expect(paths.some((p) => p.startsWith("workspace/") || p.startsWith("out/"))).toBe(false);
    expect(paths.some((p) => p.includes("empty-nested"))).toBe(false);
    expect(paths).not.toContain("hank.lock");
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
    expect(paths).not.toContain("tpl/debug.log");
    expect(paths).not.toContain("tpl/.DS_Store");
  });

  it("is deterministic end to end and every hash equals its captured bytes", () => {
    const { hankDir } = build();
    const a = lockFor(hankDir);
    const b = lockFor(hankDir);
    expect(serializeLock(a)).toBe(serializeLock(b));

    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(true);
    for (const entry of extendClosure(closure, [...AUX_MEMBERS]).files) {
      expect(sha256Hex(entry.bytes)).toBe(entry.sha256);
    }
    // Null-prototype maps hold the hostile keys (issue 01 hardening).
    expect(Object.keys(a.codonInputs).sort()).toEqual(["__proto__", "loop-1/deep"]);
    expect(a.files["__proto__/tricky.md"]).toBeDefined();
    expect(a.runtime.min).toBe("1.0.0");
  });

  it("every authored config ref resolves to a member from its own doc's bundle dir", () => {
    // Configs ship verbatim (strict refs: nothing is rewritten), so the
    // authored hank.json IS the bundled hank.json — every ref in it, and in
    // every file sentinel config, must resolve to a bundle member from the
    // doc's own bundle home.
    const { hankDir } = build();
    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(true);

    const memberSet = new Set(closure.files.map((f) => f.bundlePath));
    const bytesOf = (bundlePath: string): string => {
      const entry = closure.files.find((f) => f.bundlePath === bundlePath);
      if (!entry) throw new Error(`no member at ${bundlePath}`);
      return entry.bytes.toString("utf8");
    };
    const resolveFrom = (docPath: string, ref: string): string => {
      const dir = path.posix.dirname(docPath);
      return path.posix.normalize(dir === "." ? ref : path.posix.join(dir, ref));
    };
    const expectMember = (docPath: string, ref: unknown): void => {
      for (const one of Array.isArray(ref) ? ref : [ref]) {
        if (typeof one !== "string" || one === "") continue;
        expect(memberSet.has(resolveFrom(docPath, one))).toBe(true);
      }
    };

    const hank = JSON.parse(bytesOf("hank.json"));
    expectMember("hank.json", hank.globalSystemPromptFile);
    const codon = hank.hank[0];
    expectMember("hank.json", codon.promptFile);
    expectMember("hank.json", codon.appendSystemPromptFile);
    expectMember("hank.json", hank.hank[1].codons[0].promptFile);
    // copy.from is a directory: members live under it.
    const copyFrom = resolveFrom("hank.json", codon.rigSetup[0].copy.from);
    expect([...memberSet].some((p) => p.startsWith(`${copyFrom}/`))).toBe(true);
    // Inline sentinel refs resolve from the bundle root (hank-dir anchor).
    expectMember("hank.json", codon.sentinels[0].sentinelConfig.userPromptFile);
    // File sentinel configs: their own refs resolve from each config's dir.
    for (const entry of codon.sentinels.slice(1)) {
      const configPath = resolveFrom("hank.json", entry.sentinelConfig);
      expect(memberSet.has(configPath)).toBe(true);
      const doc = JSON.parse(bytesOf(configPath));
      expectMember(configPath, doc.userPromptFile);
      expectMember(configPath, doc.systemPromptFile);
      expectMember(configPath, doc.structuredOutput?.schemaFile);
    }
  });

  it("invalidates exactly the owning codon on a deep prompt edit; identity follows", () => {
    const { hankDir } = build();
    const before = lockFor(hankDir);
    fs.writeFileSync(path.join(hankDir, "prompts/深い.md"), "deep prompt, edited\n");
    const after = lockFor(hankDir);

    expect(after.bundleHash).not.toBe(before.bundleHash);
    expect(after.codonInputs["loop-1/deep"]).not.toBe(before.codonInputs["loop-1/deep"]);
    expect(after.codonInputs.__proto__).toBe(before.codonInputs.__proto__ as string);
    expect(after.files["prompts/深い.md"]).not.toEqual(before.files["prompts/深い.md"]);
  });

  it("changes identity on an exec-bit flip and on auxiliary-member byte changes", () => {
    const { hankDir } = build();
    const before = lockFor(hankDir);

    // Issue 01: same bytes, different mode → different behavior → new hash.
    fs.chmodSync(path.join(hankDir, "tpl/bin/run.sh"), 0o644);
    const flipped = lockFor(hankDir);
    expect(flipped.bundleHash).not.toBe(before.bundleHash);

    // Issue 07: auxiliary members are part of the identity.
    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(true);
    expect(flipped.files["comments.jsonl"]).toBeDefined();
    expect(flipped.files["meta/notes.txt"]?.mode).toBe("755");
    const otherComments = buildLock(
      extendClosure(closure, [
        { ...AUX_MEMBERS[0], bytes: Buffer.from('{"comment":"B"}\n', "utf8") },
        AUX_MEMBERS[1],
      ]),
      { minRuntime: "1.0.0" },
    );
    expect(otherComments.bundleHash).not.toBe(flipped.bundleHash);
  });

  it("agrees with the runtime loaders on this hank too (issue 06 parity)", () => {
    const { hankDir } = build();
    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(true);
    const parsed = hankFileSchema.parse(
      JSON.parse(fs.readFileSync(path.join(hankDir, "hank.json"), "utf8")),
    );

    // Array-form global prompt: loader's "\n\n" join over the same bytes.
    const globalBytes = ["prompts/global.md", "..templates/intro.md"].map((p) =>
      closure.files.find((f) => f.bundlePath === p)?.bytes.toString("utf8"),
    );
    expect(loadGlobalSystemPrompt(parsed, hankDir)).toBe(globalBytes.join("\n\n"));

    const codon = parsed.hank[0] as { sentinels: unknown };
    const result = new SentinelConfigLoader().loadConfigsForCodon(
      codon.sentinels as Parameters<SentinelConfigLoader["loadConfigsForCodon"]>[0],
      "__proto__",
      hankDir,
    );
    expect(result.errors).toEqual([]);
    const [inline, sa] = result.configs;
    expect(inline?.source).toBe("inline");
    expect(inline?.configDirectory).toBe(hankDir);
    const saRecord = closure.refs.get(refKey(hankDir, "sa/check.json"));
    expect(sa?.source).toBe("file");
    expect(sa?.sourcePath).toBe(saRecord?.resolved as string);
    expect(sa?.configDirectory).toBe(path.dirname(saRecord?.resolved as string));
  });
});
