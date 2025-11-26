Let's refine design ideas from `intermediates/18-looping-phases/context-exceeded`:

1. Should "continue-previous" be invalid when defining phases where previous loop "terminatesOn" with context exceeded? It's clear that we cannot use previous session in these cases, we need to start from scratch.

2. On the state manager level, can we express "context exceeded" using transition:

```
// inside tadpole-server.ts where context exceeded is handled
this.stateManager.transition({
    type: "ContextExceeded", 
    data: {
        runId: this.currentRunId,
        phaseId: PhaseId(phaseId),
        // ...
    },
});
```

3. As far as claude process manager is concerned, maybe we do not need to introduce a new method for "fresh session", we just call spawn again without
session id using ClaudeProcess manager `async spawn(phase: Phase, previousSessionId: string | null, logPath?: string)`. Will this fit nicely with state manager transition?

=======================================================================================================

is loop context used in?

{
      type: "PhaseStarted";
      data: {
        runId: RunId;
        phaseId: PhaseId;
        loopContext?: {
          loopId: PhaseId;
          iteration: number;
          phaseIndexInLoop: number;
        };
      };
    }
=======================================================================================================

4. Let's plan architecture for this feature from ground up:

- what needs to happen inside state manager + its manipulation of execution plan
- how do we trigger state manager change (likely via transition event)
- what do we need to do inside tadpole server and how does this interact with claude process manager etc