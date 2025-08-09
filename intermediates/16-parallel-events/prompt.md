This is a system we're working on. I've provided you with the full code, documentation, some example logs, phases, etc.

We want to implement a new feature - the ability to run LLM calls in parallel to extract information from the core agent's actions.

As tadpole works, we have phases, and within these phases a single core agent loop runs, discovering things, thinking, running tools, seeing results, etc.

Let's first think this through. Here are some things we want:
1. Generate extracted information from the agentic loop - like finding specific files, keeping track of what has been accessed, etc.
2. Evaluating the quality of the agentic loop itself, whether it's taking the wrong turns, etc.
3. Providing a more human-readable result on what's actually happening.
4. Filtering the agentic stream of activity to hide or remove information or reformat it for different audiences.

So we need to build something that allows us to express as text and config (like we do in phases.json) these patterns, which can be:
1. Which things to filter from the agentic loop. Decides when this is triggered.
2. Perhaps files to include
3. A prompt and system prompt (files like the work we did before in phases) to use.
4. A particular model and provider to use (we can implement this properly later, but the AI sdk which we'll use to implement this is also provided).
5. Whether we want the past chat history to be used when getting new responses.
6. Which file(s) to write the results to. Perhaps we can write to a single jsonl, and read it in later.
7. Streaming and how that will be implemented.
8. Perhaps a JSONSchema for the type of data to force the model to output, or it can just be text.

What's a good name for these things? Watchers? Reporters?

What do you see from the code? What other things should be implement or be concerned about? What are the best patterns to use here? Perhaps we can think of event sourcing as a pattern?
