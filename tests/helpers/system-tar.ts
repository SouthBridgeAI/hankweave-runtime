/**
 * systemTar — the executable the pack interop tests shell out to when they
 * prove that an external tar reads our canonical PAX archives byte-exactly.
 *
 * On the Windows CI runner the job runs under Git Bash, whose /usr/bin puts
 * MSYS GNU tar ahead of C:\Windows\System32\tar.exe. GNU tar reads the
 * drive-letter colon in `C:\...` as a remote host and fails with
 * `tar: Cannot connect to C: resolve failed`, so on win32 we name Windows'
 * own bsdtar explicitly. Everywhere else bare `tar` is bsdtar (macOS) or
 * GNU tar (Linux), and both read the archives unchanged.
 */

import path from "node:path";

export function systemTar(): string {
  if (process.platform !== "win32") return "tar";
  return path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
}
