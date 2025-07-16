# Only for humans - not for Claude

## TODOs - tasks to pick and solve

## Minor

1. Checkpoint on quit?
2. Universal system prompt
3. Add an interactive prompt to e2e tests (maybe a password?) so that Claude can't run it
4. Add in API key on start
5. Happy path test-notes isn't cleaned up?
6. Add documentation for the server events and commands

## Improvements

1. Implement a scaffold to replay existing claude logs for tests
2. Allow starting persistent commands (like servers) that are only cleaned up when server fully exits - with interactive prompts
3. Add proper error types to events
4. Add an ability to queue commands or something where the server can start up and shut down?
5. Consider ignoring gitignores?

## Major features

1. Rollback functionality to a particular checkpoint (IN PROGRESS 2)
2. Restart a phase (IN PROGRESS 3)
3. Resume functionality (IN PROGRESS 4)
4. Explainers - prompt calls that explain and stream active processes
5. Accept real-time prompts using input-stream json from claude
6. Abstract out claude code
7. Validators - phases concurrent or otherwise that provide feedback
8. Dockerization
9. Automated proxy
10. Auto-server serving files

## Applications

1. Langtonflow for making changelogs
2. Cleaning and validating data before pushing somewhere else
3. DO upload
4. splite/postgres interface
5. Dashboards

## Claude code weirdness noticed:

1. Using the LS command injects this message about whether files are malicious.
2. CC will sometimes generate malformed toolcalls.
