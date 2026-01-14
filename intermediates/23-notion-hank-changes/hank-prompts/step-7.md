The results of step 1, 2 and 3, 4, 5 and 6 are in @intermediates/23-notion-hank-changes/plans. We have `final-standalone-` prefix plans that are the final rewritten plans, as well as an index.md. Read those into context - everything else should be linked through from there.

We are now in step 7. The aim here is to write a clean `drop_me_into_your_agent.md` file right next to the final plans. We want this file to contain:

1. Good instructions for the agent that will receive this file for interactive coding. Things like conventions, filenames, where things are, the plans, their structure, etc etc.
2. Enough background and intent.
3. A clear process to follow that front-loads the questions that it needs to ask the user, trying to maximize the user-interaction time it gets to make sure all the key decisions are made well and covered. When the agent asks the user questions, make sure to explain things properly and in detail.
4. Give the agent a full exhaustive list of decision points, then ask the agent to (before it starts writing any code) walk the user through each decision - much like a doctor would - to explain the reasoning, the decision, and check if that's correct. As the human responds, ask the agent to update the plan files (so they stay persistent) with the human feedback and thoughts.
5. Especially for large research tasks or figuring things out tasks (as opposed to 'do this' tasks), make sure the agent engages the user in a discussion, updates the plans real-time, before starting.
6. Remind the agent to make sure to set TODOs appropriately and granuarly, to load each plan at the appropriate time, and make sure to test and pass things for each segment.
7. Also ask the agent not to make unnecessary markdown files, but to put down a `implementation_progress_notes.md` file to maintain as we go along noting problems, bugs, judgement calls, etc during the process.
8. Do rearrange tasks based on what you're seeing - you are the last agent to see the most complete version of the plans - and inform the agent about possible cross-implications between tasks, testing boundaries - when to test what - , etc.

Take your time and write this file properly and well, and feel free to read more of the code, or the plans, or do searches to improve the user experience once this file is used by a coding agent.
