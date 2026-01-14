This is a project we're building. Look at @README.md to understand the project, and feel free to look at the code (the bulk of it is in @server, the tests are in ./tests (integration, e2e and unit)). ./intermediates contains past feature plans and building processes. Both the tests folder and intermediates folder are quite large so read it carefully if you do - but you often don't need to.

Here are a number of linear tasks that we need to work on. We're at the very beginning of this process. The first part is just grooming, and collecting more information. Here are the main steps:

1. Grooming: Downloading descriptions into separate plans, looking at other open linear tasks that may be connected, loading GH PRs and discussions, etc. At the end we want a folder with a clean set of tasks each with their own md files ordered by size, with related tasks, gh discussions, etc.
2. Connecting to codebase: This is where we enrich it with information from the codebase - related files, existing work, etc etc.
3. Research: do any web research (not always needed) to better understand convention, new ideas, libraries etc that could be helpful.
4. Building plans: This is where we build specific plans to implement the changes.
5. Enriching and reviewing plans: This is where we read all the plans, understand them, and make opinionated changes to prevent over or under-engineering, to implement in the right order with the new information we have, and to make things as polished as possible.
6. Testing plans: This is where we add plans to test behavior, integration, etc.
7. Final review: this is where we review the plans and write a front cover ordering them with some information so they can be picked up and executed.

# General Guidelines

1. Don't add time estimates to tasks. This is unnecessary. If you find any, PLEASE REMOVE THEM!
2. Write in full sentences instead of bullet points. Make sure intent carries through. Use quotes where would be important - make it clear what is from which human and what is from you, the agent.
3. Link to other files and things where possible - to make sure all context is preserved and connected.
4. Don't worry about context exhaustion. You can use subagents towards the end (prefer not to) if you're really pressed for space, but your context will auto-compact as you keep going.
5. Don't stop and ask the user questions - you are in a headless environment and this will just mean that the task will stall. Continue to finish to the best of your ability.
6. If you do use subagents, make sure the prompt for them is very, VERY detailed, along with instructions on what to respond to you with. This will prevent hallucinations where their level of certainty about something or knowledge isn't passed to you. Prefer not to use subagents and instead do things sequentially.
7. There's no need to make additional markdown files than what is requested.
8. In cases where you need to update individual plans, DO NOT make a combined document. It might be more work, but please edit the plans individually and make small targeted edits. This is always better and makes for better documents. Information is lost on rewriting or summarizing.
