import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { paxPathRecord, type TarMember, writeCanonicalTar } from "../../server/pack/tar.js";
import { systemTar } from "../helpers/system-tar.js";

const BLOCK = 512;

function member(p: string, content: string, mode: "644" | "755" = "644"): TarMember {
  return { path: p, bytes: Buffer.from(content, "utf8"), mode };
}

/** Minimal raw-header reader for assertions — deliberately independent of
 * the writer's own logic (a matching defect in writer+reader would hide). */
function readHeaders(
  tar: Buffer,
): Array<{ name: string; size: number; typeflag: string; mode: string; body: Buffer }> {
  const out: Array<{ name: string; size: number; typeflag: string; mode: string; body: Buffer }> =
    [];
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK);
    if (block.every((b) => b === 0)) break;
    const name = block.subarray(0, 100).toString("utf8").replace(/\0+$/, "");
    const mode = block.subarray(100, 108).toString("ascii").replace(/\0+$/, "");
    const size = Number.parseInt(block.subarray(124, 136).toString("ascii"), 8);
    const typeflag = String.fromCharCode(block[156] as number);
    // Verify the checksum like a reader would: sum with the field spaced.
    const copy = Buffer.from(block);
    copy.fill(0x20, 148, 156);
    let sum = 0;
    for (const b of copy) sum += b;
    const stored = Number.parseInt(block.subarray(148, 156).toString("ascii"), 8);
    expect(stored).toBe(sum);
    expect(block.subarray(257, 263).toString("ascii")).toBe("ustar\0");
    expect(block.subarray(263, 265).toString("ascii")).toBe("00");
    const bodyBlocks = Math.ceil(size / BLOCK);
    const body = tar.subarray(offset + BLOCK, offset + BLOCK + size);
    out.push({ name, size, typeflag, mode, body: Buffer.from(body) });
    offset += BLOCK * (1 + bodyBlocks);
  }
  return out;
}

