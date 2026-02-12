We now need to write a detailed plan (and addendums) covering how we plan to do this task.

@<%EXECUTION_ENVIRONMENT>/plan/task.md has information on the task.

---

### Thinking Process

Before writing the plan, think through the following:

1. **What information are you making your decisions with access to?**
   Be explicit about what you can see (code, task spec, etc.) and what you cannot.

2. **What does this task imply in the broader context of the code?**
   The agent that created the specification for the task could not see the code. What is now clearer? How can the intent be clarified further?

3. What is the existing behavior in its complexity that's connected to the task? What does the system currently do? Think through it first.

4. **What conventions do you notice in the code that are relevant to this task?**
   Naming patterns, file organization, architectural patterns, error handling styles, etc.

5. **What files, modules, and areas are most affected?**
   Map out the blast radius of the changes.

6. **What are the key judgement calls that need to be made?**
   How will they impact the result - in output, in the code, in maintainability, in features, etc. Provide your recommendations as well.

7. **Where do you recommend drawing the line between over and under-engineering?**
   Use the code as a guide to inferring the answer. Match the existing level of abstraction.

Write your thinking first, then the plan.

---

## Phase 2: Addendum (Tests, Docs, Supplementary Materials)

After the main plan is written, review any supplementary materials (tests, documentation, etc.) and produce an addendum.

### Thinking Process

1. **What information do the supplementary materials provide that the original plan didn't have access to?**

2. **What existing tests are affected by the planned changes?**
   What test patterns and conventions are used?

3. **What new tests need to be written?**
   What edge cases should be covered?

4. **What documentation needs to be updated?**
   What new documentation is needed?

5. **What additional optional flourishes could be added to make the user experience or the code better?**

6. **Are there any conflicts or inconsistencies between the plan and what the tests/docs reveal about the system?**

7. **Are there any new implications, risks, or considerations that emerge from reviewing these materials?**

8. **Does the supplementary material reveal any assumptions in the plan that need to be revisited?**

The addendum should be standalone but intended to be read alongside the original plan and task.

---

## Final Plan Structure

Each final plan should have:

### a. The Main Task

Clear description of what needs to be done.

### b. Information Available

- What sources informed this plan
- What the planning agent could and could not see
- Any gaps in information that required assumptions

### c. Sources and Related Things

- The original tickets/tasks
- Related PRs, comments, discussions
- Code references (with file paths and line numbers)
- Research sources

### d. Conventions and Patterns

- Relevant code conventions observed
- Patterns to follow
- Patterns to avoid

### e. Decision Points and Judgement Calls

- Decisions that were made and why
- The line between over and under engineering
- Trade-offs considered
- Impact on output, code quality, maintainability, features

### f. The Actual Implementation Plan

- Step-by-step how to implement this
- Files to create/modify (with specific paths)
- Code patterns to follow
- Order of operations

### g. Testing Considerations

- Existing tests affected
- New tests needed
- Edge cases to cover
- Test patterns to follow

### h. Documentation Considerations

- Docs to update
- New docs needed

### i. Additional Resources

- Links to research
- Related documentation
- Cross-references to other tasks

---

## Notes

- The plan should be standalone, readable with just the task document
- Reference specific files and line numbers where possible
- Be explicit about what information informed each decision
- If updating a previous plan, note what changed and why

# PROCESS

1. Take the task, write down your thoughts and questions in @<%EXECUTION_ENVIRONMENT>/plan/rough-workspace/opus/log.md - things like questions, aha moments, tasks to do, areas that you haven't looked in, etc.

2. Read through the code first - in source/hankweave/server. Take your time and understand it.
3. Update the plan and the log as you go.
4. Read through the tests in source/hankweave/tests.
5. Update the plan and the log.
