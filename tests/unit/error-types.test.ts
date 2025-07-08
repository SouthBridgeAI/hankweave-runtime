import { describe, test, expect } from "bun:test";
import { FatalError, PhaseError, OperationError, ErrorSeverity } from "../../server/error-types";

describe("Error classes", () => {
  describe("FatalError", () => {
    test("sets severity to FATAL", () => {
      const error = new FatalError("Fatal error occurred");
      expect(error.severity).toBe(ErrorSeverity.FATAL);
    });

    test("includes context when provided", () => {
      const context = { code: "ERR_001", details: "Connection lost" };
      const error = new FatalError("Fatal error occurred", context);
      expect(error.context).toEqual(context);
    });

    test("has correct error name", () => {
      const error = new FatalError("Fatal error occurred");
      expect(error.name).toBe("FatalError");
    });

    test("inherits from Error", () => {
      const error = new FatalError("Fatal error occurred");
      expect(error).toBeInstanceOf(Error);
    });

    test("includes message", () => {
      const message = "Fatal error occurred";
      const error = new FatalError(message);
      expect(error.message).toBe(message);
    });
  });

  describe("PhaseError", () => {
    test("includes phaseId in context", () => {
      const error = new PhaseError("Phase failed", "test-phase");
      expect(error.context?.phaseId).toBe("test-phase");
    });

    test("merges additional context", () => {
      const additionalContext = { code: "PHASE_001", reason: "Timeout" };
      const error = new PhaseError("Phase failed", "test-phase", additionalContext);
      expect(error.context).toEqual({
        phaseId: "test-phase",
        code: "PHASE_001",
        reason: "Timeout"
      });
    });

    test("sets severity to PHASE", () => {
      const error = new PhaseError("Phase failed", "test-phase");
      expect(error.severity).toBe(ErrorSeverity.PHASE);
    });

    test("has correct error name", () => {
      const error = new PhaseError("Phase failed", "test-phase");
      expect(error.name).toBe("PhaseError");
    });
  });

  describe("OperationError", () => {
    test("sets severity to OPERATION", () => {
      const error = new OperationError("Operation failed", "test-operation");
      expect(error.severity).toBe(ErrorSeverity.OPERATION);
    });

    test("includes operation in context", () => {
      const context = { path: "/test.txt" };
      const error = new OperationError("Write failed", "file.write", context);
      expect(error.context).toEqual({
        operation: "file.write",
        path: "/test.txt"
      });
    });

    test("has correct error name", () => {
      const error = new OperationError("Operation failed", "test-operation");
      expect(error.name).toBe("OperationError");
    });

    test("includes operation in context without additional context", () => {
      const error = new OperationError("Operation failed", "test-op");
      expect(error.context).toEqual({ operation: "test-op" });
    });
  });

  // Note: There is no WarningError class, only a WARNING severity level

  describe("Error hierarchy", () => {
    test("all custom errors inherit from Error", () => {
      const fatalError = new FatalError("Fatal");
      const phaseError = new PhaseError("Phase", "phase-1");
      const operationError = new OperationError("Operation", "test-op");

      expect(fatalError).toBeInstanceOf(Error);
      expect(phaseError).toBeInstanceOf(Error);
      expect(operationError).toBeInstanceOf(Error);
    });

    test("severity levels are defined correctly", () => {
      // Check that all severity levels are defined
      expect(ErrorSeverity.FATAL).toBeDefined();
      expect(ErrorSeverity.PHASE).toBeDefined();
      expect(ErrorSeverity.OPERATION).toBeDefined();
      expect(ErrorSeverity.WARNING).toBeDefined();
      
      // Check that they have string values
      expect(typeof ErrorSeverity.FATAL).toBe("string");
      expect(typeof ErrorSeverity.PHASE).toBe("string");
      expect(typeof ErrorSeverity.OPERATION).toBe("string");
      expect(typeof ErrorSeverity.WARNING).toBe("string");
    });
  });
});