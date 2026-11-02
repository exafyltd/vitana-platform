#!/usr/bin/env bash
# mt-guardrails-r2 / local-test-stack: remove the disposable local Postgres
# container and its data. Safe to run when the container does not exist.
set -euo pipefail

CONTAINER="${MT_STACK_CONTAINER:-mt-local-stack}"

if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  docker rm -f -v "$CONTAINER" >/dev/null
  echo "down.sh: removed $CONTAINER"
else
  echo "down.sh: $CONTAINER not present"
fi
