#!/bin/bash

echo "🧹 Cleaning up Hankweave test environment..."

# proper-lockfile creates an in-directory lease, with no PID file to read.
TEST_AREA="$(pwd -P)/tests/test-area"
LOCK_DIR="${TEST_AREA}/.hankweave-runtime.lock"

# Find and stop test servers before removing their ownership directory.
echo "Checking for test server processes..."
TEST_SERVER_PIDS=$(ps aux | grep "test-codons.config.json" | grep -v grep | awk '{print $2}')

if [ ! -z "$TEST_SERVER_PIDS" ]; then
    echo "⚠️  Found test server processes: $TEST_SERVER_PIDS"
    for PID in $TEST_SERVER_PIDS; do
        # Verify it belongs to this workspace's test area.
        if lsof -p "$PID" 2>/dev/null | grep -Fq "$TEST_AREA"; then
            echo "Killing test server process $PID..."
            kill -TERM "$PID" 2>/dev/null || true
            sleep 1
            kill -KILL "$PID" 2>/dev/null || true
            for attempt in {1..50}; do
                if ! kill -0 "$PID" 2>/dev/null; then
                    break
                fi
                sleep 0.1
            done
            if kill -0 "$PID" 2>/dev/null; then
                echo "❌ Test server $PID is still running; leaving its lock and test area intact"
                exit 1
            fi
        fi
    done
    echo "✅ Test server processes stopped"
else
    echo "✅ No test server processes found"
fi

# A clean exit removes the lock; SIGKILL can leave an empty directory behind.
if [ -d "$LOCK_DIR" ]; then
    echo "Removing leftover lock directory: $LOCK_DIR"
    rmdir "$LOCK_DIR" || exit 1
    echo "✅ Lock directory removed"
else
    echo "✅ No lock directory found"
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
