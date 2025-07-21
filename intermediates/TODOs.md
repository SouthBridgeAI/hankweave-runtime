# Only for humans - not for Claude

## TODOs - tasks to pick and solve

## Bugs

1. When we continue from a phase (or likely, have a pattern matching existing files) we read them as created new
2. In the cli don't accept wrong params
3. Explain config validation failures better

## Minor

1. Universal system prompt
1. Add an interactive prompt to e2e tests (maybe a password?) so that Claude can't run it
1. Add in API key on start
1. Happy path test-notes isn't cleaned up?
1. Add documentation for the server events and commands
1. Copy if not exists
1. Test and figure out if we're checking for running out of context on a phase, and handling properly
1. Bun isolated linker
1. Use proper discriminated unions for types

## Improvements

1. Implement a scaffold to replay existing claude logs for tests
2. Allow starting persistent commands (like servers) that are only cleaned up when server fully exits - with interactive prompts
3. Add proper error types to events
4. Add an ability to queue commands or something where the server can start up and shut down?
5. Passing in keys

## Major features

1. Symlink in the data folder and create a new folder for our run? Maybe id the run itself so that we maintain the problems?
1. Rollback functionality to a particular checkpoint (IN PROGRESS 2)
1. Restart a phase (IN PROGRESS 3)
1. Resume functionality (IN PROGRESS 4)
1. Explainers - prompt calls that explain and stream active processes
1. Accept real-time prompts using input-stream json from claude
1. Abstract out claude code
1. Validators - phases concurrent or otherwise that provide feedback
1. Dockerization
1. Automated proxy
1. Auto-server serving files

## Applications

1. Langtonflow for making changelogs
2. Cleaning and validating data before pushing somewhere else
3. DO upload
4. splite/postgres interface
5. Dashboards

## Claude code weirdness noticed:

1. Using the LS command injects this message about whether files are malicious.
2. CC will sometimes generate malformed toolcalls.
