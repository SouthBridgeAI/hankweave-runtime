# Only for humans - not for Claude

## TODOs - tasks to pick and solve

### P1

1. Implement a resume function which will clean up the current phase and restart a run.
2. Reloading prompt files on rollback and restart.
3. Move phases to an array and phase configs can be an object

### P2

1. Universal system prompts
2. Symlink in data and run in a separate folder
3. Explainers - prompt calls that explain and stream active processes


### P3 (much later)

1. Interactive message sending
2. Ability to be dropped into an agent after any phase
3. Allow starting persistent commands (like servers) that are only cleaned up when server fully exits - with interactive prompts
4. Add an ability to queue commands or something where the server can start up and shut down?
5. Abstract out claude code
6. Validators - phases concurrent or otherwise that provide feedback
7. Dockerization
8. Automated proxy
9. Auto-server serving files



### Cleanup stuff

1. Consider discriminated unions for some types
2. Rename things
3. Bun isolated linker
4. Add an interactive prompt to heay tests so they can't be autorun

## Bugs

1. When we continue from a phase (or likely, have a pattern matching existing files) we read them as created new
2. Check why some of the qwen logs weren't being read properly


### Tests

1. Crash server and restart. We want to intentionally kill the server, restart, roll back the current phase’s work and continue the phase. If all goes well we should be able to finish executing all phases.
2. Test and figure out if we're checking for running out of context on a phase, and handling properly
3. Be able to replay existing logs


## Applications

1. Langtonflow for making changelogs
2. Cleaning and validating data before pushing somewhere else
3. DO upload
4. splite/postgres interface
5. Dashboards

## Claude code weirdness noticed:

1. Using the LS command injects this message about whether files are malicious.
2. CC will sometimes generate malformed toolcalls.
