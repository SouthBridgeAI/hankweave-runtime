#!/bin/bash
# E2E test for Strandweave standalone executable in Docker
#
# This script runs a real codon execution to verify the executable works
# end-to-end, including Claude SDK integration.
#
# Usage:
#   ./scripts/test-docker/test-e2e.sh
#
# Requires:
#   - ANTHROPIC_API_KEY environment variable set

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RELEASES_DIR="$PROJECT_ROOT/releases"

# Check for API key
if [ -z "$ANTHROPIC_API_KEY" ]; then
    echo "❌ ANTHROPIC_API_KEY environment variable is required"
    echo "   Set it with: export ANTHROPIC_API_KEY=your_key"
    exit 1
fi

# Determine architecture
if [[ "$(uname -m)" == "arm64" ]]; then
    BUILD_TARGET="linux-arm64"
    DOCKER_PLATFORM="linux/arm64"
    EXECUTABLE_NAME="strandweave-linux-arm64"
else
    BUILD_TARGET="linux-x64"
    DOCKER_PLATFORM="linux/amd64"
    EXECUTABLE_NAME="strandweave-linux-x64"
fi

echo "🧪 Strandweave Docker E2E Test"
echo "=============================="
echo ""
echo "🔧 Platform: $DOCKER_PLATFORM"
echo ""

# Step 1: Build the executable if not exists or force rebuild
EXECUTABLE_PATH="$RELEASES_DIR/$EXECUTABLE_NAME"
if [ ! -f "$EXECUTABLE_PATH" ] || [ "$1" == "--rebuild" ]; then
    echo "📦 Building executable for $BUILD_TARGET..."
    cd "$PROJECT_ROOT"
    bun scripts/build-executable.ts "$BUILD_TARGET" "$EXECUTABLE_NAME"
fi

echo "✅ Executable: $EXECUTABLE_PATH ($(du -h "$EXECUTABLE_PATH" | cut -f1))"
echo ""

# Step 2: Build Docker image if needed
echo "🐳 Building Docker image..."
docker build --platform "$DOCKER_PLATFORM" -t strandweave-test "$SCRIPT_DIR" 2>&1 | head -20
echo "✅ Docker image ready"
echo ""

# Step 3: Run E2E test in container
echo "🚀 Running E2E test in Docker container..."
echo "   This will execute a real codon using Claude SDK..."
echo ""

# Mount both the executable and the test script
docker run --rm \
    --platform "$DOCKER_PLATFORM" \
    -v "$EXECUTABLE_PATH:/app/strandweave:ro" \
    -v "$SCRIPT_DIR/run-e2e-test.sh:/app/run-e2e-test.sh:ro" \
    -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
    strandweave-test \
    bash /app/run-e2e-test.sh

echo ""
echo "✅ Docker E2E test finished!"
echo ""
echo "To run interactively:"
echo "  docker run -it --rm --platform $DOCKER_PLATFORM \\"
echo "    -v $EXECUTABLE_PATH:/app/strandweave:ro \\"
echo "    -e ANTHROPIC_API_KEY=\$ANTHROPIC_API_KEY \\"
echo "    strandweave-test \\"
echo "    bash"
