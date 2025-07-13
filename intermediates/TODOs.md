# Only for humans - not for Claude

## TODOs - tasks to pick and solve

## Minor

1. Checkpoint on quit?
2. Universal system prompt
3. Add an interactive prompt to e2e tests (maybe a password?) so that Claude can't run it
4. Add in API key on start
5. Happy path test-notes isn't cleaned up?

## Improvements

1. Implement a scaffold to replay existing claude logs for tests
2. Allow starting persistent commands (like servers) that are only cleaned up when server fully exits - with interactive prompts

## Major features

1. State management (IN PROGRESS)
2. Rollback functionality to a particular checkpoint (IN PROGRESS 2)
3. Restart a phase (IN PROGRESS 3)
4. Resume functionality (IN PROGRESS 4)
5. Explainers - prompt calls that explain and stream active processes
6. Accept real-time prompts using input-stream json from claude
7. Abstract out claude code
8. Validators - phases concurrent or otherwise that provide feedback
9. Dockerization
10. Automated proxy

## Applications

1. Langtonflow for making changelogs
2. Cleaning and validating data before pushing somewhere else
3. DO upload
4. splite/postgres interface
5. Dashboards

## Claude code weirdness noticed:

1. Using the LS command injects this message about whether files are malicious.
2. CC will sometimes generate malformed toolcalls.
