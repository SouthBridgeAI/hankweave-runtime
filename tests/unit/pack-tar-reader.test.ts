import { describe, expect, it } from "bun:test";
import { DEFAULT_QUOTAS } from "../../server/pack/closure.js";
import {
  readCanonicalTar,
  TarFormatError,
  type TarMember,
  writeCanonicalTar,
} from "../../server/pack/tar.js";

const member = (name = "a", bytes = Buffer.from("hello")): TarMember => ({
  path: name,
  bytes,
  mode: "644",
});
function refusal(bytes: Buffer, reason: string): void {
  expect(() => readCanonicalTar(bytes)).toThrow(TarFormatError);
  expect(() => readCanonicalTar(bytes)).toThrow(reason);
  expect(() => readCanonicalTar(bytes)).toThrow(/offset \d+, member \d+/);
}
function checksum(bytes: Buffer, offset = 0): void {
  bytes.fill(32, offset + 148, offset + 156);
  const sum = bytes.subarray(offset, offset + 512).reduce((a, b) => a + b, 0);
  bytes.write(`${sum.toString(8).padStart(6, "0")}\0 `, offset + 148, "ascii");
}
function mutation(offset: number, value: string, reason: string): void {
  const bytes = writeCanonicalTar([member()]);
  bytes.write(value, offset, "ascii");
  refusal(bytes, reason);
}

describe("canonical tar reader", () => {
  it("round-trips paths, boundary sizes, UTF-8 cuts and executable modes without copying", () => {
    const members = [
      member(),
      member("x".repeat(101)),
      member("a".repeat(99) + "界".repeat(67)),
      member("empty", Buffer.alloc(0)),
      { ...member("bin", Buffer.alloc(512)), mode: "755" as const },
    ];
    const bytes = writeCanonicalTar(members);
    const parsed = readCanonicalTar(bytes);
    expect(parsed).toEqual(members);
    expect(parsed[0].bytes.buffer).toBe(bytes.buffer);
    expect(readCanonicalTar(writeCanonicalTar([]))).toEqual([]);
  });
  it.each([
    [148, "1", "header"],
    [136, "1", "header"],
    [345, "x", "header"],
    [124, " ", "size field"],
    [100, "0000777", "mode"],
  ] as const)("rejects header mutation at %d", (offset, value, reason) =>
    mutation(offset, value, reason),
  );
  it.each([
    ["5", "directory"],
    ["2", "symlink"],
    ["1", "hard link"],
    ["L", "GNU long name"],
    ["K", "GNU long link"],
    ["g", "global PAX"],
    ["\0", "old-style"],
  ])("rejects %s records by name", (flag, name) => mutation(156, flag, name));
  it("rejects sizes beyond remaining input before slicing", () => {
    const bytes = writeCanonicalTar([member()]);
    bytes.write("00001000000\0", 124, "ascii");
    checksum(bytes);
    refusal(bytes, "remaining bytes");
  });
  it("requires exactly two final zero blocks and zero member padding", () => {
    const bytes = writeCanonicalTar([member()]);
    refusal(bytes.subarray(0, -1), "block-aligned");
    refusal(bytes.subarray(0, -512), "missing terminator");
    refusal(bytes.subarray(0, -1024), "missing terminator");
    refusal(Buffer.concat([bytes, Buffer.alloc(512)]), "trailing data");
    bytes[520] = 1;
    refusal(bytes, "nonzero padding");
  });
  it.each(["mtime=", "two records", "wrong length", "short path"])("rejects PAX %s", (variant) => {
    const bytes = writeCanonicalTar([member("x".repeat(101))]);
    if (variant === "mtime=") bytes.write("mtime=", 516);
    if (variant === "two records") bytes[550] = 10;
    if (variant === "wrong length") bytes[512] = 57;
    if (variant === "short path") {
      const data = Buffer.from("12 path=abc\n");
      bytes.fill(0, 512, 1024);
      data.copy(bytes, 512);
      bytes.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
      checksum(bytes);
    }
    refusal(bytes, "PAX");
  });
  it("rejects misplaced PAX and mismatched fallback names", () => {
    const bytes = writeCanonicalTar([member("x".repeat(101))]);
    const wrongIndex = Buffer.from(bytes);
    wrongIndex[11] = 49;
    checksum(wrongIndex);
    refusal(wrongIndex, "PAX header name");
    refusal(Buffer.concat([bytes.subarray(0, 1024), bytes]), "consecutive PAX");
    refusal(Buffer.concat([bytes.subarray(0, 1024), Buffer.alloc(1024)]), "PAX as last record");
    bytes[1024] = 121;
    checksum(bytes, 1024);
    refusal(bytes, "member name");
  });
  it("rejects duplicate and empty paths", () => {
    refusal(writeCanonicalTar([member(), member()]), "duplicate path a");
    const bytes = writeCanonicalTar([member()]);
    bytes[0] = 0;
    checksum(bytes);
    refusal(bytes, "empty");
  });
  it.each(["maxMemberBytes", "maxTotalBytes", "maxMembers"] as const)("enforces %s", (quota) => {
    const bytes = writeCanonicalTar([member()]);
    expect(() => readCanonicalTar(bytes, { ...DEFAULT_QUOTAS, [quota]: 0 })).toThrow(quota);
  });
});
