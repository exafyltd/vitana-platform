#!/bin/bash
# Installs gateway dependencies on session start using an absolute,
# repo-root-anchored path. The environment-level "Setup script" configured
# outside this repo assumes cwd is the gateway repo root and runs
# `cd services/gateway`, which breaks whenever this repo is checked out
# as a sibling directory alongside another repo (e.g. vitana-v1) instead
# of being the session's own working directory. Anchoring on
# $CLAUDE_PROJECT_DIR makes this hook correct regardless of that layout.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

GATEWAY_DIR="${CLAUDE_PROJECT_DIR:-/home/user/vitana-platform}/services/gateway"

if [ ! -d "$GATEWAY_DIR" ]; then
  echo "session-start-gateway-setup: $GATEWAY_DIR does not exist, skipping" >&2
  exit 0
fi

cd "$GATEWAY_DIR"
npm install
