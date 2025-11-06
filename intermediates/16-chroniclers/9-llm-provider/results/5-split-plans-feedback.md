So reviewing these, here's what I notice.

for plan 1,
1. we sghouldn't make a mock test file. We should just donwload once and use that.
2. Why is the schema file called .schema? It should just be an annotated zod schema, no?


for plan 2,
1. Let's actually pick the cheapest model programmatically from the models.dev list. Does double duty for validating the model list too a little bit.
2. The allowlist could just be an extended models list following the exact same schema as the models.dev one except this one we manuall add to.

For plan 3,
1. If a provider is skipped for testing, we want to maybe skip tests intentionally, so that theyshow up in the test log and remind us to incude the keys? Also we should be using the provider config from the previous plans to actually test all enabled providers and the specific keys there instead of hardcoding what we think the keys are and their env ids.
2. We should split tests so we health check each provider, and each thing, rather than going at least one.
3. We should also make it an e2e test instead of an integration test since it'll make real api calls.
4. We shouldn't hardcode providers into the tests - instead we can test provider 1 from the list, provider 2 from the list, etc.
5. Let's skip the github actions bits.

For plan 4,
1. If there is no provider registry we should just fail (unless we're testing with the mocks). We shouldn't randomly fall back to claude sonnet 3-5.
2. If there are no providers available for a chronicler, it should unload itself using a fatal error. Look at how this is currently done.
3. No fallbacks to mock calls if main one fails. We should either be in testing mode (with mocks) or in prod (where we don't use mocks).
4. For the time being, why can't chroniclermanager be the one loading llmproviderregistry? We can move it to tadpoleserver later if we want to, or as part of the integration.

for each plan, let's also add the global intent behind the feature, the things done so far (based on previous plans) and why something is being built. It helps make the micro decisions when implementing something.
For all plans let's also mention that the code is a suggestion rather than exact, and to make changes and add comments to explain things as needed.
for all plans let's also remove the instruction to go to next plan, so that we can do each one manually.
The plans will be implemented by an AI but a human will be asking the AI to do the plans and checking the results.

Let's review and update the plans. Don't make any changes other than to the four plans we're workng on?