Review process:
1. Start in `chronicler-manager.ts`
2. Continue to `chronicler.ts`
3. Then `trigger-engine.ts`
4. `prompt-templating-engine.ts`

It's really fun to do a manual review much much later, so late (two months in this case) that you've forgotten the code itself.
1. Everything's more fun, actually clever bits of code really strike you anew.
2. You tend to prefer readability and understanding over complexity. You've long since forgotten what future plans something could be used for (or looking specifically at a tiny diff or piece of AI suggestion), and now you want things to read better.

## Manual review of chronicler work so far:

1. https://github.com/SouthBridgeAI/tadpole/blob/99ce4784ff97b65c918eddd3b79e34efcd12f66b/server/chroniclers/chronicler-manager.ts#L60-L61 - currently this blocks on ALL health checks (I presume) before it actually updates the statuses

2. https://github.com/SouthBridgeAI/tadpole/blob/99ce4784ff97b65c918eddd3b79e34efcd12f66b/server/chroniclers/chronicler-manager.ts#L98-L108 - this shouldn't run the fs operation every single time, ideally there's a flag (static or not) that once it's good it's good

3. https://github.com/SouthBridgeAI/tadpole/blob/99ce4784ff97b65c918eddd3b79e34efcd12f66b/server/chroniclers/chronicler-manager.ts#L157-L160 - should chroniclers be able to define their own error thresholds?


5. https://github.com/SouthBridgeAI/tadpole/blob/99ce4784ff97b65c918eddd3b79e34efcd12f66b/server/chroniclers/chronicler-manager.ts#L195-L215 - how does this work? If the provider registry has the model, then why check to get modelinfo and fail there? What does that do? If it means none of the models matched, shouldn't that be something else? Honestly the whole section could use a little more streamlining with all the checks.

6. https://github.com/SouthBridgeAI/tadpole/blob/99ce4784ff97b65c918eddd3b79e34efcd12f66b/server/chroniclers/chronicler-manager.ts#L243-L254 - if the llm call ids (in the parameters of the function and here) are chronicler Id, let's make that clearer in the variable name.

7. https://github.com/SouthBridgeAI/tadpole/blob/99ce4784ff97b65c918eddd3b79e34efcd12f66b/server/chroniclers/chronicler-manager.ts#L274-L286 - is this the only way to do this? If so it's okay, is there not a more elegant way?

8. https://github.com/SouthBridgeAI/tadpole/blob/99ce4784ff97b65c918eddd3b79e34efcd12f66b/server/chroniclers/chronicler-manager.ts#L299-L309 - is `llmCall` instead of `concreteLlmCall` here supposed to be a mock, or can it also be a real LLM call? I forget what the intent of this thing was. If it's only ever supposed to be a mock (for testing), we should change the name of the variable to be more indicative. Otherwise can you tell me what else it's meant for?

9. https://github.com/SouthBridgeAI/tadpole/blob/99ce4784ff97b65c918eddd3b79e34efcd12f66b/server/chroniclers/chronicler-manager.ts#L313-L317 - minor but these things could be more streamlined in naming. Say consecutiveFailures could be chroniclerFailureCounts - easier to read and look through, no?

10. https://github.com/SouthBridgeAI/tadpole/blob/99ce4784ff97b65c918eddd3b79e34efcd12f66b/server/chroniclers/chronicler-manager.ts#L324-L337 - here shouldn't we keep a reference to check if we actually created a chronicler? In which case we should properly destroy it.


