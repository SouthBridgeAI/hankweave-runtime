To get a diff quickly from a commit to now with just the ts files, use:
git diff a54b158c70d2cd57..HEAD -- "*.ts" > changes.diff

To get a full code export with docs (about 850k tokens), you can:
`bunx mandark -a -c --no-line-numbers server documentation README.md package.json biome.json tsconfig.json tests/config/**/*.json tests/e2e tests/integration tests/long-running tests/types tests/unit tests/utils`