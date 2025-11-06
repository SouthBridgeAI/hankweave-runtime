You're given these files and folders from a larger project:
server/types/input-ai-types.ts documentation external-docs/ai-sdk tests/integration server/chroniclers package.json biome.json README.md

The task here is to come up with a good set of types and mocks we can use to test llm calls without really calling llms. In that process, we want to do the following things:
1. Come up with good schemas and types for:
   1. Model calling: Just parameters that are common and useful across all models like temperature, max_tokens, etc. We don't want to overcomplicate this with things like top_p and top_k for now.
   2. Inputs to models: This is already done, look at that file to understand how we've done it. Unless there's something missing, in which case flag it.
   3. Outputs from models: The different functions we care about return different kinds of outputs and need different interfaces. We want a function interface mock for each that serves as a solid subset of the main AI SDK function we will eventually use.
2. Place the schemas and interfaces in the main code, but the actual mock should sit in the test code. You have some examples of the integration tests, but we also have unit tests and e2e tests (too large to give you right now).

We want the following properties:
1. The schemas and derived types should be a subset of what the key functions in the AI SDK (generateText, streamText and generateObject) accept. Look at how we've done this already for ModelMessage, and how we're verifying compatibility at build time, in order to do this.
2. The mocks should respond as appropriately as possible. This includes things like:
   1. Reasonable response values. For the response text, this could just be the prompt text being repeated back - anything deterministic we can check.
   2. Response timings. We should ideally have some randomness (to simulate an API call), but the overall response time should be proportional to the length of the prompt itself on some level.
   3. Streaming: If we stream back responses, they should be slowed down to represent a real call.
   4. Objects: The returned objects should ideally fit the schema being passed in or requested.

This is a typescript bun project.

DON'T MAKE ANY CHANGES TO CODE YET. Think through this, and come up with a detailed plan which contains the schemas, code, etc, where to put it, what to change, etc. Prefer English (and explain intent, repeat the priorities in the plan from me) over all code, and build a standalone plan that someone can pick up and execute on without needing any other context. Feel free to err on the side of more context - even if it means re-explaining the project itself.