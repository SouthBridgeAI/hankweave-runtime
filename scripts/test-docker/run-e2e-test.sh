#!/bin/bash
# Script to run inside Docker container for E2E testing
set -e

# Ensure bun is in PATH (needed by Claude Agent SDK to run cli.js)
export PATH="/home/testuser/.bun/bin:$PATH"
echo "🔧 Bun version: $(bun --version 2>/dev/null || echo 'not found')"

echo "📁 Setting up test environment..."
cd /home/testuser/test-project
rm -rf strand.json hello.txt ~/.strandweave-executions

# Create a minimal strand configuration with inline prompt
cat > strand.json << 'STRAND_CONFIG'
{
  "strand": [
    {
      "id": "simple-test",
      "name": "Simple E2E Test",
      "promptText": "Create a file called hello.txt containing exactly the text: Hello from Strandweave! - and nothing else. Do not create any other files.",
      "model": "sonnet",
      "continuationMode": "fresh",
      "appendSystemPromptText": "Complete the task quickly. Create ONLY the file requested, then stop.",
      "trackedFiles": ["*.txt"]
    }
  ]
}
STRAND_CONFIG

echo ""
echo "📋 Strand configuration:"
cat strand.json
echo ""

echo "🚀 Starting Strandweave in basic mode..."
echo "   (Timeout: 3 minutes)"
echo ""

# Run the executable with a timeout
# Basic mode connects via WebSocket and auto-starts the first codon
# Using script to provide a PTY environment for the TUI
EXIT_CODE=0
timeout 180 script -q /dev/null -c "/app/strandweave --basic 2>&1" || EXIT_CODE=$?

echo ""
echo "Server exited with code: ${EXIT_CODE}"
echo ""

echo "🔍 Checking results..."
echo ""

# Find the execution directory
EXEC_DIR=$(ls -td ~/.strandweave-executions/*/ 2>/dev/null | head -1)

if [ -z "$EXEC_DIR" ]; then
    echo "❌ No execution directory found"
    echo "   Something went wrong during startup"
    exit 1
fi

echo "📁 Execution directory: $EXEC_DIR"
echo ""

# List contents
echo "📂 Contents:"
ls -la "$EXEC_DIR"
echo ""

# Check for the created file
if [ -f "$EXEC_DIR/hello.txt" ]; then
    echo "✅ SUCCESS! hello.txt was created:"
    echo "   ─────────────────────────────"
    cat "$EXEC_DIR/hello.txt"
    echo ""
    echo "   ─────────────────────────────"
else
    echo "⚠️  hello.txt not found in execution directory"
    echo ""
    echo "Looking for any txt files..."
    find "$EXEC_DIR" -name "*.txt" -type f 2>/dev/null || echo "   (none found)"
fi

echo ""

# Check the state file for codon status
if [ -f "$EXEC_DIR/.strandweave/state.json" ]; then
    echo "📊 State:"
    # Extract just the codon states
    cat "$EXEC_DIR/.strandweave/state.json" | grep -o '"\(codons\|state\|status\)": [^,}]*' | head -20 || cat "$EXEC_DIR/.strandweave/state.json" | head -30
fi

echo ""

# Check log files for any errors
if [ -d "$EXEC_DIR/.strandweave/logs" ]; then
    echo "📜 Recent log entries:"
    for log in "$EXEC_DIR/.strandweave/logs/"*.jsonl; do
        if [ -f "$log" ]; then
            echo "   $(basename $log):"
            tail -5 "$log" | head -5
            echo ""
        fi
    done
fi

# Check extraction was successful
echo "🔧 Claude SDK extraction:"
if [ -d ~/.strandweave/claude-sdk ]; then
    ls -la ~/.strandweave/claude-sdk/*/
else
    echo "   Not found (this is a problem!)"
fi

echo ""
echo "🎉 E2E test complete!"

