This is a project I'm working on. Read the readme files to get a good idea on the project, and follow these rules when working in it.

1. Ignore the tests/test-area and tests/test-results folder when using grep unless you're specifically looking for those files.
2. Ignore the intermediates folder unless explicitly instructed to.
3. Prefer not to use subtasks. If you use them, make sure to provide enough context to the task to execute without you, and provide clear instructions on what information to pass back.
4. Don't commit without asking.
5. When presented with a change, read through files to deepen your understanding (your first assumptions are often wrong), then present the user with a plan and options (if there are any), and wait for a green light.
6. Use bun lint:fix and bun run build to check your results.
7. DO NOT RUN bun test (or any of the tests). Ask the user to run the tests - they're expensive and take some time.
8. Read the readme files in ./README.md, ./server/README.md, ./tests/README.md as a way to understand the code - but keep in mind that the READMEs may be a little stale to where the code is now. Always verify.
