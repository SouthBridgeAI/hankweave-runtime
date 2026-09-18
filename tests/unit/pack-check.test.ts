import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeClosure } from "../../server/pack/closure.js";

const FIXTURE = path.resolve(process.cwd(), "tests/fixtures/pack-fixture");

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function copyFixture(): { root: string; hankDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pack-check-"));
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

describe("pack portability lint (spec §4.5)", () => {
  it("warns on the fixture's known portability hazards and stays ok", () => {
    const closure = computeClosure(FIXTURE);
    expect(closure.ok).toBe(true);

    const categories = new Set(
      closure.findings.filter((f) => f.severity === "warn").map((f) => f.category),
    );
    // echo $HOME in the rig command
    expect(categories.has("home-ref")).toBe(true);
    // git clone (rigSetup) and bun install (beforeCopy)
    expect(categories.has("network-op")).toBe(true);
    // FIXTURE_API_KEY env key looks secret-like
    expect(categories.has("inline-env")).toBe(true);
    expect(closure.findings.some((f) => f.severity === "error")).toBe(false);
  });

  it("warns empty-dir for empty directories in copy.from trees", () => {
    const { hankDir } = copyFixture();
    fs.mkdirSync(path.join(hankDir, "tpl/empty-dir"));

    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(true);
    expect(closure.findings.some((f) => f.category === "empty-dir")).toBe(true);
    // excluded from the bundle
    expect(closure.files.some((f) => f.bundlePath.includes("empty-dir"))).toBe(false);
  });

  it("names a deleted prompt file at its field (spec §7 check 4)", () => {
    // The loader refuses the hank (so it cannot pack), but the walk still
    // runs and reports the missing file at the field that authored it.
    const { hankDir } = copyFixture();
    fs.rmSync(path.join(hankDir, "prompts/codon1.md"));

    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(false);
    const finding = closure.findings.find((f) => f.category === "missing-file");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("error");
    expect(finding?.where).toBe("codon-1.promptFile");
    expect(finding?.detail).toBe("prompts/codon1.md does not exist");
    expect(closure.findings.some((f) => f.category === "load-error")).toBe(false);
  });

  it("errors on flattened codon-key collisions", () => {
    const { hankDir } = copyFixture();
    editHankJson(hankDir, (raw) => {
      // Second loop child with the same id → loop-1/codon-2 twice.
      raw.hank[1].codons.push(structuredClone(raw.hank[1].codons[0]));
    });

    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(false);
    // The walker's own duplicate-codon-id check must exist even if the
    // schema or loader starts rejecting duplicate ids first.
    expect(
      closure.findings.some(
        (f) =>
          f.severity === "error" &&
          (f.category === "duplicate-codon-id" ||
            f.category === "schema-error" ||
            f.category === "load-error"),
      ),
    ).toBe(true);
  });

  it("surfaces a sentinel config that fails its schema at its field", () => {
    const { hankDir } = copyFixture();
    fs.writeFileSync(
      path.join(hankDir, "sentinels/check.json"),
      `${JSON.stringify({ id: "check", name: "broken" }, null, 2)}\n`,
    );

    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(false);
    const finding = closure.findings.find((f) => f.severity === "error");
    expect(finding?.category).toBe("schema-error");
    expect(finding?.where).toBe("codon-1.sentinels[0].sentinelConfig");
    expect(finding?.detail).toStartWith("sentinels/check.json: ");
    expect(closure.findings.some((f) => f.category === "load-error")).toBe(false);
  });

  it("errors invalid-json on invalid hank.json with a fixed detail and the engine text as a note", () => {
    const { hankDir } = copyFixture();
    fs.writeFileSync(path.join(hankDir, "hank.json"), "{ not json");

    const closure = computeClosure(hankDir);
    expect(closure.ok).toBe(false);
    const finding = closure.findings.find((f) => f.category === "invalid-json");
    expect(finding?.where).toBe("hank.json");
    // Identical under Bun and Node; the engine's wording is the note.
    expect(finding?.detail).toBe("not valid JSON");
    expect(finding?.note).toBeTruthy();
  });

  it("names what is wrong with the argument itself before reading anything", () => {
    const { hankDir } = copyFixture();
    const readme = path.join(hankDir, "prompts/codon1.md");
    const check = (arg: string) => {
      const closure = computeClosure(arg);
      expect(closure.ok).toBe(false);
      expect(closure.findings).toHaveLength(1);
      return closure.findings[0];
    };
    expect(check(readme)).toEqual({
      severity: "error",
      category: "not-a-hank",
      where: readme,
      detail: "expected hank.json or a directory containing one",
    });
    const missingDir = path.join(hankDir, "does-not-exist");
    expect(check(missingDir)).toMatchObject({
      category: "not-a-hank",
      where: "hank.json",
      detail: `directory ${missingDir} does not exist`,
    });
    expect(check(path.join(hankDir, "prompts"))).toMatchObject({
      category: "not-a-hank",
      detail: `no hank.json in ${path.join(hankDir, "prompts")}`,
    });
    expect(check(path.join(hankDir, "other.json"))).toMatchObject({
      category: "missing-file",
      where: "hank.json",
      detail: `${path.join(hankDir, "other.json")} does not exist`,
    });
  });
});
