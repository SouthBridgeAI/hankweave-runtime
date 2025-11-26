We are embarking on a large refactor of this codebase and package, but currently we're only focused on the code in `server`.

There are the things we're renaming in @intermediates/21-names/6-finalization/0-naming-deets.md and a detailed plan in @intermediates/21-names/6-finalization/2-code-refactor-plan.md .

Here's what I want you to do. Rename things (don't do bulk renames unless you're absolutely sure, and even then ast-grep and target it to a specific file after reading it fully and making sure) file by file with targeted edits, and check your work at the end with `bun tc` and `bun lint:fix`.

We're halfway through. Check the code to see how far we've come and pick up where we left off. You can check the work that's been staged so far if you're not sure.