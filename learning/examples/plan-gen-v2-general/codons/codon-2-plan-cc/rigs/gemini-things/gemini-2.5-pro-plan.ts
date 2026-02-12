// To run this code you need to install the following dependencies:
// npm install @google/genai
// npm install -D @types/node
//
// Usage: bun run gemini-2.5-pro-plan.ts <input-files...> -o <output-file>
// Example: bun run gemini-2.5-pro-plan.ts ./code.txt ./task.md ./writing-ref.md -o ./plan.md
//
// Input files are XML-tagged with their filename (no path) in the prompt.

import { GoogleGenAI } from "@google/genai";
import { readFileSync, writeFileSync } from "fs";
import { basename } from "path";

function parseArgs(args: string[]): {
  inputFiles: string[];
  outputFile: string;
} {
  const outputIndex = args.indexOf("-o");

  if (outputIndex === -1 || outputIndex === args.length - 1) {
    console.error("Error: Missing -o <output-file> argument");
    console.error(
      "Usage: bun run gemini-2.5-pro-plan.ts <input-files...> -o <output-file>",
    );
    console.error(
      "Example: bun run gemini-2.5-pro-plan.ts ./code.txt ./task.md ./writing-ref.md -o ./plan.md",
    );
    process.exit(1);
  }

  const inputFiles = args.slice(0, outputIndex);
  const outputFile = args[outputIndex + 1];

  if (inputFiles.length === 0) {
    console.error("Error: No input files provided");
    console.error(
      "Usage: bun run gemini-2.5-pro-plan.ts <input-files...> -o <output-file>",
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

function extractPlan(text: string): string | null {
  const match = text.match(/<plan>([\s\S]*?)<\/plan>/i);
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
          text: `You have the code for a project we're working on, as well as a detailed (as much as possible) spec of a task.

Could you think through this task and the execution with the following things in mind?
1. What information are you making your decisions with access to?
2. What does this task imply in the broader context of the code? The agent that created the specification for the task could not see the code. What is now clearer? How can the intent be clarified further?
3. What is the existing behavior in its complexity that's connected to the task? What does the system currently do? Think through it first.
4. What conventions do you notice in the code that is relevant to this task?
5. What files, modules and areas are most affected?
6. What additional optional flourishes could be added to make the user experience or the code better?
7. What are the key judgement calls that need to be made? How will they impact the result - in output, in the code, in maintainability, in features, etc. Provide your recommendations as well.
8. Where do you recommend drawing the line between over and under-engineering? Use the code as a guide to inferring the answer.

After you think through all of these, write those first - and then a detailed plan (with references to files) on how to implement this task. Use the writing_reference as a guide.

Refer to yourself as 'Gemini-Single-Shot-Planning-Agent' if you need to. Intend for the plan to be standalone, to be read with the task document. Place the plan in between <plan> tags.`,
        },
      ],
    },
  ];

  try {
    const fileList = inputFiles.map((f) => basename(f)).join(", ");
    console.log(`Generating plan from: ${fileList}`);
    console.log(`Using model: ${model}`);

    const startTime = Date.now();

    const response = await ai.models.generateContent({
      model,
      config,
      contents,
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const fullText = response.text || "";
    const plan = extractPlan(fullText);

    if (plan) {
      writeFileSync(outputFile, plan);
      console.log(`Plan written to ${outputFile} (${elapsed}s)`);
    } else {
      // If no <plan> tags found, write the full response
      console.error(
        "Warning: No <plan> tags found in response, writing full response",
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
