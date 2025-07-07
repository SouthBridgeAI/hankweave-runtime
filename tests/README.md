# Langton Server Tests

## Running Tests

### Quick Start
```bash
# From the project root directory
bun run test
```

## Test Structure

```
tests/
├── config/           # Test configuration files
│   └── test-phases.config.json
├── e2e/             # End-to-end tests
│   └── happy-path-e2e.ts
├── utils/           # Test utilities
│   ├── check-test-ready.ts
│   ├── cleanup-test.sh
│   └── sanity-check.ts
├── test-area/       # Working directory for tests (gitignored)
└── test-results/    # Test results archive (gitignored)
```

### What the test does
The end-to-end test (`e2e/happy-path-e2e.ts`) runs a complete server workflow:

1. **Pre-test cleanup**: Removes any previous test artifacts
2. **Starts the server**: With the test configuration in `test-phases.config.json`
3. **Runs 3 phases**:
   - Phase 1: Creates poems and saves favorite to `notes/favorite_poem.txt`
   - Phase 2: Continues from Phase 1, saves second favorite poem
   - Phase 3: Converts poems to TypeScript code
4. **Verifies**:
   - All expected files are created
   - WebSocket events are properly sequenced
   - Cost tracking matches log files
   - Token usage is accurate
   - Session continuity works
   - File watching events fire correctly

### Test Scripts

- `bun run test` - Run the full E2E test suite
- `bun run test:check` - Check if environment is ready for testing
- `bun run test:sanity` - Detailed environment and configuration check
- `bun run test:e2e` - Run E2E test directly (includes pre-test)
- `bun run test:cleanup` - Manually clean up test server and optionally test area
- `bun run pre-test` - Just run the pre-test cleanup

### Important Notes

1. **Working Directory**: Tests MUST be run from the project root (where package.json is)
2. **Test Area**: All test artifacts are created in `tests/test-area/`
3. **Auto-cleanup**: The server is gracefully shut down after tests complete
4. **Cost**: Running the full test will use Claude API credits (3 phases with Sonnet)
5. **Artifacts**: Test outputs are preserved in `tests/test-area/` for inspection

### Test Configuration

The test uses `config/test-phases.config.json` which defines:
- 3 phases using Claude Sonnet
- Specific file outputs for consistent testing
- File watching patterns
- Pre-start commands for setup

### Troubleshooting

If tests fail:
1. Check that you're in the correct directory (project root)
2. Ensure no other server instance is running on port 7777
3. Check `tests/test-area/.logs/` for Claude session logs
4. Look at server logs in `tests/test-area/server.log`
5. Run `bun run test:cleanup` to clean up any stuck processes