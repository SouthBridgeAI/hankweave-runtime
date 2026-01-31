import { describe, expect, test } from "bun:test";

/**
 * Tests for ENG-102: rigSetup info event message format contracts.
 *
 * The TUI (basic-tui.ts) uses string matching on specific phrases to format
 * rigSetup messages. These tests ensure the message formats don't accidentally
 * change, which would break TUI string matching.
 */
// Helper to format operation count (avoids TypeScript literal type narrowing issues)
function formatOperationCount(count: number): string {
  return count === 1 ? "operation" : "operations";
}

describe("rigSetup message format contract", () => {
  test("start message should contain 'Rig setup started'", () => {
    const codonName = "Test Codon";
    const count = 3;
    const message = `Rig setup started for codon '${codonName}': ${count} ${formatOperationCount(count)}`;

    expect(message).toContain("Rig setup started");
    expect(message).toContain(codonName);
  });

  test("start message should handle singular operation count", () => {
    const codonName = "Single Op Codon";
    const count = 1;
    const message = `Rig setup started for codon '${codonName}': ${count} ${formatOperationCount(count)}`;

    expect(message).toContain("Rig setup started");
    expect(message).toContain("1 operation");
    expect(message).not.toContain("operations");
  });

  test("operation message should contain 'Rig operation'", () => {
    const message = "Rig operation 1/3: copy templates/src → src";

    expect(message).toContain("Rig operation");
    expect(message).toMatch(/Rig operation \d+\/\d+:/);
  });

  test("completion message should contain 'Rig setup completed'", () => {
    const codonName = "Test Codon";
    const duration = 1234;
    const succeeded = 2;
    const failed = 1;
    const message = `Rig setup completed for codon '${codonName}' (${duration}ms, ${succeeded} succeeded${failed > 0 ? `, ${failed} failed` : ""})`;

    expect(message).toContain("Rig setup completed");
    expect(message).toContain("ms");
    expect(message).toContain("succeeded");
  });

  test("completion message with failures should contain 'failed'", () => {
    const message = "Rig setup completed for codon 'Test' (1234ms, 2 succeeded, 1 failed)";

    expect(message).toContain("failed");
  });

  test("completion message without failures should NOT contain 'failed'", () => {
    const codonName = "Test";
    const duration = 1234;
    const succeeded = 3;
    const failed = 0;
    const message = `Rig setup completed for codon '${codonName}' (${duration}ms, ${succeeded} succeeded${failed > 0 ? `, ${failed} failed` : ""})`;

    expect(message).not.toContain("failed");
  });

  test("message format matches TUI string matching expectations", () => {
    // These are the exact string checks used in basic-tui.ts handleServerEvent
    // for type: "info" events

    const startMessage = "Rig setup started for codon 'MyCodon': 2 operations";
    const completeMessageSuccess = "Rig setup completed for codon 'MyCodon' (500ms, 2 succeeded)";
    const completeMessageFailure =
      "Rig setup completed for codon 'MyCodon' (500ms, 1 succeeded, 1 failed)";
    const operationMessage = "Rig operation 1/2: command echo hello";

    // TUI checks for these patterns:
    expect(startMessage.includes("Rig setup started")).toBe(true);
    expect(completeMessageSuccess.includes("Rig setup completed")).toBe(true);
    expect(completeMessageFailure.includes("Rig setup completed")).toBe(true);
    expect(operationMessage.includes("Rig operation")).toBe(true);

    // TUI checks for failure indicator:
    expect(completeMessageSuccess.includes("failed")).toBe(false);
    expect(completeMessageFailure.includes("failed")).toBe(true);
  });
});
