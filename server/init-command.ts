import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Initialize a new Strandweave project with basic template files
 */
export async function initProject(targetDir: string): Promise<void> {
  const templatesDir = path.join(__dirname, "templates", "init");

  // Ensure target directory exists
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Check if directory is empty or only has .git
  const existingFiles = fs
    .readdirSync(targetDir)
    .filter((file) => file !== ".git" && file !== ".gitignore");

  if (existingFiles.length > 0) {
    throw new Error(
      `Directory ${targetDir} is not empty. Please run init in an empty directory or specify a new directory.`,
    );
  }

  // Create prompts directory
  const promptsDir = path.join(targetDir, "prompts");
  fs.mkdirSync(promptsDir, { recursive: true });

  // Copy template files
  const files = [
    { template: "strand.json.template", target: "strand.json" },
    { template: "analyze.md.template", target: "prompts/analyze.md" },
    { template: "gitignore.template", target: ".gitignore" },
    { template: "README.md.template", target: "README.md" },
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

  console.log(`\n✅ Initialized Strandweave project in ${targetDir}\n`);
  console.log("Created files:");
  console.log("  - strand.json");
  console.log("  - prompts/analyze.md");
  console.log("  - .gitignore");
  console.log("  - README.md");
}
