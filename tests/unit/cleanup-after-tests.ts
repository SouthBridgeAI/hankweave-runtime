import * as fs from "node:fs";
import * as path from "node:path";

// Clean up test-area after unit tests
const testAreaPath = path.resolve("tests", "test-area");

async function cleanupTestArea() {
  try {
    // Get all items in test-area
    const items = await fs.promises.readdir(testAreaPath);

    // Remove all temp directories and .tadpole directory
    for (const item of items) {
      const itemPath = path.join(testAreaPath, item);
      const stats = await fs.promises.stat(itemPath);

      if (stats.isDirectory() && (item.startsWith("temp-test-") || item === ".tadpole")) {
        console.log(`Cleaning up: ${item}`);
        await fs.promises.rm(itemPath, { recursive: true, force: true });
      }
    }

    console.log("✅ Test area cleaned up");
  } catch (error) {
    console.error("Error cleaning up test area:", error);
  }
}

// Run cleanup
cleanupTestArea();
