We've spent a lot of time (and a lot of iterative loops) improving the plan, but we should discover the issues that can only be found by attempting the implementation.

The primary task now is to implement the core functionality.

# PROCESS

1. Read the full plan (from @<%EXECUTION_DIR%>/plan/merged/plan.md ) and its addendums into context so you fully understand what needs to be done.
2. Review the source/hankweave directory - look at the git history and diff to understand any past work that's already happened.
3. @<%EXECUTION_DIR%>/plan/implementations/current is your working directory. There's likely a test output file in there (from bun test) that should give you an idea of how implementation can proceed (along with the context from the diff). Read this file in pieces - it might be quite long. Do not ignore e2e tests timing out. Fix them up, test them thorougly.
4. Methodically implement the plan into hankweave, testing appropriately, and checking your results with `bun lint:fix` and `bun typecheck`.
5. Maintain an `<%EXECUTION_DIR%>/plan/implementations/current/implementation_issues.md` file covering the problems encountered during implementation. These will later be used to update the plan so that it remains more robust. Feel free to add thoughts and additional details for the future agent that will update the plan.

# GUIDELINES

* Ignore claude.md in the directory - that is for a different development pattern than the one you're following.
* Start with core functionality, and move on to updating the tests.
* Work on being exhaustive about the changes, and making thoroughly sure all the parts of the plan are implemented.