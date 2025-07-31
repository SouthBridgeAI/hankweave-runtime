#!/usr/bin/env bun

import { spawn, type ChildProcess } from "node:child_process";

// Poor man's proxy setup script
// Starts proxy server and main server in basic mode and points it to the proxy
// This will be removed in favor of smth more robust

const PROXY_PORT = 5555;
const PROXY_URL = `http://localhost:${PROXY_PORT}`;

interface ProcessManager {
  proxy?: ChildProcess;
  server?: ChildProcess;
}

let processes: ProcessManager = {};

async function killProcessOnPort(port: number): Promise<void> {
  return new Promise((resolve) => {
    const killProcess = spawn("lsof", ["-ti", `:${port}`]);
    let pids = "";

    killProcess.stdout.on("data", (data) => {
      pids += data.toString();
    });

    killProcess.on("close", (code) => {
      if (code === 0 && pids.trim()) {
        const pidList = pids.trim().split("\n");
        console.log(
          `🔪 Killing existing processes on port ${port}: ${pidList.join(", ")}`
        );

        pidList.forEach((pid) => {
          try {
            process.kill(parseInt(pid.trim()), "SIGTERM");
          } catch (error) {
            console.warn(`⚠️  Could not kill process ${pid}: ${error}`);
          }
        });

        setTimeout(resolve, 1000);
      } else {
        resolve();
      }
    });

    killProcess.on("error", () => {
      resolve();
    });
  });
}

async function waitForProxy(): Promise<void> {
  console.log("⏳ Waiting for proxy to be ready...");
  const maxAttempts = 30;
  let attempts = 0;

  while (attempts < maxAttempts) {
    try {
      const response = await fetch(`${PROXY_URL}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(1000),
      });
      if (response.status === 200) {
        console.log("✅ Proxy is ready!");
        return;
      }
    } catch (error) {}

    attempts++;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error("Proxy failed to start within timeout period");
}

function startProxy(): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log("🚀 Starting proxy server...");

    const proxy = spawn("bun", ["server/proxy.ts"], {
      stdio: ["inherit", "pipe", "pipe"],
    });

    processes.proxy = proxy;

    let output = "";
    proxy.stdout?.on("data", (data) => {
      const text = data.toString();
      output += text;
      
      // Log proxy output with prefix
      text.split('\n').forEach((line: string) => {
        if (line.trim()) {
          console.log(`[PROXY] ${line}`);
        }
      });
      
      if (text.includes("Claude API Proxy running")) {
        resolve();
      }
    });

    proxy.stderr?.on("data", (data) => {
      const text = data.toString();
      text.split('\n').forEach((line: string) => {
        if (line.trim()) {
          console.error(`[PROXY ERROR] ${line}`);
        }
      });
    });

    proxy.on("error", (error) => {
      console.error(`❌ Failed to start proxy: ${error.message}`);
      reject(error);
    });

    proxy.on("exit", (code, signal) => {
      if (code !== 0 && code !== null) {
        console.error(`❌ Proxy exited with code ${code} (signal: ${signal})`);
        reject(new Error(`Proxy process failed with code ${code}`));
      }
    });

    setTimeout(() => {
      if (!proxy.killed) {
        resolve();
      }
    }, 3000);
  });
}

function startServer(): void {
  console.log("🎯 Starting server with proxy configuration...");
  console.log(`   Using Anthropic API via: ${PROXY_URL}`);

  const server = spawn(
    "bun",
    ["server/index.ts", "--basic", `--anthropic-base-url=${PROXY_URL}`],
    {
      stdio: ["inherit", "pipe", "pipe"],
    }
  );

  server.stdout?.on("data", (data) => {
    const text = data.toString();
    text.split('\n').forEach((line: string) => {
      if (line.trim()) {
        console.log(`[SERVER] ${line}`);
      }
    });
  });

  server.stderr?.on("data", (data) => {
    const text = data.toString();
    text.split('\n').forEach((line: string) => {
      if (line.trim()) {
        console.error(`[SERVER ERROR] ${line}`);
      }
    });
  });

  processes.server = server;

  server.on("error", (error) => {
    console.error(`❌ Failed to start server: ${error.message}`);
    process.exit(1);
  });

  server.on("exit", (code, signal) => {
    console.log(`\n🛑 Server exited with code ${code} (signal: ${signal})`);
    cleanup();
  });
}

function cleanup(): void {
  console.log("\n🧹 Cleaning up processes...");

  if (processes.proxy && !processes.proxy.killed) {
    console.log("  Terminating proxy...");
    processes.proxy.kill("SIGTERM");
  }

  if (processes.server && !processes.server.killed) {
    console.log("  Terminating server...");
    processes.server.kill("SIGTERM");
  }

  setTimeout(() => {
    process.exit(0);
  }, 1000);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

async function main(): Promise<void> {
  try {
    console.log("🔄 Setting up Tadpole with proxy...\n");

    await killProcessOnPort(PROXY_PORT);

    await startProxy();
    await waitForProxy();

    console.log("");
    startServer();
  } catch (error) {
    console.error(
      `❌ Setup failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    cleanup();
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
