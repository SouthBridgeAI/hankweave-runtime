import { query } from "@anthropic-ai/claude-agent-sdk";

async function main() {
  const prompt =
    process.argv[2] ||
    "Create a file called hello.txt with the text 'Hello, World!'";

  console.log(`Prompt: ${prompt}\n`);

  try {
    for await (const message of query({
      prompt,
      options: {
        permissionMode: "bypassPermissions",
        settingSources: ["user"],
      },
    })) {
      // got a message back
      // can put it to the log file and continue using claud-log-parser to do its thing
      // or emit message directly
      console.log(message);
    }
  } catch (error) {
    handleError(error);
    process.exit(1);
  }
}

function handleError(error: unknown): void {
  console.error("An error occurred:", error);
}

main();
