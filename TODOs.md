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

1. Use git commits!
2. Move .logs into .langton
3. Use full paths for folders and replace those in the prompts.
4. safe_exec and that journey
5. Implement actual workspace copying in and out instead of running commands which can be brittle
6. Retry system and error handling?
7. Use git commits to rollback changes?
8. Actually tracking file edits to show what changed instead of chokidar
9. Extracting data after phases or at completion?
10. Adding description streaming with flash

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
