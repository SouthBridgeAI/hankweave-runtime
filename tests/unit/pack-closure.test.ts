import { afterEach, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  codonObjectSchema,
  hankFileSchema,
  loadGlobalSystemPrompt,
  loopSchema,
  rigSetupItemSchema,
} from "../../server/config.js";
import {
  codonSentinelEntrySchema,
  sentinelConfigSchema,
} from "../../server/config-validation/sentinel.schema.js";
import {
  computeClosure,
  extendClosure,
  loaderFailureFindings,
  refKey,
  sha256Hex,
} from "../../server/pack/closure.js";
import { buildLock, serializeLock } from "../../server/pack/lock.js";
import { SentinelConfigLoader } from "../../server/sentinels/sentinel-config-loader.js";

const FIXTURE = path.resolve(process.cwd(), "tests/fixtures/pack-fixture");

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Copy pack-fixture into a temp root so tests can mutate files and create
 * symlinks without touching the committed fixture.
 */
function copyFixture(): { root: string; hankDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pack-closure-"));
  tempDirs.push(root);
  fs.cpSync(FIXTURE, path.join(root, "pack-fixture"), { recursive: true });
  return { root, hankDir: path.join(root, "pack-fixture") };
}

// biome-ignore lint/suspicious/noExplicitAny: tests mutate raw fixture JSON freely
function editHankJson(hankDir: string, edit: (raw: any) => void): void {
  const p = path.join(hankDir, "hank.json");
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  edit(raw);
  fs.writeFileSync(p, `${JSON.stringify(raw, null, 2)}\n`);
}

