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

1. Use full paths for folders and replace those in the prompts.
2. safe_exec and that journey
3. Make use of system prompts
4. Implement actual workspace copying in and out instead of running commands which can be brittle
5. Retry system and error handling?
6. Use git commits to rollback changes?
7. Actually tracking file edits to show what changed instead of chokidar
8. Extracting data after phases or at completion?
9. Adding description streaming with flash

TODOs for Schema thing:

1. Tightening - see what can be converted to enums
2. Clean up the existing directory instead of making new loader
3. Generating questions that can be used to validate the system at the end
4. Warn about silent failures in schemas
5. Check for default value injection
6. Does phase 2b forget about timeouts?
7. Some of the phases don't put things in the src directory but instead directly in the typescript directory

Experimental:

1. Watching the agent log and adding comments?
2. Can a langton workflow be a gauntlet - something that cleans and validates data to push it somewhere else?
3.
