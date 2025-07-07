#!/bin/bash

echo "🧹 Cleaning up Langton test environment..."

# First, check if lock file exists and use the PID from it
LOCK_FILE="tests/test-area/.langton-server.lock"
if [ -f "$LOCK_FILE" ]; then
    echo "Found lock file: $LOCK_FILE"
    SERVER_PID=$(cat "$LOCK_FILE" 2>/dev/null)
    
    if [ ! -z "$SERVER_PID" ]; then
        echo "Lock file contains PID: $SERVER_PID"
        
        # Verify this PID is actually our server by checking the command
        if ps -p "$SERVER_PID" -o args= 2>/dev/null | grep -q "test-phases.config.json"; then
            echo "✅ Found our test server process (PID: $SERVER_PID)"
            echo "Killing process..."
            kill -TERM "$SERVER_PID" 2>/dev/null || true
            sleep 1
            # Check if still running
            if ps -p "$SERVER_PID" > /dev/null 2>&1; then
                echo "Process still running, sending SIGKILL..."
                kill -KILL "$SERVER_PID" 2>/dev/null || true
            fi
            echo "✅ Server process killed"
        else
            echo "⚠️  PID $SERVER_PID doesn't appear to be our test server"
        fi
    fi
    
    echo "Removing lock file..."
    rm -f "$LOCK_FILE"
    echo "✅ Lock file removed"
else
    echo "✅ No lock file found"
fi

# Double-check: Look for any processes with our specific test config
echo "Double-checking for test server processes..."
TEST_SERVER_PIDS=$(ps aux | grep "test-phases.config.json" | grep -v grep | awk '{print $2}')

if [ ! -z "$TEST_SERVER_PIDS" ]; then
    echo "⚠️  Found additional test server processes: $TEST_SERVER_PIDS"
    for PID in $TEST_SERVER_PIDS; do
        # Verify it's in our test directory
        if lsof -p "$PID" 2>/dev/null | grep -q "tests/test-area"; then
            echo "Killing test server process $PID..."
            kill -TERM "$PID" 2>/dev/null || true
            sleep 1
            kill -KILL "$PID" 2>/dev/null || true
        fi
    done
    echo "✅ Additional test server processes killed"
else
    echo "✅ No additional test server processes found"
fi

# Optional: Clean test area
read -p "Do you want to clean the test area? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "Cleaning test area..."
    rm -rf tests/test-area
    mkdir -p tests/test-area
    echo "✅ Test area cleaned"
fi

echo "🎉 Cleanup complete!"