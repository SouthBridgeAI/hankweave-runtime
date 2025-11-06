Notes on the changes so far:
1. Let's remove mistral from the list of providers for fetch-models.
2. Let's keep all model providers in the list - for fun! We want to make sure we still only support a few providers through the mapping though.
3. In the provider, should we use the supports temperature boolean flag to make sure we don't try and add temperature to calling a model from llmcallparams if it's not supported? Also we should trim the maxTokens to the max possible if it's lower.
4. Why do we need EnhancedModelInfo? What's the point?
5. Why do we have providerHealth AND providerStatus? Isn't one the subset of the other?
6. Should we import the models-custom-data.json and the additional files directly so if we package this together it'll be included? why make it a require? We shouldn't execute with a missing file so that's not a problem that's a feature.
7. We should make a custom models file just to remove the error, just make it an empty array.
8. Did we implement a blocklist that can specify provider or model ids, so they don't get loaded?
9. ProviderStatus should be a proper union type instead of a bunch of optional fields, with properly specced status.
10. When we do the health check, can we log the response from the model? Would be fun.
11. In getProviderForModel, we should return proper descriptive errors that the caller can use, not just null. same for isModelAvailable.
12. In calculateCost, can we make sure the result is a float by using . notation?
13. In getStats, we mention it - Why do we store each model twice?
14. chronicler-llm-e2e.test.ts: We shouldn't ignore cleanup errors - we should at least log to console. Also when starting a new test we should clean out the directory.
15. There are also chronicler test files in tests/config/chronicler-triggers. We can modify and use one of those instead of making our own when possible?