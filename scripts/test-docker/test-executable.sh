#!/bin/bash
# Test script for Strandweave standalone executable in Docker
#
# This script:
# 1. Builds the Docker image
# 2. Compiles the executable for Linux
# 3. Runs tests in the container
#
# Usage:
#   ./scripts/test-docker/test-executable.sh [--arm64]
#
# Options:
#   --arm64    Build for ARM64 Linux (default on Apple Silicon)
#              Without this flag, builds for x64 Linux

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DOCKER_DIR="$SCRIPT_DIR"
RELEASES_DIR="$PROJECT_ROOT/releases"

# Determine architecture
if [[ "$1" == "--arm64" ]] || [[ "$(uname -m)" == "arm64" && -z "$1" ]]; then
    BUILD_TARGET="linux-arm64"
    DOCKER_PLATFORM="linux/arm64"
    EXECUTABLE_NAME="strandweave-linux-arm64"
    echo "🔧 Building for ARM64 (native on Apple Silicon)"
else
    BUILD_TARGET="linux-x64"
    DOCKER_PLATFORM="linux/amd64"
    EXECUTABLE_NAME="strandweave-linux-x64"
    echo "🔧 Building for x64 (requires emulation on Apple Silicon)"
fi

echo "🐳 Strandweave Docker Test Suite"
echo "================================="
echo ""

# Step 1: Build the executable for Linux
echo "📦 Building executable for $BUILD_TARGET..."
cd "$PROJECT_ROOT"

# Check if build script exists
if [ ! -f "scripts/build-executable.ts" ]; then
    echo "❌ Build script not found: scripts/build-executable.ts"
    exit 1
fi

# Build for Linux
bun scripts/build-executable.ts "$BUILD_TARGET" "$EXECUTABLE_NAME"

EXECUTABLE_PATH="$RELEASES_DIR/$EXECUTABLE_NAME"
if [ ! -f "$EXECUTABLE_PATH" ]; then
    echo "❌ Build failed: $EXECUTABLE_PATH not found"
    exit 1
fi

echo "✅ Build complete: $EXECUTABLE_PATH"
echo ""

# Step 2: Build Docker image for the target platform
echo "🐳 Building Docker image for $DOCKER_PLATFORM..."
docker build --platform "$DOCKER_PLATFORM" -t strandweave-test "$DOCKER_DIR"
echo "✅ Docker image built"
echo ""

# Step 3: Run tests in container
echo "🧪 Running tests in container..."
echo ""

# Test 1: Help command
echo "Test 1: --help command"
docker run --rm --platform "$DOCKER_PLATFORM" \
    -v "$EXECUTABLE_PATH:/app/strandweave:ro" \
    strandweave-test \
    sh -c "/app/strandweave --help" || {
        echo "❌ Test 1 failed"
        exit 1
    }

echo ""
echo "✅ Test 1 passed: Help command works"
echo ""

# Test 2: Validate command (should try extraction)
echo "Test 2: --validate command (tests extraction)"
docker run --rm --platform "$DOCKER_PLATFORM" \
    -v "$EXECUTABLE_PATH:/app/strandweave:ro" \
    strandweave-test \
    sh -c "/app/strandweave --validate 2>&1" || true

echo ""
echo "✅ Test 2 complete: Validation attempted"
echo ""

# Test 3: Check extraction directory
echo "Test 3: Verify extraction creates files"
docker run --rm --platform "$DOCKER_PLATFORM" \
    -v "$EXECUTABLE_PATH:/app/strandweave:ro" \
    strandweave-test \
    sh -c "
        echo 'Running executable to trigger extraction...'
        /app/strandweave --no-autostart 2>&1 | head -20 || true
        echo ''
        echo 'Checking extraction directory...'
        if [ -d ~/.strandweave/claude-sdk ]; then
            echo '✓ Extraction directory exists'
            ls -la ~/.strandweave/claude-sdk/
            VERSION_DIR=\$(ls ~/.strandweave/claude-sdk/ | head -1)
            if [ -f ~/.strandweave/claude-sdk/\$VERSION_DIR/cli.js ]; then
                echo '✓ cli.js extracted successfully'
                ls -la ~/.strandweave/claude-sdk/\$VERSION_DIR/
            else
                echo '✗ cli.js not found in version directory'
                ls -la ~/.strandweave/claude-sdk/\$VERSION_DIR/ 2>/dev/null || echo '  (directory empty or missing)'
            fi
        else
            echo '✗ Extraction directory not created'
        fi
    "

echo ""
echo "🎉 All tests complete!"
echo ""
echo "To run the executable interactively:"
echo "  docker run -it --rm --platform $DOCKER_PLATFORM \\"
echo "    -v $EXECUTABLE_PATH:/app/strandweave:ro \\"
echo "    -e ANTHROPIC_API_KEY=\$ANTHROPIC_API_KEY \\"
echo "    strandweave-test \\"
echo "    /app/strandweave --help"
