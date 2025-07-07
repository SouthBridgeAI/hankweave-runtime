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
