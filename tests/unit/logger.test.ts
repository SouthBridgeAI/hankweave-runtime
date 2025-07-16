import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Logger, generateId, isError, toError } from "../../server/utils";
import * as fs from "fs";
import * as path from "path";
import { rmSync } from "fs";

describe("Logger", () => {
  let tempDir: string;
  let logPath: string;
  let logger: Logger;

  beforeEach(async () => {
    tempDir = path.resolve(
      "tests",
      "test-area",
      `temp-test-logger-${Date.now()}`
    );
    await fs.promises.mkdir(tempDir, { recursive: true });
    logPath = path.join(tempDir, "test.log");
    logger = new Logger(logPath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("logs info messages", () => {
    logger.log("Test info message");

    const logContent = fs.readFileSync(logPath, "utf-8");
    expect(logContent).toContain("[INFO]");
    expect(logContent).toContain("Test info message");
  });

  test("logs error messages", () => {
    logger.log("Test error message", "error");

    const logContent = fs.readFileSync(logPath, "utf-8");
    expect(logContent).toContain("[ERROR]");
    expect(logContent).toContain("Test error message");
  });

  test("logs debug messages", () => {
    logger.log("Test debug message", "debug");

    const logContent = fs.readFileSync(logPath, "utf-8");
    expect(logContent).toContain("[DEBUG]");
    expect(logContent).toContain("Test debug message");
  });

  test("includes timestamp in logs", () => {
    logger.log("Test message");

    const logContent = fs.readFileSync(logPath, "utf-8");
    // Check for ISO timestamp pattern
    expect(logContent).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });

  test("logSocketTraffic logs to separate file", () => {
    const socketLogPath = path.join(tempDir, "socket.log");
    const data = { type: "test", payload: "data" };

    logger.logSocketTraffic(socketLogPath, "in", data);

    const socketLogContent = fs.readFileSync(socketLogPath, "utf-8");
    expect(socketLogContent).toContain("[IN]");
    expect(socketLogContent).toContain(JSON.stringify(data));
  });

  test("logSocketTraffic handles out direction", () => {
    const socketLogPath = path.join(tempDir, "socket.log");
    const data = { type: "response", payload: "data" };

    logger.logSocketTraffic(socketLogPath, "out", data);

    const socketLogContent = fs.readFileSync(socketLogPath, "utf-8");
    expect(socketLogContent).toContain("[OUT]");
    expect(socketLogContent).toContain(JSON.stringify(data));
  });

  test("appends to existing log files", () => {
    logger.log("First message");
    logger.log("Second message");

    const logContent = fs.readFileSync(logPath, "utf-8");
    expect(logContent).toContain("First message");
    expect(logContent).toContain("Second message");
  });
});

describe("generateId", () => {
  test("generates unique IDs", () => {
    const id1 = generateId();
    const id2 = generateId();

    expect(id1).not.toBe(id2);
  });

  test("generates IDs in correct format", () => {
    const id = generateId();

    // Should be alphanumeric with hyphens
    expect(id).toMatch(/^[a-zA-Z0-9-]+$/);
    expect(id.length).toBeGreaterThan(0);
  });

  test("generates reasonably short IDs", () => {
    const id = generateId();

    // IDs should be manageable length
    expect(id.length).toBeLessThan(50);
  });
});

describe("isError", () => {
  test("returns true for Error instances", () => {
    expect(isError(new Error("test"))).toBe(true);
    expect(isError(new TypeError("test"))).toBe(true);
    expect(isError(new RangeError("test"))).toBe(true);
  });

  test("returns false for non-Error values", () => {
    expect(isError("error string")).toBe(false);
    expect(isError(123)).toBe(false);
    expect(isError(null)).toBe(false);
    expect(isError(undefined)).toBe(false);
    expect(isError({})).toBe(false);
    expect(isError({ message: "fake error" })).toBe(false);
  });

  test("returns true for custom Error classes", () => {
    class CustomError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "CustomError";
      }
    }

    expect(isError(new CustomError("test"))).toBe(true);
  });
});

describe("toError", () => {
  test("returns Error instance as-is", () => {
    const error = new Error("test error");
    expect(toError(error)).toBe(error);
  });

  test("converts string to Error", () => {
    const result = toError("error message");
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("error message");
  });

  test("converts object with message to Error", () => {
    const result = toError({ message: "object error" });
    expect(result).toBeInstanceOf(Error);
    // toError converts objects to string first, so it becomes "[object Object]"
    expect(result.message).toBe("[object Object]");
  });

  test("converts object without message to Error", () => {
    const obj = { code: "ERR_001", details: "something went wrong" };
    const result = toError(obj);
    expect(result).toBeInstanceOf(Error);
    // toError converts objects to string first, so it becomes "[object Object]"
    expect(result.message).toBe("[object Object]");
  });

  test("converts null and undefined to Error", () => {
    const nullResult = toError(null);
    expect(nullResult).toBeInstanceOf(Error);
    expect(nullResult.message).toBe("null");

    const undefinedResult = toError(undefined);
    expect(undefinedResult).toBeInstanceOf(Error);
    expect(undefinedResult.message).toBe("undefined");
  });

  test("converts numbers to Error", () => {
    const result = toError(404);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("404");
  });

  test("preserves stack trace when available", () => {
    const error = new Error("test");
    const result = toError(error);
    if (error.stack) {
      expect(result.stack).toBe(error.stack);
    }
  });
});
