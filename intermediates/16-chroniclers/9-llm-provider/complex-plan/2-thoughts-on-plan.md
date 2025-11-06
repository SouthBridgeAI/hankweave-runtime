We're building a new feature (@/intermediates/16-parallel-events/3-triggers/7-comprehensive-summary.md , @/intermediates/16-chroniclers/5-conversational/4-implementation-review.md, @/intermediates/16-chroniclers/6-templates/implementation-overview.md , @/intermediates/16-chroniclers/8-llm-call-mocks/8-implementation-summary.md  ) into our project (@/README.md , @/documentation ).

The next thing we want to build is a proper llm provider that does the following things:
1. Load up vercel AI sdk providers (see @/external-docs/ai-sdk for documentation) based on available API keys, hold on to those, and performs a health check to make sure they're accessible.
2. Loads in models.dev (@/external-docs/models-dev.md ) cost and model name information, to maintain a registry.
3. Maintains some internal state of costs, calls, etc with support for logging every single call and response.
4. Provides a function to validating whether an AI provider can be called.
5. Exposes generateText, streamText and generateText functions that take in the usual params (see @/server/types/input-ai-types.ts and @/server/types/llm-call-types.ts ) and a list of models it can fall back through, performs the actual external provider call, and returns or streams the response.
6. It keeps track of errors (repeated ones can mean disabling a model or provider depending on the type of error), and costs.
7. Logs everything. In the future it can also pass this information back through the websocket to tadpoleserver.

The chroniclers are the only things that will use it (for now). ChroniclerManager is booted up AFTER the llmprovider is up (and it can also hold up the tadpoleserver start so that chroniclers are not out of sync), and uses the information from the llm provider to know which chroniclers to start.

There is a broad plan in @/intermediates/16-chroniclers/9-llm-provider/1-plan.md .

First let's think through - whast do you think? Where does the plan fall short? Where do you disagree with me or the plan?