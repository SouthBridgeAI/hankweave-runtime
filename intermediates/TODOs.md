# Only for humans - not for Claude

## TODOs - tasks to pick and solve

## Cleanups

1. Remove the langton phases from repo

## Minor

1. Verify why the timeout errors aren't being recognized properly - now with more logs
2. Check and merge checkpointAndWatch with Watch?
3. Universal system prompt
4. Add an interactive prompt to e2e tests (maybe a password?) so that Claude can't run it
5. Add in API key on start

## Improvements

1. Implement a scaffold to replay existing claude logs for tests
2. Allow starting persistent commands (like servers) that are only cleaned up when server fully exits - with interactive prompts
3. Rename runner to tadpole?

## Major features

1. State management
2. Rollback functionality to a particular checkpoint
3. Restart a phase
4. Resume functionality
5. Accept real-time prompts using input-stream json from claude
6. Abstract out claude code
7. Explainers - prompt calls that explain and stream active processes
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
