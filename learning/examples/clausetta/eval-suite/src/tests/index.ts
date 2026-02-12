import type { TestDefinition, TestCategory } from "../types.js";
import { coreTests } from "./core.js";
import { toolTests } from "./tools.js";
import { signalTests } from "./signals.js";
import { sessionTests } from "./sessions.js";
import { errorTests } from "./errors.js";
import { stressTests, runBinaryFileHandling, runLargeOutputHandling } from "./stress.js";
import { validationTests } from "./validation.js";
import { agenticTests } from "./agentic.js";

// All test definitions
export const allTests: TestDefinition[] = [
  ...coreTests,
  ...toolTests,
  ...signalTests,
  ...sessionTests,
  ...errorTests,
  ...stressTests,
  ...validationTests,
  ...agenticTests,
];

// Tests by category
export const testsByCategory: Record<TestCategory, TestDefinition[]> = {
  core: coreTests,
  tools: toolTests,
  signals: signalTests,
  sessions: sessionTests,
  errors: errorTests,
  stress: stressTests,
  validation: validationTests,
  agentic: agenticTests,
};

// Get tests by category
export function getTestsByCategory(category: TestCategory): TestDefinition[] {
  return testsByCategory[category] || [];
}

// Get test by name
export function getTestByName(name: string): TestDefinition | undefined {
  return allTests.find((t) => t.name === name);
}

// Get all test names
export function getAllTestNames(): string[] {
  return allTests.map((t) => t.name);
}

// Get tests by priority
export function getTestsByPriority(priority: "P1" | "P2" | "P3"): TestDefinition[] {
  return allTests.filter((t) => t.priority === priority);
}

export { coreTests, toolTests, signalTests, sessionTests, errorTests, stressTests, validationTests, agenticTests };