11. Chronicler.ts class also needs far better docstrings, and also a removal of comments that were just from changes being made to the file and no longer make sense as a terminal state thing (like this - https://github.com/SouthBridgeAI/tadpole/blob/99ce4784ff97b65c918eddd3b79e34efcd12f66b/server/chroniclers/chronicler.ts#L60-L61)

12. https://github.com/SouthBridgeAI/tadpole/blob/99ce4784ff97b65c918eddd3b79e34efcd12f66b/server/chroniclers/chronicler.ts#L120-L126 - how much of a problem is this that we're skipping events when there's an active flush? Also can you look through the intermediates folder to find out why we're doing this - what's the problem triggering when there's an active flush?

13. https://github.com/SouthBridgeAI/tadpole/blob/99ce4784ff97b65c918eddd3b79e34efcd12f66b/server/chroniclers/chronicler.ts#L273-L332 - can we double check that this is doing what it's supposed to do? From a quick check it looks like it restarts the timer every time there's a new trigger? Also in a busy application, what's the expected variance on triggers and timewindows here? Don't make any fixes, we just want to know. Even a few milliseconds up to a few centiseconds of variance is fine.

14. https://github.com/SouthBridgeAI/tadpole/blob/99ce4784ff97b65c918eddd3b79e34efcd12f66b/server/chroniclers/chronicler.ts#L453-L464 - how much of a problem is it if the context object is massive? You mayb have to look at the docs for eta js or run searches to figure this one out. What might happen often is that chroniclers don't use much of this object, but the object itself has a good number of events.

15. https://github.com/SouthBridgeAI/tadpole/blob/99ce4784ff97b65c918eddd3b79e34efcd12f66b/server/chroniclers/chronicler.ts#L503-L504 - nitpick but for proper readability we should be checking the config if this is conversational AND whether there's a history manager. Fewer implicit assumptions in the code.

16. https://github.com/SouthBridgeAI/tadpole/blob/99ce4784ff97b65c918eddd3b79e34efcd12f66b/server/chroniclers/chronicler.ts#L541 - what on earth is happening here? Why are we doing this? (I see this as a plan which seems kinda better no? https://github.com/SouthBridgeAI/tadpole/blob/99ce4784ff97b65c918eddd3b79e34efcd12f66b/intermediates/16-chroniclers/8-llm-call-mocks/7-llm-params-implementation-plan.md#L164-L168)

17. https://github.com/SouthBridgeAI/tadpole/blob/99ce4784ff97b65c918eddd3b79e34efcd12f66b/server/chroniclers/chronicler.ts#L556-L567 - this kind of thing makes it harder to read and track which exceptions can happen where. Can we move this try catch block to be actually around the thing we're catching the error for instead of across the entire block while it means to only catch template rendering errors?

18. `history-manager.ts`, `chronicler.ts` and `chronicler-manager.ts` all do async initialization in different ways (also the other classes involved in chroniclers). Is this because they're using the appropriate ones for their use-cases (i.e. can the difference in styles be defended)? If not what pattern can we standardize around?

19. https://github.com/SouthBridgeAI/tadpole/blob/99ce4784ff97b65c918eddd3b79e34efcd12f66b/server/chroniclers/history-manager.ts#L91 - we never actually use `forceSkipPruning`

20. https://github.com/SouthBridgeAI/tadpole/blob/99ce4784ff97b65c918eddd3b79e34efcd12f66b/server/chroniclers/history-manager.ts#L106-L109 - this could actually use the id of the chronicler or something, otherwise it's hard to tell where this is coming from.

21. https://github.com/SouthBridgeAI/tadpole/blob/99ce4784ff97b65c918eddd3b79e34efcd12f66b/server/chroniclers/history-manager.ts#L142-L143 - don't we actually get tokens back from the ai sdk? If we have them we should just hold on to them and use them for token-baed trimming.

22. https://github.com/SouthBridgeAI/tadpole/blob/99ce4784ff97b65c918eddd3b79e34efcd12f66b/server/chroniclers/history-manager.ts#L177-L184 - isn't this problematic if some mesage fails parsing? We'll have user messages next to each other or assistant messages. How do we fix this? First off we should throw proper errors if any individual message fails so we can investigate.

23. https://github.com/SouthBridgeAI/tadpole/blob/99ce4784ff97b65c918eddd3b79e34efcd12f66b/server/chroniclers/trigger-engine.ts#L30-L31 - is it fine that event trigger ids collide if the trigger is the same? What are we using the ids for? Not everything has to be a UUID but easy collisions should at least be marked out for future users of an id who might presume something is reasonably unique.

24. https://github.com/SouthBridgeAI/tadpole/blob/99ce4784ff97b65c918eddd3b79e34efcd12f66b/server/chroniclers/trigger-engine.ts#L41-L52 - this might be EXTREMELY verbose logging, maybe we should consider turning off for now?

25. https://github.com/SouthBridgeAI/tadpole/blob/99ce4784ff97b65c918eddd3b79e34efcd12f66b/server/chroniclers/condition-evaluator.ts#L10-L21 - couldn't this be better typed instead of unknown since the things we're comparing against are better known? Or would that make it hard to match against the packet type?

26. Everything needs better docstrings - chronicler-manager.ts, chronicler.ts, history-manager.ts. We can remove the comments that were part of making a particular change (like //remove this line or //removed for clarity), instead keeping comments that are helpful for the current state of the code, explaining things, etc. https://github.com/SouthBridgeAI/tadpole/blob/99ce4784ff97b65c918eddd3b79e34efcd12f66b/server/chroniclers/history-manager.ts#L167 - let's remove the `intent: ` things like this and instead do proper docstrings. We don't have to overly explain what's obvious, just the less obvious like consumers, intent (but without saying `intent:`)


Nice things

1. https://github.com/SouthBridgeAI/tadpole/blob/99ce4784ff97b65c918eddd3b79e34efcd12f66b/server/chroniclers/chronicler-manager.ts#L128-L146 - honestly reading critically after a long time, this is not too badly written

2. https://github.com/SouthBridgeAI/tadpole/blob/99ce4784ff97b65c918eddd3b79e34efcd12f66b/server/chroniclers/chronicler.ts#L166-L167 - if this could happen often, is this the most efficient way to do this? We don't want to overengineer, but is there a pareto optimum here between the naive approach and the overengineered one?

Plans and thoughts for remaining work

ordering for chronicler triggers/events and processing

1. Chroniclers (let's wait for review) maintain a queue of triggers with the full templates llm calls ready (since the underlying state might change), but wait to send the next one until after the current one is done.

structured out

1. For structured out, the config can include a zod schema, which gets validated, loaded in, and passed to the llm call. We also need to remember to find and handle structured out related errors coming back.
2. Do we need to worry about models being able to handle structued out? Yes we should, and filter by those models.
3. https://github.com/SouthBridgeAI/tadpole/blob/99ce4784ff97b65c918eddd3b79e34efcd12f66b/server/chroniclers/chronicler.ts#L521-L525 - this is where the call actually happens :)
4. https://github.com/SouthBridgeAI/tadpole/blob/99ce4784ff97b65c918eddd3b79e34efcd12f66b/server/chroniclers/chronicler.ts#L522-L523 - history manager will need to be updated when we have structured out, to accept objects and store those. We can also stringify them but worth discussion whether to
   1. https://github.com/SouthBridgeAI/tadpole/blob/99ce4784ff97b65c918eddd3b79e34efcd12f66b/server/chroniclers/history-manager.ts#L21 - okay yeah not sure if we need to keep things as strings, or these actually support objects. I can see toolcall parts but I'm not sure if that is canonically the same as the model responding with an object.

output files

1 . For output files, these are in configs, get validated as possible to write to (and the file is created) when the chronicler is loaded. We have to think about files PER PHASE versus writing to old files. We have to make sure we're appending.
1. We can also allow a separate file in the config where the last output of a chronicler can be stored. this file (or object) gets replaced.
2. If structured out is enabled, this can only be ndjson or json (stream vs current).

replay

1. Shouldn't be too complicated to take an ndjson events stream, and then play it through to a chronicler and see what happens. We need to figure out what will break if we did that.

integration

1. we should check on integrating with the new emit system (should be easier I think)



Quick things:
1. Look at how AI sdk supports caching and turn it on for conversational chroniclers.
2. Add a description parameter to chroniclers - name should make it clear that the code really doesn't use this
3. Everything needs better docstrings - chronicler-manager.ts, chronicler.ts, history-manager.ts. We can remove the comments that were part of making a particular change (like //remove this line or //removed for clarity), instead keeping comments that are helpful for the current state of the code, explaining things, etc. https://github.com/SouthBridgeAI/tadpole/blob/99ce4784ff97b65c918eddd3b79e34efcd12f66b/server/chroniclers/history-manager.ts#L167 - let's remove the `intent: ` things like this and instead do proper docstrings. We don't have to overly explain what's obvious, just the less obvious like consumers, intent (but without saying `intent:`)

Big refactors we might not need now:

1. SequenceTrigger works, tests well, but the logic needs a much stronger look over.
   1. Especially non consencutive triggers. Is it that we trigger on the closest subset of events? That might work - but it should be documented and the complexity covered.
   2. It might be cleaner to have a state machine for the sequence trigger (for a->b->c, listen for a, change state and listen for a or b, change state and listen for b or c, etc), and use the event trigger to actually match events to keep DRY?
   3. Also we might not need to hold on to all events. Might be a 'see a, start listening, see another a reset the thing', kind of thing.
   4. Damn this is tough - what if it's a->b->c->d, and you see ahbhck but then you see an a? Do you reset? Do you hold on to your sequence and that's the sequence? What if you keep recording forever? Isn't this a memory issue?
   5. Why don't we either disable sequence triggers or we don't do non-consecutive? we can use wildcards (modified) to match some fixed number
   6. OHHHHHH we're just reinventing regexes here GODDAMIT
   7. Let's come back to this later