describe("canonical PAX writer (phase-2 issues 01/08)", () => {
  it("emits only file records — no directory records, ustar magic, zeroed metadata", () => {
    const tar = writeCanonicalTar([
      member("hank.lock", "{}\n"),
      member("prompts/deep/nested/a.md", "hello\n"),
    ]);
    const headers = readHeaders(tar);
    expect(headers.map((h) => [h.name, h.typeflag])).toEqual([
      ["hank.lock", "0"],
      ["prompts/deep/nested/a.md", "0"],
    ]);
    // mtime and uid/gid are zero in every header
    for (const h of headers) {
      expect(h.mode === "0000644" || h.mode === "0000755").toBe(true);
    }
  });

  it("terminates with exactly two zero blocks and block-pads content", () => {
    const tar = writeCanonicalTar([member("a.txt", "x")]);
    // header + 1 content block + 2 terminator blocks
    expect(tar.length).toBe(BLOCK * 4);
    expect(tar.subarray(BLOCK * 2).every((b) => b === 0)).toBe(true);
  });

  it.each([0, 511, 512, 513])("round-trips a %d-byte member through raw headers", (size) => {
    const content = crypto.randomBytes(size).toString("base64").slice(0, size);
    const tar = writeCanonicalTar([member("f.bin", content)]);
    const [h] = readHeaders(tar);
    expect(h?.size).toBe(size);
    expect(h?.body.toString("utf8")).toBe(content);
  });

  it("records the executable mode", () => {
    const tar = writeCanonicalTar([member("bin/run.sh", "#!/bin/sh\n", "755")]);
    expect(readHeaders(tar)[0]?.mode).toBe("0000755");
  });

  it("uses the plain name field at exactly 100 bytes and PAX above it", () => {
    const path99 = `${"a".repeat(94)}/x.md`; // 99 bytes
    const path100 = `${"a".repeat(95)}/x.md`; // 100 bytes
    const path101 = `${"a".repeat(96)}/x.md`; // 101 bytes
    for (const p of [path99, path100]) {
      const headers = readHeaders(writeCanonicalTar([member(p, "y")]));
      expect(headers.map((h) => h.typeflag)).toEqual(["0"]);
      expect(headers[0]?.name).toBe(p);
    }
    const headers = readHeaders(writeCanonicalTar([member(path101, "y")]));
    expect(headers.map((h) => h.typeflag)).toEqual(["x", "0"]);
    expect(headers[0]?.name).toBe("PaxHeaders/0");
    // rest = " path=" (6) + 101 + "\n" (1) = 108 bytes; +3 length digits = 111.
    expect(headers[0]?.body.toString("utf8")).toBe(`111 path=${path101}\n`);
  });

  it("PAX header names use the member's archive index — deterministic, no PIDs or clocks", () => {
    const long1 = `${"d".repeat(120)}/one.md`;
    const long2 = `${"d".repeat(120)}/two.md`;
    const headers = readHeaders(
      writeCanonicalTar([member("short.md", "s"), member(long1, "1"), member(long2, "2")]),
    );
    expect(headers.map((h) => h.name)).toEqual([
      "short.md",
      "PaxHeaders/1",
      long1.slice(0, 100),
      "PaxHeaders/2",
      long2.slice(0, 100),
    ]);
  });

  it("counts PAX lengths in UTF-8 bytes, not characters", () => {
    const multibyte = `${"é".repeat(60)}/x.md`; // 60 chars = 120 bytes + 5
    const record = paxPathRecord(multibyte);
    const total = Number.parseInt(record.toString("utf8").split(" ")[0] as string, 10);
    expect(record.length).toBe(total);
    const headers = readHeaders(writeCanonicalTar([member(multibyte, "y")]));
    expect(headers[0]?.typeflag).toBe("x");
    // The truncated ustar name must not split a UTF-8 code point.
    expect(headers[1]?.name.includes("�")).toBe(false);
  });

  it("self-inclusive PAX length survives the decimal digit rollover", () => {
    // rest = " path=" + value + "\n"; a 91-byte value gives restLen 98,
    // where adding the length digits crosses 2 → 3 digits (99 → 101).
    const value = "v".repeat(91);
    const record = paxPathRecord(value);
    expect(record.toString("utf8")).toBe(`101 path=${value}\n`);
    expect(record.length).toBe(101);
  });

  it("identical input produces identical bytes; input order is preserved", () => {
    const members = [member("hank.lock", "{}\n"), member("b.md", "b"), member("a.md", "a")];
    const one = writeCanonicalTar(members);
    const two = writeCanonicalTar(members);
    expect(one.equals(two)).toBe(true);
    expect(readHeaders(one).map((h) => h.name)).toEqual(["hank.lock", "b.md", "a.md"]);
  });

  it("system tar lists and extracts long and multibyte paths byte-exactly", () => {
    const long = `nested/${"p".repeat(120)}/prompt.md`;
    const multibyte = "prompts/héllo-wörld.md";
    const tar = writeCanonicalTar([
      member("hank.lock", '{"v":1}\n'),
      member(long, "long content\n"),
      member(multibyte, "unicode content\n", "755"),
    ]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pack-tar-"));
    try {
      const tarPath = path.join(dir, "t.tar");
      fs.writeFileSync(tarPath, tar);
      // Windows tar ends listing lines with CRLF.
      const listing = execFileSync(systemTar(), ["-tf", tarPath], { encoding: "utf8" })
        .trim()
        .split(/\r?\n/);
      if (process.platform === "win32") {
        // Windows tar re-encodes member names to the console code page when it
        // prints them, so the multibyte name is not comparable as text there.
        // Prove it by position and by extracting its content instead.
        expect(listing.slice(0, 2)).toEqual(["hank.lock", long]);
        expect(listing).toHaveLength(3);
      } else {
        expect(listing).toEqual(["hank.lock", long, multibyte]);
      }
      const extracted = execFileSync(systemTar(), ["-xOf", tarPath, long]);
      expect(extracted.toString("utf8")).toBe("long content\n");
      // Select the multibyte member by a glob on win32 so the name never has to
      // survive an argv code-page round trip; bsdtar member args are patterns.
      const unicodeSelector = process.platform === "win32" ? "prompts/h*llo-w*rld.md" : multibyte;
      const unicode = execFileSync(systemTar(), ["-xOf", tarPath, unicodeSelector]);
      expect(unicode.toString("utf8")).toBe("unicode content\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses empty and NUL-bearing member paths as internal errors", () => {
    expect(() => writeCanonicalTar([member("", "x")])).toThrow(/invalid tar member path/);
    expect(() => writeCanonicalTar([member("a\0b", "x")])).toThrow(/invalid tar member path/);
  });
});
