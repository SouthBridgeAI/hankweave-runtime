import { describe, expect, it } from "bun:test";
import { captureEnv, restoreEnv } from "./env-test-helpers.js";

describe("env-test-helpers", () => {
  it("should capture and restore environment correctly", () => {
    // Set up initial state
    process.env.TEST_VAR_1 = "initial";
    process.env.TEST_VAR_2 = "value2";

    // Capture
    const captured = captureEnv();

    // Modify
    process.env.TEST_VAR_1 = "modified";
    delete process.env.TEST_VAR_2;
    process.env.TEST_VAR_3 = "new";

    // Verify modifications
    expect(process.env.TEST_VAR_1).toBe("modified");
    expect(process.env.TEST_VAR_2).toBeUndefined();
    expect(process.env.TEST_VAR_3).toBe("new");

    // Restore
    restoreEnv(captured);

    // Verify restoration
    expect(process.env.TEST_VAR_1).toBe("initial");
    expect(process.env.TEST_VAR_2).toBeDefined();

    expect(process.env.TEST_VAR_2 === "value2").toBe(true);

    expect(process.env.TEST_VAR_3).toBeUndefined();

    // Cleanup
    delete process.env.TEST_VAR_1;
    delete process.env.TEST_VAR_2;
  });

  it("should handle undefined values correctly", () => {
    // Make sure TEST_VAR_X doesn't exist
    delete process.env.TEST_VAR_X;

    const captured = captureEnv();

    // Add a variable
    process.env.TEST_VAR_X = "test";

    // Restore
    restoreEnv(captured);

    // Should be removed
    expect(process.env.TEST_VAR_X).toBeUndefined();
  });
});
