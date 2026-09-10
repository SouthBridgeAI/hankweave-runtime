#!/usr/bin/env bash
# Queries verify the docs and optional source pack; default scope is docs.
set -euo pipefail
exec python3 "$(dirname "$0")/index.py" "$@"
