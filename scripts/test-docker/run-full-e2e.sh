#!/bin/bash
# Run full E2E test suites inside Docker
#
# This script builds a Docker image with the full source code and runs
# the E2E tests in a clean Linux environment.
#
# Usage:
#   ./run-full-e2e.sh                    # Run both test suites
#   ./run-full-e2e.sh --happy-path       # Run only happy-path tests
#   ./run-full-e2e.sh --rollback         # Run only rollback tests
#   ./run-full-e2e.sh --shell            # Drop into shell for debugging
#
# Requirements:
#   - Docker must be installed and running
#   - ANTHROPIC_API_KEY must be set in environment
#
# Platform Note:
#   On Apple Silicon (M1/M2/M3), this runs in x86_64 emulation mode
#   which is slower but tests the same Linux environment as production.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Parse arguments
TEST_MODE="both"
SHELL_MODE=false
PLATFORM="linux/amd64"

while [[ $# -gt 0 ]]; do
    case $1 in
        --happy-path)
            TEST_MODE="happy-path"
            shift
            ;;
        --rollback)
            TEST_MODE="rollback"
            shift
            ;;
        --shell)
            SHELL_MODE=true
            shift
            ;;
        --arm64)
            PLATFORM="linux/arm64"
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --happy-path    Run only happy-path E2E tests"
            echo "  --rollback      Run only rollback E2E tests"
            echo "  --shell         Drop into interactive shell instead of running tests"
            echo "  --arm64         Use ARM64 platform (default: amd64)"
            echo "  --help, -h      Show this help message"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            exit 1
            ;;
    esac
done

echo -e "${BLUE}╔═══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║       Strandweave Full E2E Tests in Docker                    ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check for API key
if [ -z "$ANTHROPIC_API_KEY" ]; then
    echo -e "${RED}❌ Error: ANTHROPIC_API_KEY environment variable is not set${NC}"
    echo ""
    echo "These tests require a valid Anthropic API key to run Claude."
    echo "Set it with: export ANTHROPIC_API_KEY=sk-ant-..."
    exit 1
fi

echo -e "${GREEN}✓ ANTHROPIC_API_KEY is set${NC}"

# Check Docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Error: Docker is not installed${NC}"
    exit 1
fi

if ! docker info &> /dev/null; then
    echo -e "${RED}❌ Error: Docker daemon is not running${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Docker is running${NC}"
echo ""

# Determine test command based on mode
case $TEST_MODE in
    "happy-path")
        TEST_CMD="bun test tests/e2e/happy-path-e2e.test.ts"
        echo -e "${BLUE}Test mode: Happy Path only${NC}"
        ;;
    "rollback")
        TEST_CMD="bun test tests/e2e/rollback-comprehensive-e2e.test.ts"
        echo -e "${BLUE}Test mode: Rollback Comprehensive only${NC}"
        ;;
    "both")
        TEST_CMD="bun test tests/e2e/happy-path-e2e.test.ts tests/e2e/rollback-comprehensive-e2e.test.ts"
        echo -e "${BLUE}Test mode: Both test suites${NC}"
        ;;
esac

echo -e "${BLUE}Platform: $PLATFORM${NC}"
echo ""

# Build Docker image
echo -e "${BLUE}Building Docker image...${NC}"
cd "$PROJECT_ROOT"

docker build \
    --platform "$PLATFORM" \
    -f scripts/test-docker/Dockerfile.e2e \
    -t strandweave-e2e:latest \
    .

echo -e "${GREEN}✓ Docker image built successfully${NC}"
echo ""

# Run tests
if [ "$SHELL_MODE" = true ]; then
    echo -e "${YELLOW}Dropping into interactive shell...${NC}"
    echo "Run tests manually with: bun test tests/e2e/<test-file>.test.ts"
    echo ""

    # Set CLAUDE_PATH_TO_CLAUDE_EXECUTABLE since we're running from source
    docker run -it --rm \
        --platform "$PLATFORM" \
        -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
        -e CLAUDE_CODE_USE_BEDROCK="${CLAUDE_CODE_USE_BEDROCK:-}" \
        -e ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-}" \
        -e CLAUDE_PATH_TO_CLAUDE_EXECUTABLE="/home/testuser/strandweave/node_modules/@anthropic-ai/claude-agent-sdk/cli.js" \
        strandweave-e2e:latest \
        /bin/bash
else
    echo -e "${BLUE}Running E2E tests...${NC}"
    echo -e "${YELLOW}Note: This will take several minutes as it runs real Claude conversations${NC}"
    echo ""

    # Run with timeout (30 minutes should be plenty)
    # Set CLAUDE_PATH_TO_CLAUDE_EXECUTABLE since we're running from source
    # (not a compiled executable with embedded cli.js)
    docker run --rm \
        --platform "$PLATFORM" \
        -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
        -e CLAUDE_CODE_USE_BEDROCK="${CLAUDE_CODE_USE_BEDROCK:-}" \
        -e ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-}" \
        -e CLAUDE_PATH_TO_CLAUDE_EXECUTABLE="/home/testuser/strandweave/node_modules/@anthropic-ai/claude-agent-sdk/cli.js" \
        strandweave-e2e:latest \
        sh -c "$TEST_CMD"

    EXIT_CODE=$?

    echo ""
    if [ $EXIT_CODE -eq 0 ]; then
        echo -e "${GREEN}╔═══════════════════════════════════════════════════════════════╗${NC}"
        echo -e "${GREEN}║                    ✅ All tests passed!                       ║${NC}"
        echo -e "${GREEN}╚═══════════════════════════════════════════════════════════════╝${NC}"
    else
        echo -e "${RED}╔═══════════════════════════════════════════════════════════════╗${NC}"
        echo -e "${RED}║                    ❌ Tests failed!                           ║${NC}"
        echo -e "${RED}╚═══════════════════════════════════════════════════════════════╝${NC}"
    fi

    exit $EXIT_CODE
fi


