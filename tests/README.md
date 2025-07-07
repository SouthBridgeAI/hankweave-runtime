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
│   ├── happy-path-e2e.test.ts          # Full workflow test
│   ├── skip-phase-continue-e2e.test.ts # Skip phase and continue test
│   └── skip-phase-quit-e2e.test.ts     # Skip last phase and quit test
├── utils/           # Test utilities
│   ├── check-test-ready.ts
│   ├── cleanup-test.sh
│   └── sanity-check.ts
├── test-area/       # Working directory for tests (gitignored)
└── test-results/    # Test results archive (gitignored)
```

### What the tests do

#### Happy Path Test (`e2e/happy-path-e2e.ts`)
Runs a complete server workflow:

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

#### Skip Phase Tests
Two additional tests verify phase skipping functionality:

1. **Skip and Continue** (`e2e/skip-phase-continue-e2e.ts`):
   - Starts phase 1, skips it mid-execution
   - Verifies server continues to phase 2
   - Completes phase 2 normally
   - Skips phase 3
   - Verifies proper cleanup and state management

2. **Skip and Quit** (`e2e/skip-phase-quit-e2e.ts`):
   - Runs phase 1 to completion
   - Starts phase 2 (last phase), skips it
   - Verifies server shuts down gracefully
   - Checks that resources are cleaned up properly

### Test Scripts

- `bun run test` - Run all E2E tests (happy path + skip tests)
- `bun run test:all` - Same as above
- `bun run test:happy` - Run only the happy path test
- `bun run test:skip` - Run both skip tests
- `bun run test:skip-continue` - Run skip and continue test only
- `bun run test:skip-quit` - Run skip and quit test only
- `bun run test:check` - Check if environment is ready for testing
- `bun run test:sanity` - Detailed environment and configuration check
- `bun run test:cleanup` - Manually clean up test server and test area
- `bun run pre-test` - Run pre-test checks and cleanup

#### Examples
```bash
# Run all tests
bun run test

# Run only skip tests
bun run test:skip

# Run a specific test
bun run test:happy
```

### Important Notes

1. **Working Directory**: Tests MUST be run from the project root (where package.json is)
2. **Test Area**: All test artifacts are created in `tests/test-area/`
3. **Test Results**: Test logs and artifacts are saved in `tests/test-results/` with timestamps
4. **Auto-cleanup**: The server is gracefully shut down after tests complete
5. **Cost**: Running the full test suite will use Claude API credits (multiple phases with Sonnet)
6. **Ports**: Different tests use different ports to avoid conflicts:
   - Happy path test: 7777
   - Skip and continue test: 7778
   - Skip and quit test: 7779

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