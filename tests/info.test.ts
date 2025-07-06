import { test } from "bun:test";

test("Langton tests are standalone scripts", () => {
  console.log("\n");
  console.log("ℹ️  Langton tests are not written as Bun test files.");
  console.log("They are standalone E2E scripts that test the full server.");
  console.log("");
  console.log("To run tests, use one of these commands:");
  console.log("  • bun run test      - Run the full E2E test suite");
  console.log("  • bun run test:e2e  - Run E2E tests directly");
  console.log("  • bun run test:sanity - Check test environment");
  console.log("  • bun run test:check  - Check test readiness");
  console.log("");
  console.log("See tests/README.md for more information.");
  console.log("\n");
});
