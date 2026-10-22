import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExecutionLayout } from "../../server/execution-layout.js";
import { resolveAttachPort } from "../../server/execution-setup.js";

let dir: string;
let layout: ExecutionLayout;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "attach-mode-"));
  layout = new ExecutionLayout(dir);
  fs.mkdirSync(layout.stateDir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test("attach reads ports from execution metadata", async () => {
  fs.writeFileSync(layout.metaPath, JSON.stringify({ runtime: { port: 9999, proxyPort: 9998 } }));
  expect(await resolveAttachPort({ executionPath: dir })).toBe(9999);
});

test("explicit port bypasses discovery and no execution defaults to 7777", async () => {
  expect(await resolveAttachPort({ executionPath: dir, port: 8080 })).toBe(8080);
  expect(await resolveAttachPort({})).toBe(7777);
});

test("missing execution metadata requires an explicit port", async () => {
  await expect(resolveAttachPort({ executionPath: dir })).rejects.toThrow(/Use --port/);
});

test.each([
  "garbage",
  "null",
  "{}",
  '{"runtime":{"port":0}}',
  '{"runtime":{"port":65536}}',
  '{"runtime":{"port":"9999"}}',
])("invalid discovery gives explicit port guidance: %s", async (contents) => {
  fs.writeFileSync(layout.metaPath, contents);
  await expect(resolveAttachPort({ executionPath: dir })).rejects.toThrow(/Use --port/);
});
