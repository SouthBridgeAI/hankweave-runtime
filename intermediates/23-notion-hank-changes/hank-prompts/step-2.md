The results of step 1 are in @intermediates/23-notion-hank-changes/plans.

Can we iteratively read each plan, then read the codebase (use the README and @server/hankweave-runtime.ts as a starting point) to find all the relevant parts, think through the changes in code (maintain a `-related-code.md` file and a `-changes-decisions-and-judgement-calls.md`) file for each task, and do this for all of them exhaustively?

Take your time. We've already done step 1, we're doing step 2, so no need to skip ahead to step 3 - that's somebody else :)

Also in the plan, the previous step's agents have annotated their thoughts. Feel free to disagree and change, and move them to the end if you disagree (with a note on why).

# Guidelines for Step 2

1. Read code with intent. Look properly, be curious, and look for implications.
2. Note down patterns you're seeing that should be followed, or conventions to maintain - or conventions to change. In either case, be aware of code patterns and structure.
3. It's good to ask why, and look deeper if you don't understand something.
4. As you add information to the plan, make sure to quote appropriately, and also mark your thoughts, judgement calls and decisions as "Step 2 agent".
5. After you're done with each plan, add three to six sentences at the top as "From Step 2 Agent" covering the most important thing, question you have, or just TLDR notes for the next agent in Step 3.