describe("pack closure walker", () => {
  it("collects the complete closure of the fixture", () => {
    const closure = computeClosure(FIXTURE);
    expect(closure.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(closure.ok).toBe(true);

    const bundlePaths = closure.files.map((f) => f.bundlePath);
    expect(bundlePaths).toEqual(
      [
        "hank.json",
        "prompts/append-system.md",
        "prompts/check-user.md",
        "prompts/codon1.md",
        "prompts/codon2.md",
        "prompts/global-system.md",
        "sentinels/check-schema.ts",
        "sentinels/check.json",
        "tpl/README.md",
        "tpl/bin/run.sh",
      ].sort(),
    );
    // Bundle layout equals source layout: every member's bundle path IS its
    // hank-relative source path, and every config ships verbatim.
    for (const entry of closure.files) {
      expect(entry.bundlePath).toBe(
        path.relative(closure.hankDir, entry.sourcePath).split(path.sep).join("/"),
      );
    }
    const hankEntry = closure.files.find((f) => f.bundlePath === "hank.json");
    expect(hankEntry?.sha256).toBe(sha256Hex(fs.readFileSync(path.join(FIXTURE, "hank.json"))));
  });

  // NTFS does not preserve the POSIX executable bit through fs.stat().mode,
  // so on the windows-latest CI leg everything normalizes to 644.
  it.skipIf(process.platform === "win32")(
    "preserves the executable bit as mode 755 and defaults to 644",
    () => {
      const closure = computeClosure(FIXTURE);
      const script = closure.files.find((f) => f.bundlePath === "tpl/bin/run.sh");
      const readme = closure.files.find((f) => f.bundlePath === "tpl/README.md");
      expect(script?.mode).toBe("755");
      expect(readme?.mode).toBe("644");
    },
  );

  it("resolves a file sentinel's own refs relative to the sentinel config dir", () => {
    const closure = computeClosure(FIXTURE);
    // ../prompts/check-user.md from sentinels/ lands at prompts/check-user.md
    expect(closure.files.some((f) => f.bundlePath === "prompts/check-user.md")).toBe(true);
    expect(closure.files.some((f) => f.bundlePath === "sentinels/check-schema.ts")).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "accepts a symlinked root config and anchors its refs at the selected directory",
    () => {
      const { root, hankDir } = copyFixture();
      const selected = path.join(hankDir, "hank.json");
      const actual = path.join(root, "actual.json");
      fs.renameSync(selected, actual);
      fs.symlinkSync(actual, selected);
      const closure = computeClosure(hankDir);
      expect(closure.findings.filter((f) => f.severity === "error")).toEqual([]);
      expect(closure.ok).toBe(true);
      expect(closure.files.find((f) => f.bundlePath === "hank.json")?.bytes).toEqual(
        fs.readFileSync(actual),
      );
      expect(closure.files.some((f) => f.bundlePath === "prompts/global-system.md")).toBe(true);
    },
  );

  it("retains size diagnostics for root configs and global prompts", () => {
    const { hankDir } = copyFixture();
    const configPath = path.join(hankDir, "hank.json");
    const rootSize = fs.statSync(configPath).size;
    const rootLimit = rootSize - 1;
    const rootClosure = computeClosure(hankDir, { quotas: { maxMemberBytes: rootLimit } });
    expect(rootClosure.ok).toBe(false);
    expect(rootClosure.findings).toContainEqual({
      severity: "error",
      category: "closure-too-large",
      where: "hank.json",
      detail: `${configPath} is ${rootSize} bytes; bundle members are limited to ${rootLimit} bytes`,
    });

    const promptLimit = rootSize + 1;
    const promptSize = promptLimit + 1;
    fs.writeFileSync(path.join(hankDir, "prompts/global-system.md"), "x".repeat(promptSize));
    const promptClosure = computeClosure(hankDir, { quotas: { maxMemberBytes: promptLimit } });
    expect(promptClosure.ok).toBe(false);
    expect(promptClosure.findings).toContainEqual({
      severity: "error",
      category: "closure-too-large",
      where: "globalSystemPromptFile",
      detail: `prompts/global-system.md is ${promptSize} bytes; bundle members are limited to ${promptLimit} bytes`,
    });
  });

  it("rejects a directory named hank.lock; a leftover lock FILE still packs", () => {
    const dirCase = copyFixture();
    fs.mkdirSync(path.join(dirCase.hankDir, "hank.lock"));
    const banned = computeClosure(dirCase.hankDir);
    expect(banned.ok).toBe(false);
    expect(
      banned.findings.some((f) => f.category === "reserved-path" && f.where === "hank.lock"),
    ).toBe(true);

    // A regular hank.lock left by a previous pack is legitimate: ignored,
    // never a bundle member.
    const fileCase = copyFixture();
    fs.writeFileSync(path.join(fileCase.hankDir, "hank.lock"), '{"v":1}\n');
    const ok = computeClosure(fileCase.hankDir);
    expect(ok.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(ok.ok).toBe(true);
    expect(ok.files.some((f) => f.bundlePath === "hank.lock")).toBe(false);
  });

  it("rejects a root config supplied at the reserved hank.lock path", () => {
    const { hankDir } = copyFixture();
    // A perfectly valid config, but at the path phase 2 overwrites with the
    // generated lock — packing it would clobber its own source.
    fs.copyFileSync(path.join(hankDir, "hank.json"), path.join(hankDir, "hank.lock"));
    const closure = computeClosure(path.join(hankDir, "hank.lock"));
    expect(closure.ok).toBe(false);
    expect(
      closure.findings.some(
        (f) => f.category === "reserved-path" && f.detail.includes("occupies the reserved"),
      ),
    ).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a hank.json that is a same-file alias of hank.lock",
    () => {
      const { hankDir } = copyFixture();
      fs.renameSync(path.join(hankDir, "hank.json"), path.join(hankDir, "hank.lock"));
      fs.symlinkSync("hank.lock", path.join(hankDir, "hank.json"));
      const closure = computeClosure(hankDir);
      expect(closure.ok).toBe(false);
      expect(
        closure.findings.some(
          (f) => f.category === "reserved-path" && f.detail.includes("same file as the reserved"),
        ),
      ).toBe(true);
    },
  );

  it("treats an authored _external directory as an ordinary name (no reserved namespace)", () => {
    // The _external/ namespace existed for escaping-ref relocation; strict
    // refs made escaping impossible, so the reservation died with it.
    const { hankDir } = copyFixture();
    fs.mkdirSync(path.join(hankDir, "_external"));
    fs.writeFileSync(path.join(hankDir, "_external/note.md"), "ordinary file\n");
    editHankJson(hankDir, (raw) => {
      raw.hank[0].promptFile = ["prompts/codon1.md", "_external/note.md"];
    });

    const closure = computeClosure(hankDir);
    expect(closure.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(closure.ok).toBe(true);
    expect(closure.files.some((f) => f.bundlePath === "_external/note.md")).toBe(true);
  });

  it("ships every referenced file with the hash recorded for it", () => {
    const closure = computeClosure(FIXTURE);
    expect(closure.ok).toBe(true);

    // The hash codonInputs fingerprints must be the hash of bytes that
    // actually ship at that record's bundle path.
    const record = closure.refs.get(refKey(FIXTURE, "sentinels/check.json"));
    expect(record).toBeDefined();
    const entry = closure.files.find((f) => f.bundlePath === record?.bundlePath);
    expect(entry?.sha256).toBe(record?.sha256);
  });

  it("keeps a file used as BOTH sentinelConfig and promptFile byte-identical to the source", () => {
    const { hankDir } = copyFixture();
    // Schema-valid: promptFile may name any file, including the JSON that
    // also serves as this codon's sentinel config.
    editHankJson(hankDir, (raw) => {
      raw.hank[0].promptFile = "sentinels/check.json";
    });

    const closure = computeClosure(hankDir);
    expect(closure.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(closure.ok).toBe(true);

    const source = fs.readFileSync(path.join(hankDir, "sentinels/check.json"));
    const entry = closure.files.find((f) => f.bundlePath === "sentinels/check.json");
    expect(entry?.bytes.equals(source)).toBe(true);
  });

  it("errors missing-file when a sentinel config's own ref is missing", () => {
    // The loader checks own-ref POLICY at static validation but probes
    // existence only at codon start — pack must catch the missing file.
    const { hankDir } = copyFixture();
    const configPath = path.join(hankDir, "sentinels/check.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.userPromptFile = "../prompts/does-not-exist.md";
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(false);
    const finding = closure.findings.find((f) => f.category === "missing-file");
    expect(finding?.detail).toContain("does-not-exist.md");
  });

  it("errors empty-copy-root on an empty copy.from source (bundle could not recreate it)", () => {
    const { hankDir } = copyFixture();
    fs.mkdirSync(path.join(hankDir, "empty-root"));
    editHankJson(hankDir, (raw) => {
      raw.hank[0].rigSetup[0].copy.from = "empty-root";
    });

    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(false);
    const finding = closure.findings.find((f) => f.category === "empty-copy-root");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("error");
    // One fact, one finding: the empty root is not also an empty-dir advisory.
    expect(closure.findings.some((f) => f.category === "empty-dir")).toBe(false);
  });

  it("errors empty-copy-root when the root holds only nested empty directories", () => {
    const { hankDir } = copyFixture();
    fs.mkdirSync(path.join(hankDir, "empty-root/only/empty/dirs"), { recursive: true });
    editHankJson(hankDir, (raw) => {
      raw.hank[0].rigSetup[0].copy.from = "empty-root";
    });

    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(false);
    expect(closure.findings.some((f) => f.category === "empty-copy-root")).toBe(true);
    // The nested empty directories restate the same fact; they stay silent too.
    expect(closure.findings.some((f) => f.category === "empty-dir")).toBe(false);
  });

  it("errors when the root config collides with a closure member named hank.json", () => {
    const { hankDir } = copyFixture();
    // Root config supplied as alt.json; the sibling hank.json is ALSO in
    // the closure (referenced as a prompt file) — both claim the
    // "hank.json" bundle slot.
    const raw = JSON.parse(fs.readFileSync(path.join(hankDir, "hank.json"), "utf8"));
    raw.hank[0].promptFile = "hank.json";
    fs.writeFileSync(path.join(hankDir, "alt.json"), `${JSON.stringify(raw, null, 2)}\n`);

    const closure = computeClosure(path.join(hankDir, "alt.json"));
    expect(closure.ok).toBe(false);
    expect(closure.findings.some((f) => f.category === "reserved-path")).toBe(true);
  });

  it("lets the root config itself be referenced as a prompt file (same source, same bytes)", () => {
    const { hankDir } = copyFixture();
    editHankJson(hankDir, (raw) => {
      raw.hank[1].codons[0].appendSystemPromptFile = "hank.json";
    });

    const closure = computeClosure(hankDir);
    expect(closure.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(closure.ok).toBe(true);
    // One member at the hank.json slot, carrying the root config's bytes.
    const entries = closure.files.filter((f) => f.bundlePath === "hank.json");
    expect(entries.length).toBe(1);
    expect(entries[0]?.bytes.equals(fs.readFileSync(path.join(hankDir, "hank.json")))).toBe(true);
  });

  it("does not treat a '..'-prefixed in-dir name as an external ref", () => {
    const { hankDir } = copyFixture();
    // A first component merely STARTING with ".." (e.g. "..templates") is
    // in-dir; only an exact ".." segment escapes.
    fs.mkdirSync(path.join(hankDir, "..templates"));
    fs.writeFileSync(path.join(hankDir, "..templates/prompt.md"), "dot-dot name\n");
    editHankJson(hankDir, (raw) => {
      raw.hank[0].promptFile = ["prompts/codon1.md", "..templates/prompt.md"];
    });

    const closure = computeClosure(hankDir);
    expect(closure.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(closure.ok).toBe(true);
    expect(closure.files.some((f) => f.bundlePath === "..templates/prompt.md")).toBe(true);
  });

  it("captures member bytes at walk time (archive writers must not re-read)", () => {
    const closure = computeClosure(FIXTURE);
    expect(closure.ok).toBe(true);
    for (const entry of closure.files) {
      expect(sha256Hex(entry.bytes)).toBe(entry.sha256);
    }
  });

  it("reads each source file at most twice: loader validation + walk snapshot (issue 03)", () => {
    // The WALK reads each file exactly once (snapshotFile memoizes by
    // resolved path), so the bytes that get hashed are the bytes that ship.
    // The loader gate that runs before the walk legitimately reads config
    // and prompt files its own once — hence "at most twice", not once. A
    // third read of any fixture file means one of the two layers regressed
    // into a check/use race.
    const reads: string[] = [];
    const realReadFileSync = fs.readFileSync;
    const spy = spyOn(fs, "readFileSync").mockImplementation(((
      ...args: Parameters<typeof fs.readFileSync>
    ) => {
      reads.push(String(args[0]));
      return realReadFileSync.apply(fs, args);
    }) as typeof fs.readFileSync);
    try {
      const closure = computeClosure(FIXTURE);
      expect(closure.ok).toBe(true);
      const counts = new Map<string, number>();
      for (const p of reads) {
        if (!path.resolve(p).startsWith(FIXTURE)) continue;
        counts.set(p, (counts.get(p) ?? 0) + 1);
      }
      const overRead = [...counts.entries()].filter(([, n]) => n > 2);
      expect(overRead).toEqual([]);

      // The sentinel config's ref record (feeds codonInputs) and its files
      // entry (feeds the lock and the archive) must carry the same hash —
      // both views of the one captured walk read.
      const configEntry = closure.files.find((f) => f.bundlePath === "sentinels/check.json");
      const configRecord = [...closure.refs.values()].find(
        (r) => r.bundlePath === "sentinels/check.json",
      );
      expect(configEntry).toBeDefined();
      expect(configRecord?.sha256).toBe(configEntry?.sha256 as string);
    } finally {
      spy.mockRestore();
    }
  });

  it("errors when a file member is also a parent directory of another member", () => {
    const { hankDir } = copyFixture();
    // Root config becomes alt.json; a DIRECTORY named hank.json is swept by
    // copy.from — colliding with the config's canonical hank.json slot.
    const raw = JSON.parse(fs.readFileSync(path.join(hankDir, "hank.json"), "utf8"));
    fs.rmSync(path.join(hankDir, "hank.json"));
    fs.mkdirSync(path.join(hankDir, "hank.json"));
    fs.writeFileSync(path.join(hankDir, "hank.json/inner.md"), "shadow\n");
    raw.hank[0].rigSetup[0].copy.from = "hank.json";
    fs.writeFileSync(path.join(hankDir, "alt.json"), `${JSON.stringify(raw, null, 2)}\n`);

    const closure = computeClosure(path.join(hankDir, "alt.json"));
    expect(closure.ok).toBe(false);
    expect(
      closure.findings.some((f) => f.severity === "error" && f.detail.includes("parent directory")),
    ).toBe(true);
  });

  it("rejects an empty-string scalar file ref at the schema layer", () => {
    // Strict refs made an empty authored scalar a schema error (.min(1))
    // instead of "field absent" — pack surfaces the schema's message.
    const { hankDir } = copyFixture();
    editHankJson(hankDir, (raw) => {
      raw.hank[1].codons[0].appendSystemPromptFile = "";
    });

    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(false);
    const finding = closure.findings.find((f) => f.category === "schema-error");
    expect(finding?.detail).toContain("cannot be an empty string");
  });

  it.skipIf(process.platform === "win32")(
    "errors missing-file when hank.json itself is a FIFO instead of blocking on the read",
    () => {
      const { hankDir } = copyFixture();
      const { execSync } = require("node:child_process");
      fs.rmSync(path.join(hankDir, "hank.json"));
      execSync(`mkfifo ${JSON.stringify(path.join(hankDir, "hank.json"))}`);

      const closure = computeClosure(hankDir);
      expect(closure.ok).toBe(false);
      expect(
        closure.findings.some(
          (f) => f.category === "missing-file" && f.detail.includes("not a regular file"),
        ),
      ).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects backslash member names swept in through a copy.from tree",
    () => {
      // Authored refs can't contain backslashes (loader R1), but a file
      // SWEPT IN by a directory copy can be named "..\\escape" — on POSIX
      // an ordinary filename, on Windows it extracts OUTSIDE the bundle
      // root.
      const { hankDir } = copyFixture();
      fs.mkdirSync(path.join(hankDir, "assets"));
      fs.writeFileSync(path.join(hankDir, "assets/..\\escape"), "gotcha\n");
      editHankJson(hankDir, (raw) => {
        raw.hank[0].rigSetup[0].copy.from = "assets";
      });

      const closure = computeClosure(hankDir);
      expect(closure.ok).toBe(false);
      expect(
        closure.findings.some((f) => f.severity === "error" && /backslash/i.test(f.detail)),
      ).toBe(true);
    },
  );

  it("accepts a DIRECTORY whose name ends in .json as a hank dir", () => {
    const { root, hankDir } = copyFixture();
    const jsonNamedDir = path.join(root, "fixture.json");
    fs.renameSync(hankDir, jsonNamedDir);

    const closure = computeClosure(jsonNamedDir);
    expect(closure.ok).toBe(true);
    expect(closure.hankJsonPath).toBe(path.join(jsonNamedDir, "hank.json"));
  });

  it("is deterministic across repeated runs and mtime-only changes", () => {
    const { hankDir } = copyFixture();
    const first = serializeLock(buildLock(computeClosure(hankDir)));

    // mtime-only change: rewrite every file with its own bytes.
    const touchAll = (dir: string): void => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        const stat = fs.lstatSync(p);
        if (stat.isDirectory()) touchAll(p);
        else if (stat.isFile()) {
          const bytes = fs.readFileSync(p);
          fs.writeFileSync(p, bytes);
        }
      }
    };
    touchAll(hankDir);
    const second = serializeLock(buildLock(computeClosure(hankDir)));
    expect(second).toBe(first);
  });
});

describe("loader gate: a hank that fails to load fails to pack (spec 63 / doc 64)", () => {
  /**
   * Path POLICY lives in the schemas and the runtime loader, not the
   * walker. Textual violations (R1 absolute/backslash, R2 escapes) surface
   * through the walker's own schema parse as schema-error. The
   * filesystem half (R3 symlinks, tree scans, existence) is GATED by
   * loadCodonSequence — a hank it refuses never packs — and REPORTED by the
   * walk, which re-checks the same rules on the captured bytes and names
   * each problem at its field; the loader's own message is only a fallback.
   * These are REPRESENTATIVE cases — the exhaustive rejection matrix lives
   * with the owners, in config.test.ts and hank-dir-refs.test.ts.
   */

  it("rejects an absolute promptFile at the schema layer", () => {
    const { hankDir } = copyFixture();
    editHankJson(hankDir, (raw) => {
      raw.hank[0].promptFile = "/abs/path.md";
    });

    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(false);
    const finding = closure.findings.find((f) => f.category === "schema-error");
    expect(finding?.detail).toContain("absolute or drive-qualified");
  });

  it("rejects an escaping copy.from at the schema layer", () => {
    const { hankDir } = copyFixture();
    editHankJson(hankDir, (raw) => {
      raw.hank[0].rigSetup[0].copy.from = "../outside-tpl";
    });

    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(false);
    const finding = closure.findings.find((f) => f.category === "schema-error");
    expect(finding?.detail).toContain("resolves outside the hank directory");
  });

  it("rejects copy.from spellings that resolve to the hank dir itself via the loader", () => {
    for (const spelling of [".", "prompts/.."]) {
      const { hankDir } = copyFixture();
      editHankJson(hankDir, (raw) => {
        raw.hank[0].rigSetup[0].copy.from = spelling;
      });

      const closure = computeClosure(hankDir);
      expect(closure.ok).toBe(false);
      const finding = closure.findings.find((f) => f.severity === "error");
      expect(finding?.category).toBe("copy-from-hank-dir");
      expect(finding?.where).toBe("codon-1.rigSetup[0].copy.from");
      expect(finding?.detail).toContain("hank directory itself");
    }
  });

  it("rejects a missing promptFile at its field", () => {
    const { hankDir } = copyFixture();
    editHankJson(hankDir, (raw) => {
      raw.hank[0].promptFile = "prompts/nope.md";
    });

    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(false);
    const finding = closure.findings.find((f) => f.category === "missing-file");
    expect(finding?.where).toBe("codon-1.promptFile");
    expect(finding?.detail).toBe("prompts/nope.md does not exist");
    expect(closure.findings.some((f) => f.category === "load-error")).toBe(false);
  });

  it("rejects a directory used as a file field at its field", () => {
    const { hankDir } = copyFixture();
    editHankJson(hankDir, (raw) => {
      raw.hank[1].codons[0].promptFile = "tpl";
    });

    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(false);
    const finding = closure.findings.find((f) => f.category === "missing-file");
    expect(finding?.where).toMatch(/^loop-1\/.*\.promptFile$/);
    expect(finding?.detail).toContain("resolves to a directory");
  });

  it("reports every problem in one pass when the loader refuses", () => {
    // A missing prompt makes the loader refuse; the walk still runs, so the
    // unrelated copy.from problem is reported in the same run — no
    // fix-one-rerun-see-the-next loop.
    const { hankDir } = copyFixture();
    fs.rmSync(path.join(hankDir, "prompts/codon1.md"));
    fs.rmSync(path.join(hankDir, "tpl"), { recursive: true });
    fs.mkdirSync(path.join(hankDir, "tpl"));

    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(false);
    const errors = closure.findings.filter((f) => f.severity === "error");
    expect(errors.map((f) => [f.category, f.where])).toEqual([
      ["missing-file", "codon-1.promptFile"],
      ["empty-copy-root", "codon-1.rigSetup[0].copy.from"],
    ]);
  });

  it("rejects two sentinels with one id inside a codon", () => {
    const { hankDir } = copyFixture();
    editHankJson(hankDir, (raw) => {
      raw.hank[0].sentinels.push({ sentinelConfig: "sentinels/check.json" });
    });

    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(false);
    const finding = closure.findings.find((f) => f.category === "duplicate-sentinel-id");
    expect(finding?.where).toBe("codon-1.sentinels[1].sentinelConfig");
    expect(finding?.detail).toContain('the id "check"');
    expect(closure.findings.some((f) => f.category === "load-error")).toBe(false);
  });

  it("renders a loader refusal the walk did not reproduce one violation per line", () => {
    const hankJsonPath = path.join(path.sep, "h", "hank.json");
    const dir = path.join(path.sep, "h");
    const validation = loaderFailureFindings(
      `Failed to load codon config from ${hankJsonPath}: Codon configuration validation failed:\n` +
        `Codon 1 (review), rig setup item 2: source path "${path.join(dir, "lib")}" does not exist\n` +
        "Codon 5 (validate), sentinel 1: Sentinel config file not found: s.json [WARNING]",
      hankJsonPath,
    );
    expect(validation).toEqual([
      'Codon 1 (review), rig setup item 2: source path "lib" does not exist',
      "Codon 5 (validate), sentinel 1: Sentinel config file not found: s.json",
    ]);
    const prompt = loaderFailureFindings(
      `Failed to load codon config from ${hankJsonPath}: Global system prompt file not found: ${path.join(dir, "system", "system.md")}\n` +
        "  (configured via globalSystemPromptFile in hank.json)",
      hankJsonPath,
    );
    expect(prompt).toEqual([
      `Global system prompt file not found: ${path.join("system", "system.md")} (configured via globalSystemPromptFile in hank.json)`,
    ]);
    expect(loaderFailureFindings("something else entirely", hankJsonPath)).toEqual([
      "something else entirely",
    ]);
  });

  describe.skipIf(process.platform === "win32")("filesystem half (R3)", () => {
    it("rejects a symlinked promptFile (dangling ones included)", () => {
      const linked = copyFixture();
      fs.symlinkSync("codon1.md", path.join(linked.hankDir, "prompts/alias.md"));
      editHankJson(linked.hankDir, (raw) => {
        raw.hank[0].promptFile = "prompts/alias.md";
      });
      const closure = computeClosure(linked.hankDir);
      expect(closure.ok).toBe(false);
      expect(
        closure.findings.some(
          (f) => f.category === "symlink-ref" && f.detail.includes("passes through a symlink"),
        ),
      ).toBe(true);
      expect(closure.findings.some((f) => f.category === "load-error")).toBe(false);

      // Dangling and self-looping links are still just "a symlink" — the
      // walk lstats and never follows, so both reject identically.
      const dangling = copyFixture();
      fs.symlinkSync("does-not-exist.md", path.join(dangling.hankDir, "prompts/broken.md"));
      editHankJson(dangling.hankDir, (raw) => {
        raw.hank[0].promptFile = "prompts/broken.md";
      });
      expect(
        computeClosure(dangling.hankDir).findings.some(
          (f) => f.category === "symlink-ref" && f.detail.includes("passes through a symlink"),
        ),
      ).toBe(true);

      const looping = copyFixture();
      fs.symlinkSync("loop.md", path.join(looping.hankDir, "prompts/loop.md"));
      editHankJson(looping.hankDir, (raw) => {
        raw.hank[0].promptFile = "prompts/loop.md";
      });
      expect(
        computeClosure(looping.hankDir).findings.some(
          (f) => f.category === "symlink-ref" && f.detail.includes("passes through a symlink"),
        ),
      ).toBe(true);
    });

    it("rejects a symlink nested inside a copy.from tree", () => {
      const { hankDir } = copyFixture();
      fs.symlinkSync("README.md", path.join(hankDir, "tpl/alias.md"));

      const closure = computeClosure(hankDir);
      expect(closure.ok).toBe(false);
      expect(
        closure.findings.some(
          (f) =>
            f.category === "symlink-ref" &&
            f.where === "codon-1.rigSetup[0].copy.from" &&
            f.detail ===
              '"tpl" contains a symlink at "tpl/alias.md"; symlinks are not allowed anywhere in a copied tree',
        ),
      ).toBe(true);
    });

    it("rejects a FIFO promptFile without blocking on the read", () => {
      const { hankDir } = copyFixture();
      const { execSync } = require("node:child_process");
      execSync(`mkfifo ${JSON.stringify(path.join(hankDir, "prompts/pipe.md"))}`);
      editHankJson(hankDir, (raw) => {
        raw.hank[0].promptFile = ["prompts/codon1.md", "prompts/pipe.md"];
      });

      const closure = computeClosure(hankDir);
      expect(closure.ok).toBe(false);
      expect(
        closure.findings.some(
          (f) => f.category === "missing-file" && f.detail.includes("not a regular file"),
        ),
      ).toBe(true);
    });
  });
});

describe("walker-side strict-ref enforcement on captured bytes (TOCTOU defense)", () => {
  /**
   * The loader gate validates its OWN read of each config, while the walk
   * runs over captured snapshot bytes. These tests force the two reads to
   * diverge (a config "changing mid-pack") and assert the walker re-vets
   * what it actually bundles instead of trusting the loader's read.
   */

  /** Serve `tampered` for reads of `targetPath` matching `pick` (by 1-based
   * read index); every other read passes through to the real filesystem.
   * The walker captures through a file DESCRIPTOR (open O_NOFOLLOW → read
   * fd), so descriptors opened for the target path are tracked and their
   * reads intercepted too — a path-only hook would silently miss the
   * capture read and the test would assert nothing. */
  function divergeReads(
    targetPath: string,
    tampered: unknown,
    pick: (readIndex: number) => boolean,
  ): { restore: () => void } {
    const realRead = fs.readFileSync;
    const realOpen = fs.openSync;
    const targetFds = new Set<number>();
    let reads = 0;
    const openSpy = spyOn(fs, "openSync").mockImplementation(((
      ...args: Parameters<typeof fs.openSync>
    ) => {
      const fd = realOpen.apply(fs, args);
      if (typeof args[0] === "string" && path.resolve(args[0]) === targetPath) {
        targetFds.add(fd);
      }
      return fd;
    }) as typeof fs.openSync);
    const readSpy = spyOn(fs, "readFileSync").mockImplementation(((
      ...args: Parameters<typeof fs.readFileSync>
    ) => {
      const target = args[0];
      const isTarget =
        typeof target === "number"
          ? targetFds.has(target)
          : path.resolve(String(target)) === targetPath;
      if (isTarget) {
        reads += 1;
        if (pick(reads)) return Buffer.from(JSON.stringify(tampered));
      }
      return realRead.apply(fs, args);
    }) as typeof fs.readFileSync);
    return {
      restore: () => {
        readSpy.mockRestore();
        openSpy.mockRestore();
      },
    };
  }

  it("keeps a loader refusal fatal when the captured refs are valid", () => {
    const { hankDir } = copyFixture();
    const hankPath = path.join(hankDir, "hank.json");
    const changed = JSON.parse(fs.readFileSync(hankPath, "utf8"));
    changed.hank[0].promptFile = "prompts/missing-after-snapshot.md";

    // The snapshot is valid, but the loader's later read sees a broken ref.
    // A clean reporting walk must not override that refusal or publish files.
    const mock = divergeReads(hankPath, changed, (n) => n > 1);
    try {
      const closure = computeClosure(hankDir);
      expect(closure.ok).toBe(false);
      expect(closure.files).toEqual([]);
      const errors = closure.findings.filter((f) => f.severity === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0]?.category).toBe("load-error");
      expect(errors[0]?.detail).toContain(path.join("prompts", "missing-after-snapshot.md"));
      expect(errors[0]?.detail).not.toContain(hankDir);
    } finally {
      mock.restore();
    }
  });

  it("re-vets refs from the captured root config, not the loader's re-read (R2)", () => {
    const { root, hankDir } = copyFixture();
    fs.writeFileSync(path.join(root, "outside.md"), "outside the hank\n");
    const hankPath = path.join(hankDir, "hank.json");
    const tampered = JSON.parse(fs.readFileSync(hankPath, "utf8"));
    tampered.hank[0].promptFile = "../outside.md";

    // Read #1 of hank.json is the walker's capture; the loader re-reads the
    // clean on-disk file afterwards and passes. The captured-bytes schema
    // parse (hankRefStringSchema embeds lexical R1/R2) rejects the escape as
    // schema-error; the walker's validateRef re-vet is the backstop
    // behind it. Either way the escaping ref must not survive.
    const mock = divergeReads(hankPath, tampered, (n) => n === 1);
    try {
      const closure = computeClosure(hankDir);
      expect(closure.ok).toBe(false);
      expect(
        closure.findings.some(
          (f) => f.severity === "error" && f.detail.includes("resolves outside the hank directory"),
        ),
      ).toBe(true);
    } finally {
      mock.restore();
    }
  });

  it.skipIf(process.platform === "win32")(
    "re-runs R3 on captured refs: a symlinked parent is rejected",
    () => {
      const { root, hankDir } = copyFixture();
      fs.mkdirSync(path.join(root, "elsewhere"));
      fs.writeFileSync(path.join(root, "elsewhere/p.md"), "outside via symlink\n");
      // The clean on-disk hank.json never references linked/, so the loader
      // gate passes; only the captured bytes route through the symlink.
      fs.symlinkSync(path.join(root, "elsewhere"), path.join(hankDir, "linked"));
      const hankPath = path.join(hankDir, "hank.json");
      const tampered = JSON.parse(fs.readFileSync(hankPath, "utf8"));
      tampered.hank[0].promptFile = "linked/p.md";

      const mock = divergeReads(hankPath, tampered, (n) => n === 1);
      try {
        const closure = computeClosure(hankDir);
        expect(closure.ok).toBe(false);
        expect(
          closure.findings.some(
            (f) => f.category === "symlink-ref" && f.detail.includes("passes through a symlink"),
          ),
        ).toBe(true);
        // The old walker only lstat'd the final component, so this file
        // would have been silently bundled from OUTSIDE the hank dir.
        expect(closure.files.some((f) => f.bundlePath === "linked/p.md")).toBe(false);
      } finally {
        mock.restore();
      }
    },
  );

  it("schema-validates the captured sentinel config bytes", () => {
    const { hankDir } = copyFixture();
    const sentinelPath = path.join(hankDir, "sentinels/check.json");

    // Read #1 is the loader's (valid on-disk config); the walker's snapshot
    // (read #2) sees tampered, schema-invalid bytes.
    const mock = divergeReads(sentinelPath, { id: "check" }, (n) => n > 1);
    try {
      const closure = computeClosure(hankDir);
      expect(closure.ok).toBe(false);
      expect(
        closure.findings.some(
          (f) => f.category === "schema-error" && f.where.endsWith(".sentinelConfig"),
        ),
      ).toBe(true);
    } finally {
      mock.restore();
    }
  });

  it("re-vets a captured sentinel config's own refs against the hank anchor (R2)", () => {
    const { root, hankDir } = copyFixture();
    fs.writeFileSync(path.join(root, "outside.md"), "outside the hank\n");
    const sentinelPath = path.join(hankDir, "sentinels/check.json");
    const tampered = JSON.parse(fs.readFileSync(sentinelPath, "utf8"));
    // Schema-valid (R1-clean spelling), but ../../ climbs above the hank
    // root from sentinels/ — only validateRef with the real base can tell.
    tampered.userPromptFile = "../../outside.md";

    const mock = divergeReads(sentinelPath, tampered, (n) => n > 1);
    try {
      const closure = computeClosure(hankDir);
      expect(closure.ok).toBe(false);
      expect(
        closure.findings.some(
          (f) =>
            f.category === "ref-escapes" &&
            f.detail.includes("resolves outside the hank directory"),
        ),
      ).toBe(true);
    } finally {
      mock.restore();
    }
  });

  it("rejects a captured copy.from that resolves to the hank root", () => {
    const { hankDir } = copyFixture();
    const hankPath = path.join(hankDir, "hank.json");
    const tampered = JSON.parse(fs.readFileSync(hankPath, "utf8"));
    // "." passes the lexical R1/R2 schema checks and validateRef (it stays
    // in-dir); only refIsHankDir tells it apart — and the loader applies
    // that to its own re-read of the clean on-disk config, not the capture.
    tampered.hank[0].rigSetup[0].copy.from = ".";

    const mock = divergeReads(hankPath, tampered, (n) => n === 1);
    try {
      const closure = computeClosure(hankDir);
      expect(closure.ok).toBe(false);
      expect(
        closure.findings.some(
          (f) => f.category === "copy-from-hank-dir" && f.detail.includes("hank directory itself"),
        ),
      ).toBe(true);
      // The old walker walked the root with bundlePath "" and emitted
      // rootless members like "/hank.json".
      expect(closure.files).toEqual([]);
    } finally {
      mock.restore();
    }
  });
});

describe("platform-equivalent member collisions (portable canonical keys)", () => {
  /**
   * Two member paths distinct on a case-sensitive source ("Foo.md" vs
   * "foo.md", NFC vs NFD spellings) extract to ONE path on Windows or
   * default macOS: one overwrites the other and neither lock hash can
   * verify. Collision, reserved-lock, and ancestor checks therefore compare
   * NFC + case-folded canonical keys, not exact strings.
   */

  it("rejects a member that aliases the reserved hank.lock", () => {
    const { hankDir } = copyFixture();
    fs.writeFileSync(path.join(hankDir, "HANK.LOCK"), "not a lock\n");
    editHankJson(hankDir, (raw) => {
      raw.hank[0].promptFile = ["prompts/codon1.md", "HANK.LOCK"];
    });

    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(false);
    expect(
      closure.findings.some(
        (f) =>
          f.category === "non-portable-path" && f.detail.includes("aliases the reserved hank.lock"),
      ),
    ).toBe(true);
  });

  it("rejects a member aliasing the folded-in hank.json slot (root config under another name)", () => {
    const { hankDir } = copyFixture();
    // Root config becomes alt.json; a sibling file literally named
    // HANK.JSON passes the exact-match occupant check but extracts onto the
    // root config's canonical hank.json slot where names fold.
    const raw = JSON.parse(fs.readFileSync(path.join(hankDir, "hank.json"), "utf8"));
    fs.rmSync(path.join(hankDir, "hank.json"));
    fs.writeFileSync(path.join(hankDir, "HANK.JSON"), "just a file\n");
    raw.hank[0].promptFile = "HANK.JSON";
    fs.writeFileSync(path.join(hankDir, "alt.json"), `${JSON.stringify(raw, null, 2)}\n`);

    const closure = computeClosure(path.join(hankDir, "alt.json"));
    expect(closure.ok).toBe(false);
    expect(
      closure.findings.some(
        (f) => f.category === "non-portable-path" && f.detail.includes("HANK.JSON"),
      ),
    ).toBe(true);
  });

  it("rejects two members that differ only by case (case-sensitive source)", () => {
    const { hankDir } = copyFixture();
    fs.writeFileSync(path.join(hankDir, "prompts/Extra.md"), "upper\n");
    // On a case-insensitive dev filesystem (default macOS) the two names
    // are ONE file and the collision cannot be constructed — the CI legs on
    // case-sensitive filesystems carry this assertion.
    if (fs.existsSync(path.join(hankDir, "prompts/extra.md"))) return;
    fs.writeFileSync(path.join(hankDir, "prompts/extra.md"), "lower\n");
    editHankJson(hankDir, (raw) => {
      raw.hank[0].promptFile = ["prompts/Extra.md", "prompts/extra.md"];
    });

    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(false);
    expect(
      closure.findings.some(
        (f) =>
          f.category === "non-portable-path" && f.detail.includes("are distinct here but alias"),
      ),
    ).toBe(true);
  });

  it("rejects two directory spellings that alias (a copy root would gain files where names fold)", () => {
    const { hankDir } = copyFixture();
    // On a case-insensitive dev filesystem TPL IS the fixture's tpl copy
    // root and the two-spellings source cannot be constructed — the CI legs
    // on case-sensitive filesystems carry this assertion.
    if (fs.existsSync(path.join(hankDir, "TPL"))) return;
    fs.mkdirSync(path.join(hankDir, "TPL"));
    fs.writeFileSync(path.join(hankDir, "TPL/extra.md"), "rides into tpl/ where names fold\n");
    editHankJson(hankDir, (raw) => {
      raw.hank[0].promptFile = ["prompts/codon1.md", "TPL/extra.md"];
    });

    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(false);
    expect(
      closure.findings.some(
        (f) =>
          f.category === "non-portable-path" &&
          f.detail.includes("bundle directories") &&
          f.detail.includes("are distinct here but alias"),
      ),
    ).toBe(true);
  });

  it("rejects a member under a directory that aliases the reserved hank.lock", () => {
    const { hankDir } = copyFixture();
    fs.mkdirSync(path.join(hankDir, "HANK.LOCK"));
    // Where names fold, this directory IS hank.lock and the existing
    // reserved-path gate refuses before the walk; the canonical-prefix
    // assertion needs a case-sensitive source.
    if (fs.existsSync(path.join(hankDir, "hank.lock"))) return;
    fs.writeFileSync(path.join(hankDir, "HANK.LOCK/x.md"), "extracts under the lock name\n");
    editHankJson(hankDir, (raw) => {
      raw.hank[0].promptFile = ["prompts/codon1.md", "HANK.LOCK/x.md"];
    });

    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(false);
    expect(
      closure.findings.some(
        (f) =>
          f.category === "non-portable-path" &&
          f.detail.includes("aliases the reserved hank.lock member"),
      ),
    ).toBe(true);
  });

  it("extendClosure rejects platform-equivalent members (pure, all platforms)", () => {
    const closure = computeClosure(FIXTURE);
    expect(closure.ok).toBe(true);
    const bytes = Buffer.from("aux\n");

    // Aliases a native member.
    expect(() => extendClosure(closure, [{ bundlePath: "PROMPTS/CODON1.md", bytes }])).toThrow(
      /aliases existing bundle member prompts\/codon1\.md/,
    );

    // Aliases the reserved lock.
    expect(() => extendClosure(closure, [{ bundlePath: "HANK.LOCK", bytes }])).toThrow(
      /hank\.lock is reserved/,
    );

    // Lands inside a copy root via a case variant.
    expect(() => extendClosure(closure, [{ bundlePath: "TPL/extra.md", bytes }])).toThrow(
      /lands inside copy root tpl\//,
    );

    // A native FILE member is this member's ancestor after folding.
    expect(() =>
      extendClosure(closure, [{ bundlePath: "SENTINELS/CHECK.JSON/extra.md", bytes }]),
    ).toThrow(/existing member sentinels\/check\.json is a file, not a directory/);

    // Two auxiliary members aliasing each other.
    expect(() =>
      extendClosure(closure, [
        { bundlePath: "notes/A.md", bytes },
        { bundlePath: "NOTES/a.md", bytes },
      ]),
    ).toThrow(/aliases existing bundle member notes\/A\.md/);
  });
});

describe("closure extension seam (issue 07)", () => {
  /**
   * extendClosure is the producer-side opening of the "member set is open"
   * rule: auxiliary members (U14's comments.jsonl) pass the same gates as
   * native members and flow into files → lock → bundleHash untouched.
   */

  it("extends the closure with an auxiliary member that reaches files and bundleHash", () => {
    const closure = computeClosure(FIXTURE);
    expect(closure.ok).toBe(true);
    const baseLock = buildLock(closure, { minRuntime: "1.0.0" });

    const bytesA = Buffer.from('{"comment":"A"}\n', "utf8");
    const extendedA = extendClosure(closure, [{ bundlePath: "comments.jsonl", bytes: bytesA }]);
    const lockA = buildLock(extendedA, { minRuntime: "1.0.0" });

    const entry = extendedA.files.find((f) => f.bundlePath === "comments.jsonl");
    expect(entry).toBeDefined();
    expect(entry?.sha256).toBe(sha256Hex(bytesA));
    expect(entry?.mode).toBe("644");
    expect(lockA.files["comments.jsonl"]).toEqual({ mode: "644", sha256: sha256Hex(bytesA) });
    expect(lockA.bundleHash).not.toBe(baseLock.bundleHash);

    // Different auxiliary bytes → different identity (a registry must not
    // dedupe two bundles differing only in comments).
    const bytesB = Buffer.from('{"comment":"B"}\n', "utf8");
    const lockB = buildLock(
      extendClosure(closure, [{ bundlePath: "comments.jsonl", bytes: bytesB }]),
      { minRuntime: "1.0.0" },
    );
    expect(lockB.bundleHash).not.toBe(lockA.bundleHash);

    // Non-mutating: the original closure is untouched.
    expect(closure.files.some((f) => f.bundlePath === "comments.jsonl")).toBe(false);
  });

  it("snapshots auxiliary bytes: a caller mutating its buffer later cannot desync hash and bytes", () => {
    const closure = computeClosure(FIXTURE);
    expect(closure.ok).toBe(true);

    const callerBuf = Buffer.from("original contents\n", "utf8");
    const extended = extendClosure(closure, [{ bundlePath: "extra.txt", bytes: callerBuf }]);
    // Producer reuses its buffer after the call — the closure entry must
    // keep the bytes it hashed, or the archive writer ships bytes that no
    // longer match the lock.
    callerBuf.fill(0);

    const entry = extended.files.find((f) => f.bundlePath === "extra.txt");
    expect(entry?.bytes.toString("utf8")).toBe("original contents\n");
    expect(sha256Hex(entry?.bytes as Buffer)).toBe(entry?.sha256 as string);
  });

  it("rejects reserved, traversal, and colliding member paths", () => {
    const closure = computeClosure(FIXTURE);
    expect(closure.ok).toBe(true);
    const bytes = Buffer.from("x\n", "utf8");
    const cases: [string, RegExp][] = [
      ["hank.json", /collides with an existing bundle member/],
      [`bad${String.fromCharCode(0)}name.txt`, /NUL bytes/],
      ["../comments.jsonl", /no empty, '\.' or '\.\.' segments/],
      ["./comments.jsonl", /no empty, '\.' or '\.\.' segments/],
      ["a//b.txt", /no empty, '\.' or '\.\.' segments/],
      ["/comments.jsonl", /must be relative/],
      ["hank.lock", /reserved/],
      // The runtime lock member is a FILE at the root; nothing may nest
      // beneath that name in any extracted filesystem.
      ["hank.lock/comments.jsonl", /reserved/],
      // Existing FILE member as a parent dir of the new member:
      ["prompts/codon1.md/extra.txt", /is a file, not a directory/],
      // New member would be a parent dir of existing members:
      ["prompts", /parent directory of existing member/],
    ];
    for (const [bundlePath, expected] of cases) {
      expect(() => extendClosure(closure, [{ bundlePath, bytes }])).toThrow(expected);
    }

    // Two additions colliding with each other are also caught.
    expect(() =>
      extendClosure(closure, [
        { bundlePath: "comments.jsonl", bytes },
        { bundlePath: "comments.jsonl", bytes },
      ]),
    ).toThrow(/collides with an existing bundle member/);
  });

  it("rejects members inside a directory copy root (rig copy would sweep unhashed bytes)", () => {
    const { hankDir } = copyFixture();
    editHankJson(hankDir, (raw) => {
      raw.hank[0].rigSetup[0].copy.from = "prompts";
    });
    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(true);

    // The extracted prompts/ tree is copied into the rig at run time; an
    // auxiliary member inside it would ride along without being part of
    // the copy's tree hash or the owning codon's codonInputs.
    expect(() =>
      extendClosure(closure, [{ bundlePath: "prompts/injected.md", bytes: Buffer.from("x\n") }]),
    ).toThrow(/copy root/);

    // Members outside every copy root still extend fine.
    const extended = extendClosure(closure, [
      { bundlePath: "comments.jsonl", bytes: Buffer.from("{}\n") },
    ]);
    expect(extended.files.some((f) => f.bundlePath === "comments.jsonl")).toBe(true);
  });
});

describe("runtime/packer resolution parity (issue 06)", () => {
  /**
   * The walker mirrors the runtime loaders; these tests run the REAL
   * loaders and demand identical answers, turning the mirror from a
   * comment into an executable guarantee. The loaders are the oracle: if
   * one of these fails, the bundle would pack different bytes than the
   * runtime actually loads — fix the walker (or knowingly change both
   * sides), NEVER relax the assertion to make it pass.
   */

  it("resolves the global system prompt to the same content as loadGlobalSystemPrompt", () => {
    const parsed = hankFileSchema.parse(
      JSON.parse(fs.readFileSync(path.join(FIXTURE, "hank.json"), "utf8")),
    );
    const loaded = loadGlobalSystemPrompt(parsed, FIXTURE);

    const closure = computeClosure(FIXTURE);
    expect(closure.ok).toBe(true);
    const entry = closure.files.find((f) => f.bundlePath === "prompts/global-system.md");
    expect(entry).toBeDefined();
    const packed = entry?.bytes.toString("utf8") as string;
    if (loaded !== packed) {
      throw new Error(
        `Walker and runtime disagree on the global system prompt: the bundle\n` +
          `would contain different bytes than loadGlobalSystemPrompt loads.\n` +
          `One side's resolution (anchor or precedence) changed without the\n` +
          `other — fix the divergence, never this test.\n` +
          `runtime loaded:  ${JSON.stringify(loaded?.slice(0, 80))}\n` +
          `walker captured: ${JSON.stringify(packed.slice(0, 80))}`,
      );
    }
  });

  it("resolves a file-based sentinel and its nested refs from the config file's dir, like the loader", () => {
    const closure = computeClosure(FIXTURE);
    expect(closure.ok).toBe(true);
    const record = closure.refs.get(refKey(FIXTURE, "sentinels/check.json"));
    expect(record).toBeDefined();

    const parsed = hankFileSchema.parse(
      JSON.parse(fs.readFileSync(path.join(FIXTURE, "hank.json"), "utf8")),
    );
    const codon = parsed.hank[0] as { sentinels: unknown };
    const result = new SentinelConfigLoader().loadConfigsForCodon(
      codon.sentinels as Parameters<SentinelConfigLoader["loadConfigsForCodon"]>[0],
      "codon-1",
      FIXTURE,
    );
    expect(result.errors).toEqual([]);
    const loaded = result.configs[0];
    expect(loaded?.source).toBe("file");
    // Same config file…
    expect(loaded?.sourcePath).toBe(record?.resolved as string);
    // …and the same base dir for the config's own refs: the walker keyed
    // them by the config file's directory, exactly where the loader will
    // resolve promptFile/schemaFile from.
    const configDir = loaded?.configDirectory as string;
    expect(configDir).toBe(path.dirname(record?.resolved as string));
    for (const raw of ["../prompts/check-user.md", "check-schema.ts"]) {
      const ref = closure.refs.get(refKey(configDir, raw));
      expect(ref).toBeDefined();
      expect(ref?.resolved).toBe(path.resolve(configDir, raw));
    }
  });

  it("resolves an inline sentinel's refs from the hank dir, like the loader", () => {
    const { hankDir } = copyFixture();
    const inline = {
      id: "inline-check",
      name: "Inline checker",
      trigger: { type: "event", on: ["*"] },
      execution: { strategy: "immediate" },
      model: "anthropic/claude-haiku-4-5",
      userPromptFile: "prompts/check-user.md",
    };
    editHankJson(hankDir, (raw) => {
      raw.hank[0].sentinels = [{ sentinelConfig: inline }];
    });

    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(true);

    const parsed = hankFileSchema.parse(
      JSON.parse(fs.readFileSync(path.join(hankDir, "hank.json"), "utf8")),
    );
    const codon = parsed.hank[0] as { sentinels: unknown };
    const result = new SentinelConfigLoader().loadConfigsForCodon(
      codon.sentinels as Parameters<SentinelConfigLoader["loadConfigsForCodon"]>[0],
      "codon-1",
      hankDir,
    );
    expect(result.errors).toEqual([]);
    const loaded = result.configs[0];
    expect(loaded?.source).toBe("inline");
    expect(loaded?.configDirectory).toBe(hankDir);

    const ref = closure.refs.get(refKey(hankDir, "prompts/check-user.md"));
    expect(ref).toBeDefined();
    expect(ref?.resolved).toBe(path.resolve(hankDir, "prompts/check-user.md"));
  });

  it("never resolves outputs or workspace targets as closure refs", () => {
    const closure = computeClosure(FIXTURE);
    expect(closure.ok).toBe(true);
    // copy.to ("workspace/tpl") and outputFiles[].copy ("out/**") are what
    // the run WRITES — no ref record, no bundle member.
    const refRaws = [...closure.refs.values()].map((r) => r.raw);
    expect(refRaws).not.toContain("workspace/tpl");
    expect(refRaws).not.toContain("out/**");
    const memberPaths = closure.files.map((f) => f.bundlePath);
    expect(memberPaths.some((p) => p === "workspace/tpl" || p.startsWith("workspace/"))).toBe(
      false,
    );
    expect(memberPaths.some((p) => p.startsWith("out/"))).toBe(false);
  });
});

describe("schema-drift canary (codebase-delta item 3, issue 06)", () => {
  /**
   * Walk the Zod schemas and collect EVERY property whose value can be a
   * free-form string (directly, or inside an array/union/record) — not just
   * name-matched "path-shaped" keys: a name heuristic silently misses a new
   * input field with an innocuous name (issue 06). Every collected key must
   * be deliberately classified below. If this test fails, a string field was
   * added to (or removed from) the schemas: decide whether it is a closure
   * input; if so, extend the closure walker in server/pack/closure.ts (spec
   * §4.1 table) FIRST — then update the matching list. Do not update the
   * lists without that decision; that is exactly the silent escape this
   * canary exists to prevent.
   */
  const CLOSURE_INPUT_FIELDS = [
    "codon.appendSystemPromptFile",
    "codon.promptFile",
    "codon.rigSetup.copy.from",
    "codon.sentinels.sentinelConfig", // when a string: file ref (hank-dir-relative)
    "codon.sentinels.sentinelConfig.structuredOutput.schemaFile",
    "codon.sentinels.sentinelConfig.systemPromptFile",
    "codon.sentinels.sentinelConfig.userPromptFile",
    "hankFile.globalSystemPromptFile",
    // loop children reuse the shared nested schemas (rigSetup, sentinels…),
    // which the codon root already claimed; only per-instance string fields
    // surface again under loop.codons.
    "loop.codons.appendSystemPromptFile",
    "loop.codons.promptFile",
  ].sort();

  /** String-valued fields that are deliberately NOT closure inputs. Grouped
   * by why (spec §4.1 "explicitly OUT of closure" and plain non-paths). */
  const KNOWN_NON_CLOSURE_FIELDS = [
    // Runtime outputs / workspace targets — paths the run WRITES:
    "codon.archiveOnSuccess",
    "codon.checkpointedFiles",
    "codon.outputFiles.copy", // workspace output globs
    "codon.rigSetup.copy.to", // workspace target, never a closure input
    "codon.sentinels.sentinelConfig.output.file",
    "codon.sentinels.sentinelConfig.output.lastValueFile",
    "codon.sentinels.settings.outputPaths.lastValueFile",
    "codon.sentinels.settings.outputPaths.logFile",
    "loop.archiveOnSuccess",
    "loop.codons.archiveOnSuccess",
    "loop.codons.checkpointedFiles",
    // Inline content — ships inside the config document itself:
    "codon.appendSystemPromptText",
    "codon.env", // record of inline values (lint-only: inline-env / home-ref)
    "codon.exhaustWithPrompt",
    "codon.promptText",
    "codon.sentinels.sentinelConfig.joinString",
    "codon.sentinels.sentinelConfig.structuredOutput.enumValues",
    "codon.sentinels.sentinelConfig.structuredOutput.schemaDescription",
    "codon.sentinels.sentinelConfig.structuredOutput.schemaName",
    "codon.sentinels.sentinelConfig.structuredOutput.schemaStr",
    "codon.sentinels.sentinelConfig.systemPromptText",
    "codon.sentinels.sentinelConfig.userPromptText",
    "hankFile.globalSystemPromptText",
    "loop.codons.appendSystemPromptText",
    "loop.codons.env",
    "loop.codons.exhaustWithPrompt",
    "loop.codons.promptText",
    // Commands — linted (network-op / home-ref), never resolved:
    "codon.outputFiles.beforeCopy.command.run",
    "codon.rigSetup.command.run",
    // Identity / metadata / matchers — not filesystem paths at all:
    "codon.description",
    "codon.id",
    "codon.model",
    "codon.name",
    "codon.sentinels.sentinelConfig.description",
    "codon.sentinels.sentinelConfig.id",
    "codon.sentinels.sentinelConfig.model",
    "codon.sentinels.sentinelConfig.name",
    "codon.sentinels.sentinelConfig.trigger.conditions.path", // JSON path into output, not fs
    "codon.sentinels.sentinelConfig.trigger.conditions.value",
    "codon.sentinels.sentinelConfig.trigger.interestFilter.on",
    "codon.sentinels.sentinelConfig.trigger.on", // event names
    "codon.sentinels.sentinelConfig.trigger.pattern.type",
    "hankFile.$schema",
    "hankFile.meta.author",
    "hankFile.meta.description",
    "hankFile.meta.name",
    "hankFile.meta.version",
    "hankFile.overrides.model",
    "hankFile.requirements.env",
    "hankFile.requirements.tools",
    "loop.codons.description",
    "loop.codons.id",
    "loop.codons.model",
    "loop.codons.name",
    "loop.description",
    "loop.id",
    "loop.name",
  ].sort();

  function def(s: unknown): Record<string, unknown> | undefined {
    return (s as { _def?: Record<string, unknown> })?._def;
  }

  type SchemaDefinition = Record<string, unknown>;
  type ChildReader = (definition: SchemaDefinition) => unknown[];

  // Wrappers keep the same contextual path. Objects are handled separately
  // because their property names add path segments.
  const schemaChildren = new Map<string, ChildReader>([
    ["ZodOptional", (d) => [d.innerType]],
    ["ZodNullable", (d) => [d.innerType]],
    ["ZodDefault", (d) => [d.innerType]],
    ["ZodEffects", (d) => [d.schema]],
    ["ZodBranded", (d) => [d.type ?? d.innerType]],
    ["ZodReadonly", (d) => [d.type ?? d.innerType]],
    ["ZodCatch", (d) => [d.type ?? d.innerType]],
    ["ZodArray", (d) => [d.type]],
    ["ZodUnion", (d) => d.options as unknown[]],
    ["ZodDiscriminatedUnion", (d) => d.options as unknown[]],
    ["ZodRecord", (d) => [d.keyType, d.valueType]],
    ["ZodTuple", (d) => (d.items as unknown[]) ?? []],
    ["ZodIntersection", (d) => [d.left, d.right]],
    ["ZodPipeline", (d) => [d.in, d.out]],
    ["ZodLazy", (d) => [(d.getter as () => unknown)()]],
  ]);

  function childSchemas(d: SchemaDefinition): unknown[] {
    const read = schemaChildren.get(d.typeName as string);
    return read ? read(d) : [];
  }

  /** True when this property's VALUE can itself be a free-form string
   * (directly or via array/union/record/tuple). Deliberately false for
   * ZodObject (nested keys are collected on recursion under their own
   * names) and for enums/literals (constrained, cannot hold a path). */
  function containsFreeString(schema: unknown, seen: Set<unknown>): boolean {
    const d = def(schema);
    if (!d || seen.has(schema)) return false;
    seen.add(schema);
    if (d.typeName === "ZodString") return true;
    // Record keys do not make the property's VALUE a free-form string.
    if (d.typeName === "ZodRecord") return containsFreeString(d.valueType, seen);
    return childSchemas(d).some((child) => containsFreeString(child, seen));
  }

  function collectObjectKeys(
    d: SchemaDefinition,
    found: Set<string>,
    seen: Set<unknown>,
    prefix: string,
  ): void {
    const shapeGetter = d.shape as (() => Record<string, unknown>) | Record<string, unknown>;
    const shape = typeof shapeGetter === "function" ? shapeGetter() : shapeGetter;
    for (const [key, value] of Object.entries(shape)) {
      const at = prefix === "" ? key : `${prefix}.${key}`;
      if (containsFreeString(value, new Set())) found.add(at);
      collectKeys(value, found, seen, at);
    }
  }

  /** Collect the CONTEXTUAL path of every free-string property — e.g.
   * "rigSetup.copy.from", never the bare leaf "from". Bare leaf names made
   * the canary blind to a future input field reusing an already-classified
   * generic name like path/file/copy (issue: the most likely collisions
   * are exactly the short names). Wrappers (arrays, unions, optionals…)
   * add no segment: the dotted path reads as "object keys on the way
   * down". */
  function collectKeys(
    schema: unknown,
    found: Set<string>,
    seen: Set<unknown>,
    prefix: string,
  ): void {
    const d = def(schema);
    if (!d || seen.has(schema)) return;
    seen.add(schema);
    if (d.typeName === "ZodObject") {
      collectObjectKeys(d, found, seen, prefix);
      return;
    }
    for (const child of childSchemas(d)) collectKeys(child, found, seen, prefix);
  }

  it("every string-valued schema field is classified as closure input or known non-input", () => {
    const found = new Set<string>();
    const seen = new Set<unknown>();
    // Root-qualified so every path is deterministic even when the same
    // nested schema instance is reachable from several roots (first root
    // to reach it claims it via the shared seen-set).
    const roots: [string, unknown][] = [
      ["hankFile", hankFileSchema],
      ["codon", codonObjectSchema],
      ["loop", loopSchema],
      ["rigSetupItem", rigSetupItemSchema],
      ["codonSentinelEntry", codonSentinelEntrySchema],
      ["sentinelConfig", sentinelConfigSchema],
    ];
    for (const [rootName, schema] of roots) {
      collectKeys(schema, found, seen, rootName);
    }

    const expected = new Set([...CLOSURE_INPUT_FIELDS, ...KNOWN_NON_CLOSURE_FIELDS]);
    // Fail with instructions, not a raw array diff — this test's job is to
    // route whoever added/removed a schema field to the right checklist.
    const unclassified = [...found].filter((k) => !expected.has(k)).sort();
    const stale = [...expected].filter((k) => !found.has(k)).sort();
    if (unclassified.length > 0) {
      throw new Error(
        `New string-valued schema field(s) not classified: ${unclassified.join(", ")}.\n` +
          `Decide for each: is it a file the hank READS (closure input) or not?\n` +
          `  input     → extend the walker in server/pack/closure.ts with the SAME\n` +
          `              anchor the runtime loader uses (checklist at hankFileSchema\n` +
          `              in config.ts), add it to CLOSURE_INPUT_FIELDS here, and add\n` +
          `              a resolution-parity test case.\n` +
          `  non-input → add it to KNOWN_NON_CLOSURE_FIELDS with a comment saying why.\n` +
          `Do NOT just add the name to a list — that is the silent escape this\n` +
          `canary exists to prevent.`,
      );
    }
    if (stale.length > 0) {
      throw new Error(
        `Classified field(s) no longer in the schemas: ${stale.join(", ")}.\n` +
          `If the field was removed, delete it from the list here AND from the\n` +
          `walker in server/pack/closure.ts if it was a closure input.`,
      );
    }
  });
});

describe("copy-tree ignore rules (root .gitignore or implicit defaults)", () => {
  it.each(["symlink", "directory"] as const)(
    "reports a %s root rules file and still checks unrelated refs",
    (kind) => {
      const { hankDir } = copyFixture();
      const rulesPath = path.join(hankDir, ".gitignore");
      if (kind === "symlink") {
        fs.writeFileSync(path.join(hankDir, "rules.txt"), "");
        fs.symlinkSync("rules.txt", rulesPath);
      } else {
        fs.mkdirSync(rulesPath);
      }
      fs.rmSync(path.join(hankDir, "prompts/codon2.md"));

      const closure = computeClosure(hankDir);
      expect(closure.ok).toBe(false);
      expect(closure.files).toEqual([]);
      const errors = closure.findings.filter((f) => f.severity === "error");
      expect(errors.map((f) => [f.category, f.where])).toEqual([
        ["copy-tree-error", "codon-1.rigSetup[0].copy.from"],
        ["missing-file", "loop-1/codon-2.promptFile"],
      ]);
      expect(errors[0]?.detail).toBe(
        `.gitignore at the hank root is ${kind === "symlink" ? "a symlink" : "not a regular file"} (.gitignore); the copy-tree ignore rules must be a regular file`,
      );

      // Rules only govern directory copies. A malformed file must remain
      // irrelevant when the hank has no such references.
      editHankJson(hankDir, (raw) => {
        raw.hank[0].rigSetup = [];
        raw.hank[1].codons[0].promptFile = "prompts/codon1.md";
      });
      const withoutTree = computeClosure(hankDir);
      expect(withoutTree.ok).toBe(true);
      expect(withoutTree.files.some((f) => f.bundlePath === ".gitignore")).toBe(false);
    },
  );

  it("reports nested rules at the copy field with a hank-relative path", () => {
    const { hankDir } = copyFixture();
    fs.writeFileSync(path.join(hankDir, "tpl/.gitignore"), "*.log\n");
    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(false);
    const errors = closure.findings.filter((f) => f.severity === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.category).toBe("invalid-ignore-rules");
    expect(errors[0]?.where).toBe("codon-1.rigSetup[0].copy.from");
    expect(errors[0]?.detail).toContain(`nested .gitignore at "${path.join("tpl", ".gitignore")}"`);
    expect(errors[0]?.detail).not.toContain(hankDir);
  });

  it("reports an ignore-filtered empty tree once, without empty-directory warnings", () => {
    const { hankDir } = copyFixture();
    fs.rmSync(path.join(hankDir, "tpl"), { recursive: true });
    fs.mkdirSync(path.join(hankDir, "tpl/empty"), { recursive: true });
    fs.writeFileSync(path.join(hankDir, "tpl/debug.log"), "ignored\n");
    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(false);
    expect(closure.findings.filter((f) => f.category === "empty-copy-root")).toHaveLength(1);
    expect(closure.findings.some((f) => f.category === "empty-dir")).toBe(false);
    expect(closure.findings.some((f) => f.category === "ignored-paths")).toBe(false);
  });

  it("excludes default-ignored entries from a copy tree and warns once per root", () => {
    const { hankDir } = copyFixture();
    fs.mkdirSync(path.join(hankDir, "tpl/node_modules/pkg"), { recursive: true });
    fs.writeFileSync(path.join(hankDir, "tpl/node_modules/pkg/index.js"), "junk\n");
    fs.mkdirSync(path.join(hankDir, "tpl/.git"));
    fs.writeFileSync(path.join(hankDir, "tpl/.git/config"), "[core]\n");
    fs.writeFileSync(path.join(hankDir, "tpl/debug.log"), "noise\n");

    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(true);
    const bundlePaths = closure.files.map((f) => f.bundlePath);
    expect(bundlePaths).toContain("tpl/README.md");
    expect(bundlePaths.some((p) => p.includes("node_modules"))).toBe(false);
    expect(bundlePaths.some((p) => p.includes(".git"))).toBe(false);
    expect(bundlePaths).not.toContain("tpl/debug.log");

    const warns = closure.findings.filter((f) => f.category === "ignored-paths");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.severity).toBe("warn");
    expect(warns[0]?.detail).toContain("3 entries excluded by the default ignore rules");
  });

  it("a symlink inside an ignored node_modules no longer blocks pack", () => {
    const { hankDir } = copyFixture();
    fs.mkdirSync(path.join(hankDir, "tpl/node_modules/.bin"), { recursive: true });
    fs.symlinkSync("../pkg/cli.js", path.join(hankDir, "tpl/node_modules/.bin/cli"));

    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(true);
    expect(closure.files.some((f) => f.bundlePath.includes("node_modules"))).toBe(false);
  });

  it("an explicit .gitignore replaces the defaults, ships as a member, and .git/ stays pruned", () => {
    const { hankDir } = copyFixture();
    // Only extra.txt is excluded by authored rules; defaults no longer apply.
    const gitignoreBody = "extra.txt\n";
    fs.writeFileSync(path.join(hankDir, ".gitignore"), gitignoreBody);
    fs.mkdirSync(path.join(hankDir, "tpl/dist"));
    fs.writeFileSync(path.join(hankDir, "tpl/dist/out.js"), "built\n");
    fs.writeFileSync(path.join(hankDir, "tpl/extra.txt"), "authored-ignored\n");
    fs.mkdirSync(path.join(hankDir, "tpl/coverage"));
    fs.writeFileSync(path.join(hankDir, "tpl/coverage/lcov.info"), "readmitted\n");
    fs.mkdirSync(path.join(hankDir, "tpl/.git"));
    fs.writeFileSync(path.join(hankDir, "tpl/.git/config"), "[core]\n");

    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(true);
    const bundlePaths = closure.files.map((f) => f.bundlePath);
    expect(bundlePaths).toContain("tpl/dist/out.js");
    expect(bundlePaths).not.toContain("tpl/extra.txt");
    expect(bundlePaths).toContain("tpl/coverage/lcov.info");
    expect(bundlePaths.some((p) => p.includes(".git/"))).toBe(false);

    const member = closure.files.find((f) => f.bundlePath === ".gitignore");
    expect(member).toBeDefined();
    expect(member?.sha256).toBe(sha256Hex(Buffer.from(gitignoreBody)));
    const warn = closure.findings.find((f) => f.category === "ignored-paths");
    expect(warn?.detail).toContain("the hank .gitignore");
  });

  it("without an explicit .gitignore no .gitignore member is invented", () => {
    const closure = computeClosure(FIXTURE);
    expect(closure.ok).toBe(true);
    expect(closure.files.some((f) => f.bundlePath === ".gitignore")).toBe(false);
  });

  it("errors empty-copy-root mentioning ignore rules when everything in the tree is ignored", () => {
    const { hankDir } = copyFixture();
    fs.mkdirSync(path.join(hankDir, "junk-root/node_modules"), { recursive: true });
    fs.writeFileSync(path.join(hankDir, "junk-root/node_modules/a.js"), "junk\n");
    editHankJson(hankDir, (raw) => {
      raw.hank[0].rigSetup[0].copy.from = "junk-root";
    });

    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(false);
    const finding = closure.findings.find((f) => f.category === "empty-copy-root");
    expect(finding?.detail).toContain("after ignore rules");
  });

  it("a copy root that is ITSELF ignored fails the loader gate (packs iff runs)", () => {
    const { hankDir } = copyFixture();
    fs.mkdirSync(path.join(hankDir, "dist"));
    fs.writeFileSync(path.join(hankDir, "dist/out.js"), "built\n");
    editHankJson(hankDir, (raw) => {
      raw.hank[0].rigSetup[0].copy.from = "dist";
    });

    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(false);
    const finding = closure.findings.find((f) => f.category === "ignored-copy-root");
    expect(finding?.where).toBe("codon-1.rigSetup[0].copy.from");
    expect(finding?.detail).toContain("excluded by the hank's ignore rules");
  });

  it("a direct ref to an ignored file inside a copy root still ships (explicit refs win)", () => {
    const { hankDir } = copyFixture();
    fs.writeFileSync(path.join(hankDir, "tpl/notes.log"), "explicitly referenced\n");
    editHankJson(hankDir, (raw) => {
      raw.hank[0].promptFile = "tpl/notes.log";
    });

    // The tree walk skips notes.log (*.log default) but the promptFile ref
    // adds it as a member — the closure self-check must not count it into
    // the tpl tree hash (it rehashes with the same filter the walk used).
    const closure = computeClosure(hankDir);
    expect(closure.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(closure.ok).toBe(true);
    expect(closure.files.some((f) => f.bundlePath === "tpl/notes.log")).toBe(true);

    // And the tree hash is identical to the same hank without the junk —
    // the member rides along without perturbing the copy tree's identity.
    const { hankDir: cleanDir } = copyFixture();
    const cleanTree = [...computeClosure(cleanDir).refs.values()].find((r) => r.kind === "dir");
    const tree = [...closure.refs.values()].find((r) => r.kind === "dir");
    expect(tree?.sha256).toBe(cleanTree?.sha256 ?? "missing");
  });

  it("rejects a native member whose name folds onto the .gitignore slot", () => {
    const { hankDir } = copyFixture();
    // No lowercase .gitignore exists (implicit-defaults mode); a variant
    // spelling would extract INTO the rules slot where names fold.
    fs.writeFileSync(path.join(hankDir, ".GITIGNORE"), "*.md\n");
    editHankJson(hankDir, (raw) => {
      raw.hank[0].promptFile = ".GITIGNORE";
    });

    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(false);
    const finding = closure.findings.find((f) => f.category === "non-portable-path");
    expect(finding?.detail).toContain(".gitignore");
  });

  it("rejects a native member under a directory folding onto the .gitignore slot", () => {
    const { hankDir } = copyFixture();
    fs.mkdirSync(path.join(hankDir, ".GITIGNORE"));
    fs.writeFileSync(path.join(hankDir, ".GITIGNORE/notes.md"), "nested\n");
    editHankJson(hankDir, (raw) => {
      // Drop the copy ref: on a case-insensitive source the loader would
      // otherwise find the .GITIGNORE DIRECTORY at .gitignore and fail
      // first — this test pins the walker's own prefix reservation.
      raw.hank[0].rigSetup = undefined;
      raw.hank[0].promptFile = ".GITIGNORE/notes.md";
    });

    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(false);
    const finding = closure.findings.find((f) => f.category === "non-portable-path");
    expect(finding?.detail).toContain("ignore rules");
  });

  it("extendClosure reserves the .gitignore slot even when no explicit .gitignore exists", () => {
    const closure = computeClosure(FIXTURE);
    expect(closure.ok).toBe(true);
    const bytes = Buffer.from("*.md\n");
    expect(() => extendClosure(closure, [{ bundlePath: ".gitignore", bytes }])).toThrow(
      /\.gitignore is reserved/,
    );
    expect(() => extendClosure(closure, [{ bundlePath: ".GITIGNORE", bytes }])).toThrow(
      /\.gitignore is reserved/,
    );
    expect(() => extendClosure(closure, [{ bundlePath: ".gitignore/nested.txt", bytes }])).toThrow(
      /\.gitignore is reserved/,
    );
  });
});
