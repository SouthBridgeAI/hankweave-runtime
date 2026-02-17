/**
 * Cross-runtime integration test for dynamic port allocation (ENG-179).
 *
 * Validates that serve({ port: 0 }) correctly assigns and reports an
 * OS-assigned port. This test is a standalone script (no bun:test) so
 * it can run under Bun, Node.js (via tsx), and Deno.
 *
 * Usage:
 *   bun tests/cross-runtime/dynamic-port.test.ts
 *   npx tsx tests/cross-runtime/dynamic-port.test.ts
 *   deno run --allow-net --allow-read --allow-env --node-modules-dir tests/cross-runtime/dynamic-port.test.ts
 *
 * Known issues:
 *   The port getter in server/utils.ts only works under Bun. Node.js and
 *   Deno paths are broken (port getter returns 0 instead of the actual
 *   assigned port). See server/utils.ts lines 1227-1259 for details.
 */

import assert from "node:assert/strict";
import { serve, WebSocket } from "../../server/utils.js";

// ─── Helpers ───────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function detectRuntime(): string {
  // @ts-ignore -- Bun global not in all type definitions
  if (typeof Bun !== "undefined") return "bun";
  // @ts-ignore -- Deno global not in all type definitions
  if (typeof Deno !== "undefined") return "deno";
  return "node";
}

let passed = 0;
let failed = 0;

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`        ${error instanceof Error ? error.message : error}`);
  }
}

// ─── Test 1: serve({ port: 0 }) assigns a real port ───────────────────

async function testDynamicPortAssignment() {
  const server = serve({
    port: 0,
    fetch: async () => new Response("OK"),
  });

  await sleep(200);

  try {
    const port = server.port;
    assert.ok(port > 0, `Expected port > 0, got ${port}`);
    assert.ok(port < 65536, `Expected port < 65536, got ${port}`);
  } finally {
    server.stop();
    await sleep(100);
  }
}

// ─── Test 2: HTTP connectivity on discovered port ─────────────────────

async function testHttpConnectivity() {
  const server = serve({
    port: 0,
    fetch: async (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return new Response("healthy", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });

  await sleep(200);

  try {
    const port = server.port;
    assert.ok(port > 0, `Port must be > 0, got ${port}`);

    const response = await fetch(`http://localhost:${port}/health`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.equal(body, "healthy");
  } finally {
    server.stop();
    await sleep(100);
  }
}

// ─── Test 3: WebSocket connectivity on discovered port ────────────────

async function testWebSocketConnectivity() {
  const server = serve({
    port: 0,
    websocket: {
      message: (ws, message) => {
        // Under Node, crossws may deliver messages as Buffers
        const text = typeof message === "string" ? message : message.toString();
        ws.send(`echo:${text}`);
      },
    },
  });

  await sleep(200);

  try {
    const port = server.port;
    assert.ok(port > 0, `Port must be > 0, got ${port}`);

    const ws = new WebSocket(`ws://localhost:${port}`);

    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e: Event) => reject(new Error(`WebSocket error: ${e}`));
      setTimeout(() => reject(new Error("WebSocket connect timeout")), 5000);
    });

    // Send message and verify echo
    const echoPromise = new Promise<string>((resolve, reject) => {
      ws.onmessage = (event: MessageEvent) =>
        resolve(typeof event.data === "string" ? event.data : "");
      setTimeout(() => reject(new Error("Echo timeout")), 5000);
    });

    ws.send("hello");
    const echo = await echoPromise;
    assert.equal(echo, "echo:hello");

    ws.close();
    await sleep(100);
  } finally {
    server.stop();
    await sleep(100);
  }
}

// ─── Test 4: Two servers with port: 0 get different ports ─────────────

async function testParallelDynamicPorts() {
  const server1 = serve({
    port: 0,
    fetch: async () => new Response("server1"),
  });

  const server2 = serve({
    port: 0,
    fetch: async () => new Response("server2"),
  });

  await sleep(200);

  try {
    const port1 = server1.port;
    const port2 = server2.port;

    assert.ok(port1 > 0, `Server 1 port must be > 0, got ${port1}`);
    assert.ok(port2 > 0, `Server 2 port must be > 0, got ${port2}`);
    assert.notEqual(port1, port2, `Ports must differ: both are ${port1}`);

    // Verify both respond independently
    const res1 = await fetch(`http://localhost:${port1}/`);
    assert.equal(await res1.text(), "server1");

    const res2 = await fetch(`http://localhost:${port2}/`);
    assert.equal(await res2.text(), "server2");
  } finally {
    server1.stop();
    server2.stop();
    await sleep(100);
  }
}

// ─── Runner ────────────────────────────────────────────────────────────

async function main() {
  const runtime = detectRuntime();
  console.log(`\nDynamic Port Allocation Tests (runtime: ${runtime})\n`);

  await runTest("serve({ port: 0 }) assigns a port > 0", testDynamicPortAssignment);
  await runTest("HTTP connectivity on dynamic port", testHttpConnectivity);
  await runTest("WebSocket connectivity on dynamic port", testWebSocketConnectivity);
  await runTest("Two port:0 servers get different ports", testParallelDynamicPorts);

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main();
