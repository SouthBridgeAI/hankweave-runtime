We're building a new feature called chroniclers (@/intermediates/16-parallel-events/3-triggers/7-comprehensive-summary.md , @/intermediates/16-chroniclers/5-conversational/4-implementation-review.md, @/intermediates/16-chroniclers/6-templates/implementation-overview.md , @/intermediates/16-chroniclers/8-llm-call-mocks/8-implementation-summary.md  ) into our project (@/README.md , @/documentation ).

Now we want chroniclers to be able to call actual AI models. We also want to be able to know the costs, and also make sure that providers are enabled and routed appropriately based on health checks and whether they're available.

We have a simple plan (sort of simple) to build this functionality in @/intermediates/16-chroniclers/9-llm-provider/simple-plan/simple-plan.md .

What we now need to do is split this plan into parts, and have separate plans for each.
The first will likely be to implement the script to download models from models.dev (mention that the documentation is in /Users/hrishioa/Dropbox/Projects/Southbridge/tadpole/external-docs/models-dev.md ( but you might not need to read it). We need to build script to download the models and place the json somewhere in version control, then read parts of the json to build a proper annotated schema of the data, then add back into the script the functionality to make sure on each new download we validate against that schema before replacing the data file.

the next plan is likely for building the llm provider manager, which can load in the data file (through the schema and inferred types), have an import that has the actual providers from the ai sdk (let's do google, anthropic and groq), specify which API keys to look for, and implement the health check for each provider using the cheapest model. We should also have a disallow list and include list so we can programmatically disable models from the list from models.dev or add models that might not be in the list.

Next plan is, Once the health check is up we should write e2e tests for testing health (that need the api keys but we'll set those in the environment). These tests can test that the getProviderForModel is properly blocking, if we've implemented autocomplete we can test that too - to make a call using the provider once it's up, and make sure it works as intended.

Next plan can be to integrate the functionality into chroniclers, where they can get the provider they need and make the llm call they need to. The chroniclerManager can also check if the provider a chronicler needs exists and not load chroniclers that aren't allowed.

Throughout all plans we should add instructions to use `bun lint:fix` and `bun typecheck` to check the results, and to methodically fix issues without randomly widening types or adding underscores.

For each one we should also suggest the tests to add, and mention areas of integration. Let's skip the part where we mention how long something would take - this is for an AI agent to complete, so the intent is to provide enough context, specifics, footguns, problems expected, so it can make decisions as it executes the plan.

Can you go ahead and look at the simple plan, and split it out and write each plan properly? Feel free to make changes or additions, or ask me for things.