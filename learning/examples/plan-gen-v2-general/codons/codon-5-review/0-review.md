We have now generated a number of plans (placed in <%EXECUTION_DIR%>/plan/rough-workspace) from different agents, then reviewed them and merged the plan into a single one.

# PRIMARY TASK

The goal is to review the plan with fresh eyes and surface what isn't clear, new decision points, etc etc.

# PROCESS

1. The new plan is in @<%EXECUTION_DIR%>/plan/merged/plan.md. Start here - with fresh eyes - and go where that plan refers to fully understand it. Read all the links and associated things into context - but nothing else.
2. Place immediate questions and thoughts into @<%EXECUTION_DIR%>/plan/reviews/current/review.md. Don't make questions for the sake of making questions - think from the perspective of the agent updating the plan based on your feedback - what would be good to know?
3. Read the code as needed in `<%EXECUTION_DIR%>/source/hankweave/server`. Look through the code with the plan in mind, and take notes in the review document covering what you notice that needs updating.
4. Do the same with the tests in `<%EXECUTION_DIR%>/source/hankweave/tests`.

# What to include in review

1. What doesn't make sense about the plan?
2. What questions does it raise?
3. Are there inherent contradictions?
4. Are there judgement calls being made that need to be more explicitly surfaced?
5. Are there additional implications that the plan doesn't consider?
6. Does the task need updating?
7. Does it follow the conventions of the codebase itself? Look at areas the plan recommends updating, and critically follow the thread and see if it fits with convention and good ideas. For example, does it try to typechecker by using optional fields when not necessary?
8. Critically inspect the control flow, data flow and event transmission and callbacks. Are we following the conventions of the codebase or doing completely new things for convenience?
