/**
 * Canonical deterministic PAX tar writer for `hankweave pack` (phase-2
 * issues 01 + 08). Hand-rolled on purpose: `node-tar`'s output shifts
 * between versions, and archive bytes feed the determinism contract.
 *
 * FROZEN OUTPUT: raw tar bytes are pinned by golden tests. Any change to
 * the byte profile below is a deliberate, reviewed determinism decision,
 * never a refactor side effect.
 *
 * ## Physical archive grammar (the profile phase 3's reader enforces)
 *
 * - Logical members only, in caller order (pack passes `hank.lock` first,
 *   then closure files sorted bytewise). One regular-file record each.
 * - NO directory records: extractors create parents from member paths.
 *   Every physical record is therefore either a member's file record or
 *   that member's single PAX header — nothing "unlisted" can exist.
 * - Long paths: a path of MORE than 100 UTF-8 bytes gets one PAX extended
 *   header (typeflag `x`) immediately before its file record, holding a
 *   single `path` record. The ustar `prefix` field is never used — one
 *   trigger rule, not three.
 * - The PAX header's own name is `PaxHeaders/<i>` where `<i>` is the
 *   member's 0-based decimal index in the archive — deterministic, and
 *   never derived from PIDs, temp names, or clocks.
 * - Terminator: exactly two 512-byte zero blocks, no blocking-factor
 *   padding beyond them.
 *
 * ## Header byte profile
 *
 * ustar magic `ustar\0` version `00`; mtime=0, uid=gid=0, uname=gname
 * empty; devmajor/devminor octal zero; mode `0000644` or `0000755` (dirs
 * don't exist; the PAX header record itself uses 644). 8-byte numeric
 * fields are 7 zero-padded octal digits + NUL; 12-byte fields are 11
 * digits + NUL; checksum is 6 digits + NUL + space (the POSIX spelling).
 * All path/length accounting is UTF-8 BYTES, never JS string length.
 */

import { Buffer } from "node:buffer";
import { type ClosureQuotas, DEFAULT_QUOTAS, RESERVED_LOCK_PATH } from "./closure.js";

export interface TarMember {
  /** Relative POSIX path inside the archive. */
  path: string;
  bytes: Buffer;
  mode: "644" | "755";
}

const BLOCK = 512;
/** ustar `name` field capacity in bytes; longer paths go through PAX. */
const NAME_FIELD_MAX = 100;
/** 11 octal digits: the size field's ceiling (8 GiB - 1). Closure quotas
 * keep members far below this; the guard turns a violation into a named
 * internal error instead of silent field corruption. */
const MAX_MEMBER_SIZE = 8 ** 11 - 1;

function octal(value: number, fieldWidth: 8 | 12): Buffer {
  const digits = value.toString(8).padStart(fieldWidth - 1, "0");
  if (digits.length > fieldWidth - 1) {
    throw new Error(`pack internal error: octal field overflow (${value})`);
  }
  return Buffer.from(`${digits}\0`, "ascii");
}

