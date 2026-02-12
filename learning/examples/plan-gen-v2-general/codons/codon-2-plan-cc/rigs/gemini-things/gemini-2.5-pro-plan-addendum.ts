// To run this code you need to install the following dependencies:
// npm install @google/genai
// npm install -D @types/node
//
// Usage: bun run gemini-2.5-pro-plan-addendum.ts <input-files...> -o <output-file>
// Example: bun run gemini-2.5-pro-plan-addendum.ts ./plan.md ./task.md ./tests.ts ./docs.md -o ./addendum.md
//
// Input files are XML-tagged with their filename (no path) in the prompt.
// Expects: the main plan, task spec, plus tests/docs/supplementary files.

import { GoogleGenAI } from "@google/genai";
import { readFileSync, writeFileSync } from "fs";
import { basename } from "path";

function parseArgs(args: string[]): { inputFiles: string[]; outputFile: string } {
  const outputIndex = args.indexOf("-o");

  if (outputIndex === -1 || outputIndex === args.length - 1) {
    console.error("Error: Missing -o <output-file> argument");
    console.error(
      "Usage: bun run gemini-2.5-pro-plan-addendum.ts <input-files...> -o <output-file>"
    );
    console.error(
      "Example: bun run gemini-2.5-pro-plan-addendum.ts ./plan.md ./task.md ./tests.ts ./docs.md -o ./addendum.md"
    );
    process.exit(1);
  }

  const inputFiles = args.slice(0, outputIndex);
  const outputFile = args[outputIndex + 1];

  if (inputFiles.length === 0) {
    console.error("Error: No input files provided");
    console.error(
      "Usage: bun run gemini-2.5-pro-plan-addendum.ts <input-files...> -o <output-file>"
    );
    process.exit(1);
  }

  return { inputFiles, outputFile };
}

function readFile(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error reading file '${path}': ${message}`);
    process.exit(1);
  }
}

function buildTaggedContent(inputFiles: string[]): string {
  return inputFiles
    .map((filePath) => {
      const filename = basename(filePath);
      const content = readFile(filePath);
      return `<${filename}>\n${content}\n</${filename}>`;
    })
    .join("\n\n");
}

function extractAddendum(text: string): string | null {
  const match = text.match(/<addendum>([\s\S]*?)<\/addendum>/i);
  return match ? match[1].trim() : null;
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("Error: GEMINI_API_KEY environment variable not set");
    process.exit(1);
  }

  const { inputFiles, outputFile } = parseArgs(process.argv.slice(2));
  const taggedContent = buildTaggedContent(inputFiles);

  const ai = new GoogleGenAI({ apiKey });

  const config = {
    thinkingConfig: {
      thinkingBudget: 20000,
    },
    systemInstruction: [
      {
        text: taggedContent,
      },
    ],
  };

  const model = "gemini-2.5-pro";

  const contents = [
    {
      role: "user" as const,
      parts: [
        {
          text: `You have been given:
- A plan for implementing a task (produced by a previous planning agent)
- The original task specification
- Supplementary materials: tests, documentation, or other reference files. Adjust your approach based on what additional info is being provided.

Your job is to produce an **addendum** to the plan that covers everything the original plan could not address because it didn't have access to these supplementary materials. The original plan was generated with the core code in context.

Think through the following:
1. What new information is being provided? How does it relate to what the original plan had? How does it connect? What increased visibility is there? How does this change approaches?
2. What information do the supplementary materials provide that the original plan didn't have access to?
3. What new things are affected??
4. Are there any conflicts or inconsistencies between the plan and what the new information reveals about the system?
5. Are there any new implications, risks, or considerations that emerge from reviewing these materials?
6. Does the supplementary material reveal any assumptions in the plan that need to be revisited?

After your analysis, write a detailed addendum that:
- References specific files and locations
- Notes any corrections or refinements to the original plan
- Highlights any new risks or considerations

Use the writing style from any writing_reference file if provided.

Refer to yourself as 'Gemini-Addendum-Agent' if you need to. The addendum should be standalone but intended to be read alongside the original plan and task. Place the addendum in between <addendum> tags.`,
        },
      ],
    },
  ];

  try {
    const fileList = inputFiles.map((f) => basename(f)).join(", ");
    console.log(`Generating addendum from: ${fileList}`);
    console.log(`Using model: ${model}`);

    const startTime = Date.now();

    const response = await ai.models.generateContent({
      model,
      config,
      contents,
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const fullText = response.text || "";
    const addendum = extractAddendum(fullText);

    if (addendum) {
      writeFileSync(outputFile, addendum);
      console.log(`Addendum written to ${outputFile} (${elapsed}s)`);
    } else {
      // If no <addendum> tags found, write the full response
      console.error(
        "Warning: No <addendum> tags found in response, writing full response"
      );
      writeFileSync(outputFile, fullText);
      console.log(`Full response written to ${outputFile} (${elapsed}s)`);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error calling Gemini API: ${message}`);
    process.exit(1);
  }
}

main();
