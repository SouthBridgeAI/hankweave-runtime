Only for humans - not for Claude

Set up:

1. Create code folder with the src and subfolders.
2. Bun init
3. Install dependencies
   bun add papaparse csv-parse exceljs xlsx ajv parquet-wasm apache-arrow date-fns mathjs lodash @turf/turf && bun add -d @types/papaparse @types/lodash @types/geojson
4. Check for system dependencies and tools
5. Set up git

While running:

1. Parse the notes file
2. Check for failed commands and provide documentation?
3. Parse the logs file into a proper context doc for phase handover

- Check successful and failed commands

TODOs:

1. Check why we're using branded-types.js
1. Check checkpoint and watch and see if needs renaming or merging with watch?
1. Validate command for phases
1. Cleanup command to rollback to checkpoint
1. dry run to validate phases, skip all without starting claude, and rollback
1. Actually implement rollbacks on checkpoints, failed resumes
1. Add a universal system prompt that gets appended to the top of all phases
1. Abstract out claude code so we can sub in other things
1. Implement a langtonflow for making changelogs
1. Use input stream json and implement and test
1. Use git commits! (done)
1. Move .logs into .langton (done)
1. Consider using bind mounts to make the actual data inputs completely read-only
1. Use full paths for folders and replace those in the prompts. (done)
1. safe_exec and that journey
1. Implement actual workspace copying in and out instead of running commands which can be brittle
1. Retry system and error handling?
1. Extracting data after phases or at completion?
1. Adding description streaming with flash
1. Add some interactive check to e2e tests so claude can't run it
1. Add a message about the cost tracking that's human so claude won't keep changing it back
1. Rename the actual runner to tadpole?
1. Investigate whether we need our own internal messageid since Claude reuses messageids

Cleanup TODOs:

1. Change the model names from claude-opus-3
2. Claude log parser has that tokenswithcost thing that needs fixing

TODOs for Schema thing:

1. Clean up the existing directory instead of making new loader
2. Warn about silent failures in schemas
3. Check for default value injection
4. Does phase 2b forget about timeouts?
5. Some of the phases don't put things in the src directory but instead directly in the typescript directory

Experimental:

1. Watching the agent log and adding comments?
2. Can a langton workflow be a gauntlet - something that cleans and validates data to push it somewhere else?
3.

Claude code weirdness noticed:

1. Using the LS command injects this message about whether files are malicious.
2. CC will sometimes generate malformed toolcalls.

Big features:

1. Checkpoints
   1. Rollback
   2. Resume
   3. Maintain branches
   4. Include claude.jsonls?
   5. Cost tracking
   6. checkpointgit initialization when things have already started
