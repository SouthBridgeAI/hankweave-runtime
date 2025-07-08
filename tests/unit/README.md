# Unit Tests

This directory contains unit tests for the Langton server components. These tests focus on testing individual modules and functions in isolation without requiring the full Claude process or server infrastructure.

## Running Unit Tests

```bash
# Run all unit tests
bun test tests/unit

# Run a specific test file
bun test tests/unit/config.test.ts

# Run tests with watch mode
bun test --watch tests/unit
```

## Test Coverage

The unit tests cover the following modules:

### Core Modules
- **config.test.ts** - Tests for configuration loading and cost calculation
- **utils.test.ts** - Tests for utility functions (escapeShellArg, buildFileTree)
- **type-guards.test.ts** - Tests for runtime type validation guards
- **error-types.test.ts** - Tests for custom error classes and severity levels

### Infrastructure
- **checkpoint-git.test.ts** - Tests for the git-based checkpoint system
- **claude-process-manager.test.ts** - Tests for Claude process lifecycle management
- **logger.test.ts** - Tests for logging functionality and utility functions

### Business Logic
- **business-logic.test.ts** - Tests for phase sequencing and session management
- **path-validation.test.ts** - Tests for security-related path validation

## Test Structure

Each test file follows a consistent structure:
- Uses Bun's built-in test runner
- Groups related tests using `describe` blocks
- Isolates test environments using temporary directories
- Cleans up resources in `afterEach` hooks

## Writing New Tests

When adding new unit tests:
1. Focus on testing pure functions and isolated components
2. Mock external dependencies (file system, network, etc.)
3. Test edge cases and error conditions
4. Keep tests fast and deterministic
5. Use descriptive test names that explain what is being tested

## Separation from E2E Tests

Unit tests are kept separate from E2E tests:
- Unit tests: Fast, isolated, no Claude process required
- E2E tests: Full integration tests with real server and Claude processes

To run both test suites:
```bash
bun test  # Runs both unit and E2E tests
```