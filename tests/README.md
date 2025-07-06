# Langton Server Tests

## Running Tests

### Quick Start
```bash
# From the project root directory
bun run test
```

### What the test does
The end-to-end test (`happy-path.test.ts`) runs a complete server workflow:

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
- `bun run pre-test` - Just run the pre-test cleanup
- `bun run test:e2e` - Run E2E test directly (includes pre-test)

### Important Notes

1. **Working Directory**: Tests MUST be run from the project root (where package.json is)
2. **Test Area**: All test artifacts are created in `tests/test-area/`
3. **No Auto-cleanup**: After tests complete, artifacts are preserved for inspection
4. **Server Remains Running**: To save API costs, the server isn't killed after tests
5. **Cost**: Running the full test will use Claude API credits (3 phases with Sonnet)

### Test Configuration

The test uses `tests/test-phases.config.json` which defines:
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

### Manual Cleanup

To manually clean test artifacts:
```bash
rm -rf tests/test-area/.logs tests/test-area/.langton-server.lock tests/test-area/notes tests/test-area/typescript_code
```