#!/usr/bin/env bash
# Cache identity binds the canonical locations and SHA256 of every selected part.
set -euo pipefail
exec python3 "$(dirname "$0")/index.py" build "$@"
