import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Initialize a new strand with basic template files
 */
export async function initProject(targetDir: string): Promise<void> {
  const templatesDir = path.join(__dirname, "templates", "init");

  // Ensure target directory exists
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Check if directory is empty or only has .git
  const existingFiles = fs.readdirSync(targetDir);

  if (existingFiles.length > 0) {
    throw new Error(
      `Directory ${targetDir} is not empty. Please run init in an empty directory or specify a new directory.`,
    );
  }

  // Create prompts directory
  const promptsDir = path.join(targetDir, "prompts");
  fs.mkdirSync(promptsDir, { recursive: true });

  // Create data directory
  const dataDir = path.join(targetDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });

  // Copy template files
  const files = [
    { template: "strand.json.template", target: "strand.json" },
    { template: "analyze.md.template", target: "prompts/analyze.md" },
    { template: "gitignore.template", target: ".gitignore" },
    { template: "README.md.template", target: "README.md" },
    { template: "data-sample1.txt.template", target: "data/sample1.txt" },
    { template: "data-sample2.txt.template", target: "data/sample2.txt" },
    { template: "data-notes.txt.template", target: "data/notes.txt" },
  ];

  for (const { template, target } of files) {
    const templatePath = path.join(templatesDir, template);
    const targetPath = path.join(targetDir, target);

    if (!fs.existsSync(templatePath)) {
      throw new Error(`Template file not found: ${templatePath}`);
    }

    const content = fs.readFileSync(templatePath, "utf-8");
    fs.writeFileSync(targetPath, content, "utf-8");
  }

  console.log(`\n✅ Initialized strand in ${targetDir}\n`);
  console.log("Created files:");
  console.log("  - strand.json");
  console.log("  - prompts/analyze.md");
  console.log("  - data/sample1.txt");
  console.log("  - data/sample2.txt");
  console.log("  - data/notes.txt");
  console.log("  - .gitignore");
  console.log("  - README.md");
}
