The results of step 1, 2 and 3 and 4 are in @intermediates/23-notion-hank-changes/plans. We have `final-standalone-` prefix plans that are the final rewritten plans. Read those into context - everything else should be linked through from there.

Now our job is to add some testing. Go through each individual final plan and add tests that would be useful. Read the ./tests directory to understand the structure and testing conventions, and use that in recommending tests. We don't want too many unit tests for the sake of testing. Ideally, we're catching regressions and testing behavior and brittle areas instead of specific code.

# GUIDELINES

1. e2e tests are expensive. If you can attach tests to an existing e2e run, that's almost always better.
2. You don't always have to add tests. Use your judgement on how complex functionality is.
3. Add test plans to each specific plan, instead of making new documents.
