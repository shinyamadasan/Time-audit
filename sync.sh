#!/usr/bin/env bash
# sync.sh — ChronaSense www/ runtime mirror (SAFE: mirror / check only)
#
# Thin wrapper around scripts/runtime-mirror.mjs. It computes the browser-
# runtime dependency closure rooted at index.html and mirrors exactly those
# files into www/ (the Capacitor webDir), byte-for-byte.
#
# This script does NOT and MUST NOT: git add / commit / push / merge, or run
# `npx cap sync android`. Native sync + release is a separate, explicit action:
# see scripts/deploy-release.ps1.
#
#   ./sync.sh            mirror root -> www/ (default)
#   ./sync.sh --check    verify parity only, no writes, non-zero exit on drift

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "$#" -eq 0 ]; then
  exec node "$SCRIPT_DIR/scripts/runtime-mirror.mjs" --write
else
  exec node "$SCRIPT_DIR/scripts/runtime-mirror.mjs" "$@"
fi