function header(options: {
  nameBytes: Buffer;
  size: number;
  typeflag: "0" | "x";
  mode: "644" | "755";
}): Buffer {
  const { nameBytes, size, typeflag, mode } = options;
  if (nameBytes.length > NAME_FIELD_MAX) {
    throw new Error("pack internal error: header name exceeds the ustar field");
  }
  const block = Buffer.alloc(BLOCK);
  nameBytes.copy(block, 0);
  octal(mode === "755" ? 0o755 : 0o644, 8).copy(block, 100);
  octal(0, 8).copy(block, 108); // uid
  octal(0, 8).copy(block, 116); // gid
  octal(size, 12).copy(block, 124);
  octal(0, 12).copy(block, 136); // mtime
  block.fill(0x20, 148, 156); // checksum computed over spaces
  block.write(typeflag, 156, "ascii");
  block.write("ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  octal(0, 8).copy(block, 329); // devmajor
  octal(0, 8).copy(block, 337); // devminor

  let sum = 0;
  for (const byte of block) sum += byte;
  const checksum = sum.toString(8).padStart(6, "0");
  block.write(`${checksum}\0 `, 148, "ascii");
  return block;
}

function padToBlock(bytes: Buffer): Buffer {
  const remainder = bytes.length % BLOCK;
  if (remainder === 0) return bytes;
  return Buffer.concat([bytes, Buffer.alloc(BLOCK - remainder)]);
}

/** One PAX `path` record with the self-inclusive decimal length:
 * `<len> path=<value>\n` where <len> counts its own digits. */
export function paxPathRecord(path: string): Buffer {
  const rest = ` path=${path}\n`;
  const restLen = Buffer.byteLength(rest, "utf8");
  // Smallest total where digits(total) + restLen === total. Bumping the
  // digit count can itself grow the total across a power of ten (the
  // classic 99/100 rollover), so iterate until stable.
  let total = restLen + 1;
  while (String(total).length + restLen !== total) {
    total = String(total).length + restLen;
  }
  return Buffer.from(`${total}${rest}`, "utf8");
}

/** Largest prefix of `path` that fits the ustar name field without
 * splitting a UTF-8 code point. Only cosmetic: readers take the PAX
 * `path` record as authoritative. */
function truncatedNameBytes(path: string): Buffer {
  const full = Buffer.from(path, "utf8");
  if (full.length <= NAME_FIELD_MAX) return full;
  let end = NAME_FIELD_MAX;
  // Back off continuation bytes (0b10xxxxxx) so the cut lands on a
  // code-point boundary.
  while (end > 0 && ((full[end] as number) & 0b1100_0000) === 0b1000_0000) end--;
  return full.subarray(0, end);
}

/**
 * Serialize members into one deterministic uncompressed tar. Callers pass
 * members in final archive order; this function adds no reordering. Paths
 * were validated by the closure walk — the checks here are internal-error
 * guards, not user-facing lint.
 */
export function writeCanonicalTar(members: readonly TarMember[]): Buffer {
  const parts: Buffer[] = [];
  members.forEach((member, index) => {
    const { path, bytes, mode } = member;
    if (path === "" || path.includes("\0")) {
      throw new Error(`pack internal error: invalid tar member path ${JSON.stringify(path)}`);
    }
    if (bytes.length > MAX_MEMBER_SIZE) {
      throw new Error(`pack internal error: member ${path} exceeds the tar size field`);
    }
    const nameBytes = Buffer.from(path, "utf8");
    if (nameBytes.length > NAME_FIELD_MAX) {
      const pax = paxPathRecord(path);
      parts.push(
        header({
          nameBytes: Buffer.from(`PaxHeaders/${index}`, "ascii"),
          size: pax.length,
          typeflag: "x",
          mode: "644",
        }),
        padToBlock(pax),
      );
    }
    parts.push(
      header({
        nameBytes: truncatedNameBytes(path),
        size: bytes.length,
        typeflag: "0",
        mode,
      }),
      padToBlock(bytes),
    );
  });
  parts.push(Buffer.alloc(2 * BLOCK));
  return Buffer.concat(parts);
}

export class TarFormatError extends Error {
  constructor(offset: number, member: number, reason: string) {
    super(`tar offset ${offset}, member ${member}: ${reason}`);
    this.name = "TarFormatError";
  }
}

const REFUSED_TYPES: Record<string, string> = {
  "5": "directory",
  "1": "hard link",
  "2": "symlink",
  L: "GNU long name",
  K: "GNU long link",
  g: "global PAX",
  "\0": "old-style regular file",
};

function readTypeflag(block: Buffer, fail: (reason: string) => never): "0" | "x" {
  const typeflag = block.toString("utf8", 156, 157);
  if (typeflag !== "0" && typeflag !== "x") {
    fail(`refused typeflag ${JSON.stringify(typeflag)} (${REFUSED_TYPES[typeflag] ?? "unknown"})`);
  }
  return typeflag;
}

function readHeader(block: Buffer, fail: (reason: string) => never) {
  const typeflag = readTypeflag(block, fail);
  const sizeField = block.toString("utf8", 124, 136);
  if (!/^[0-7]{11}\0$/.test(sizeField)) fail("invalid size field");
  const size = Number.parseInt(sizeField, 8);
  const modeValue = Number.parseInt(block.toString("utf8", 100, 108), 8);
  if (modeValue !== 0o644 && modeValue !== 0o755) fail("invalid mode");
  const mode: TarMember["mode"] = modeValue === 0o755 ? "755" : "644";
  const field = block.subarray(0, NAME_FIELD_MAX);
  const nul = field.indexOf(0);
  const nameBytes = field.subarray(0, nul < 0 ? field.length : nul);
  const expected = header({ nameBytes, size, typeflag, mode });
  if (!expected.equals(block)) fail("noncanonical header (checksum or header fields)");
  return { typeflag, size, mode, nameBytes };
}

function readPax(data: Buffer, fail: (reason: string) => never): string {
  const match = /^([1-9][0-9]*) path=([^\n\0]+)\n$/.exec(data.toString("utf8"));
  if (!match || Number(match[1]) !== data.length) fail("invalid PAX path record or length");
  const value = match[2];
  if (Buffer.byteLength(value) <= NAME_FIELD_MAX || !paxPathRecord(value).equals(data)) {
    fail("noncanonical PAX path record");
  }
  return value;
}

type FailTar = (reason: string) => never;

function checkTerminator(
  bytes: Buffer,
  offset: number,
  pending: string | undefined,
  fail: FailTar,
): void {
  if (pending !== undefined) fail("PAX as last record");
  if (bytes.length < offset + 2 * BLOCK) fail("missing terminator");
  if (!bytes.subarray(offset + BLOCK, offset + 2 * BLOCK).every((byte) => byte === 0))
    fail("missing terminator");
  if (bytes.length !== offset + 2 * BLOCK) fail("trailing data after terminator");
}

function readRecord(bytes: Buffer, offset: number, maxMemberBytes: number, fail: FailTar) {
  const record = readHeader(bytes.subarray(offset, offset + BLOCK), fail);
  if (record.size > maxMemberBytes) fail("maxMemberBytes quota exceeded");
  const end = offset + BLOCK + record.size;
  const next = offset + BLOCK + Math.ceil(record.size / BLOCK) * BLOCK;
  if (next > bytes.length) fail("member size exceeds remaining bytes");
  if (!bytes.subarray(end, next).every((byte) => byte === 0)) fail("nonzero padding");
  return { ...record, data: bytes.subarray(offset + BLOCK, end), next };
}

/** Charges one file record against the closure quotas. The count and
 * total-byte quotas were charged against the closure pack captured; the
 * leading hank.lock is metadata pack adds on top, so a closure exactly at
 * quota must still read back. The lock stays bounded by maxMemberBytes
 * (readRecord) and the archive-size cap. */
function chargeQuotas(
  charged: { members: number; bytes: number },
  size: number,
  quotas: ClosureQuotas,
  fail: FailTar,
): void {
  if (charged.members >= quotas.maxMembers) fail("maxMembers quota exceeded");
  if (size > quotas.maxTotalBytes - charged.bytes) fail("maxTotalBytes quota exceeded");
  charged.members += 1;
  charged.bytes += size;
}

function memberName(
  nameBytes: Buffer,
  pending: string | undefined,
  names: Set<string>,
  fail: FailTar,
): string {
  const memberPath = pending ?? nameBytes.toString("utf8");
  if (!memberPath || memberPath.includes("\0")) fail("empty or NUL member path");
  if (!truncatedNameBytes(memberPath).equals(nameBytes)) fail("noncanonical member name");
  if (names.has(memberPath)) fail(`duplicate path ${memberPath}`);
  names.add(memberPath);
  return memberPath;
}

function paxName(
  record: ReturnType<typeof readRecord>,
  pending: string | undefined,
  index: number,
  fail: FailTar,
): string {
  if (pending !== undefined) fail("consecutive PAX records");
  if (record.mode !== "644" || !record.nameBytes.equals(Buffer.from(`PaxHeaders/${index}`)))
    fail("invalid PAX header name or mode");
  return readPax(record.data, fail);
}

/** Strict inverse of the frozen writer. Member bytes are views into the input. */
export function readCanonicalTar(
  bytes: Buffer,
  quotas: ClosureQuotas = DEFAULT_QUOTAS,
): TarMember[] {
  const members: TarMember[] = [];
  const names = new Set<string>();
  let offset = 0;
  const charged = { members: 0, bytes: 0 };
  let pending: string | undefined;
  const fail: FailTar = (reason) => {
    throw new TarFormatError(offset, members.length, reason);
  };
  if (bytes.length % BLOCK !== 0) fail("length is not block-aligned");
  while (offset < bytes.length) {
    if (bytes.subarray(offset, offset + BLOCK).every((byte) => byte === 0)) {
      checkTerminator(bytes, offset, pending, fail);
      return members;
    }
    const record = readRecord(bytes, offset, quotas.maxMemberBytes, fail);
    if (record.typeflag === "x") {
      pending = paxName(record, pending, members.length, fail);
    } else {
      const memberPath = memberName(record.nameBytes, pending, names, fail);
      const isLeadingLock = members.length === 0 && memberPath === RESERVED_LOCK_PATH;
      if (!isLeadingLock) chargeQuotas(charged, record.size, quotas, fail);
      members.push({ path: memberPath, bytes: record.data, mode: record.mode });
      pending = undefined;
    }
    offset = record.next;
  }
  return fail(pending !== undefined ? "PAX as last record" : "missing terminator");
}
