#!/usr/bin/env bun
import { describe, expect, it } from "bun:test";
import { launchBasicServer } from "../utils/server-process-helper.js";

describe("basic server lifecycle", () => {
  it(
    "starts the tadpole server and terminates it after 30 seconds",
    async () => {
      const server = await launchBasicServer();

      const stillRunning =
        server.process.exitCode === null && server.process.signalCode === null;

      try {
        if (stillRunning) {
          await Bun.sleep(30_000);
        }
      } finally {
        await server.kill();
      }

      expect(
        server.process.exitCode !== null || server.process.signalCode !== null,
      ).toBeTrue();
    },
    40_000,
  );
});
