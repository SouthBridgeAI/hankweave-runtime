# Minimal environment for testing standalone executable
# Uses Debian (glibc-based) because Bun compiles with glibc, NOT musl (Alpine)
#
# NOTE: If building on Apple Silicon, use --platform linux/amd64 for x64 builds
FROM debian:bookworm-slim

# Install basic utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    ca-certificates \
    bsdutils \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js (required by cli.js)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Create a test user
RUN useradd -m testuser

# Switch to test user for Bun installation
USER testuser
WORKDIR /home/testuser

# Install Bun (required by Claude Agent SDK to run cli.js)
RUN curl -fsSL https://bun.sh/install | bash

# Add Bun to PATH
ENV BUN_INSTALL="/home/testuser/.bun"
ENV PATH="$BUN_INSTALL/bin:$PATH"

# Create a minimal test project
RUN mkdir -p /home/testuser/test-project
WORKDIR /home/testuser/test-project

# Create a minimal strand.json for testing
RUN echo '{"strand":{"name":"test-strand","codons":[{"id":"test","name":"Test Codon","promptText":"Say hello and exit immediately.","model":"sonnet"}]}}' > strand.json

# Default command: show help (will be overridden by test script)
CMD ["sh", "-c", "echo 'Container ready. Mount executable and run tests.'"]
