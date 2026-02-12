We've spent a lot of time (and a lot of iterative loops) improving the plan.

You don't need to read these files, but here are the intermediates we've created in the process of building a better plan.

- `./plan/reviews/` contains each round of iterative improvement of the plan itself by asking an agent with fresh eyes to understand the plan.
- `./plan/implementations` contains test results and feedback from agents that attempted to implement the plan.

@<%EXECUTION_DIR%>/plan/merged/plan.md contains the current latest version of the plan. Our job now is to clean things up, remove anything superfluous and unnecessary, and build a briefing for a human senior engineer to review, and a guide for a future agent to implement the plan. Follow this process to build these:

# PROCESS

1. Read the plan and addendums into context so they're fully understood.
2. See if any parts need more clarification and add those - conversely, see if any parts can be compressed a little or rearranged through targeted edits. DO NOT REWRITE THE PLAN - you will likely lose key information if you do.
3. Write a `plan/human_briefing.md` briefing for a human senior engineer, covering the task, the plan, major and minor changes, judgement calls - recommendations, options and implications. Write in full sentences and well, like you respect the reader's time.
4. Write a `plan/drop_me_into_your_agent.md`. Think from the perspective of the agent receiving this document - and do the following:
   - Give the agent the information on where all the planning files are, and what to find in each.
   - Provide some information on how this plan was developed.
   - Inform it that the task is to implement the plan, and provide context about the repo, documentation, etc - especially in a way that is relevant to the task(s).
   - Ask it to first walk the human on the other side through the key judgement calls and get **informed consent** - of the choices, the implications, and what is going to happen. Cover with the user what the options are, different paths that are possible, etc - and instruct the agent to update the plans (and where) if the user changes their mind. First explain the plans and the relevant parts of the plan to the judgement call.
   - Provide it with granular todos and self-check points to test and ensure things function well.

# GUIDELINES

1. The implementations that already happened were done as testing to learn what was possible, and to improve the plan. If you see in the briefing or the plan that part of the implementation is done (referring to what we did just now), remove it - unless it was done in PRs and merged to develop.
2. Add sections at the top for the coding agent to validate assumptions that the plan makes before it even starts - where files are, what's present, what's not, etc.
3. Make sure work is staged in the order that makes the most sense.
4. Ask the agent to run a full test `bun test` and log it to a file at the end to verify.
5. Separate the critical parts of the plan with the optional flourishes, and ask the user at the beginning what should be done or not.
6. In drop_me_into_your_agent, give the agent a todo to stage changes nicely at the end, and provide a PR message that is medium length, covers the original tasks, the work so far, etc.
7. Remind the agent (with specific filename and all caps) to read the primary plan and addendums into context before doing anything.
8. Tell the agent to keep updating the plans as the user responds with thoughts and feedback.
9. Remind the agent that the implementations that were done were discarded, and primarily intended to make the plan better. It will likely have to start fresh from the tip of `develop`.
10. Mention at the end (and make it part of TODOs) for the agent to update Changelog.md.
