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

1. Actually implement rollbacks on checkpoints, failed resumes
2. Abstract out claude code so we can sub in other things
3. Implement a langtonflow for making changelogs
4. Check for more tests to add
   1. Are we pulling files we don't want into the shadow git?
5. Use input stream json and implement and test
6. Use git commits! (done)
7. Move .logs into .langton (done)
8. Consider using bind mounts to make the actual data inputs completely read-only
9. Use full paths for folders and replace those in the prompts. (done)
10. safe_exec and that journey
11. Implement actual workspace copying in and out instead of running commands which can be brittle
12. Retry system and error handling?
13. Use git commits to rollback changes?
14. Actually tracking file edits to show what changed instead of chokidar
15. Extracting data after phases or at completion?
16. Adding description streaming with flash

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
