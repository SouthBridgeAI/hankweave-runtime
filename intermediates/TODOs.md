# Only for humans - not for Claude

## TODOs - tasks to pick and solve

1. Move the working dir INSIDE another folder so claude can't see .tadpole?

# Bugs
1. The execution thread module has some dead code


## Finish tasks
1. Data directory OR file
2. Output management and setup
3. Parallel calls
4. Allow looping phases?
5. Telemetry
6. Resume function
7. Check if we're close to end of tokens and allow for an `any more?` style exhaustiveness push


### P1

1. Implement a resume function which will clean up the current phase and restart a run.
2. Reloading prompt files on rollback and restart.

### P2

1. Universal system prompts
2. Explainers - prompt calls that explain and stream active processes
3. Validators - phases concurrent or otherwise that provide feedback

### P3 (much later)

1. Interactive message sending
2. Ability to be dropped into an agent after any phase
3. Allow starting persistent commands (like servers) that are only cleaned up when server fully exits - with interactive prompts
4. Add an ability to queue commands or something where the server can start up and shut down?
5. Abstract out claude code
6. Dockerization
7. Automated proxy
8. Auto-server serving files
9. Be able to source websocket log (with filtering) as an input itself

### Cleanup stuff

1. Bun isolated linker
2. Add an interactive prompt to heay tests so they can't be autorun

## Bugs

1. When we continue from a phase (or likely, have a pattern matching existing files) we read them as created new
2. Check why some of the qwen logs weren't being read properly


### Tests

1. Crash server and restart. We want to intentionally kill the server, restart, roll back the current phase’s work and continue the phase. If all goes well we should be able to finish executing all phases.
2. Test and figure out if we're checking for running out of context on a phase, and handling properly
3. Be able to replay existing logs


## Applications

1. Tadpoleflow for making changelogs
2. Cleaning and validating data before pushing somewhere else
3. DO upload
4. splite/postgres interface
5. Dashboards

## Claude code weirdness noticed:

1. Using the LS command injects this message about whether files are malicious.
2. CC will sometimes generate malformed toolcalls.
