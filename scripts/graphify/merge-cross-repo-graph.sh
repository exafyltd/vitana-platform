#!/bin/bash
# Merges this repo's Graphify graph with exafyltd/vitana-v1's into one
# cross-repo graph, so a query can span both (e.g. "what in vitana-v1 calls
# this gateway route", "does this response shape match what the frontend
# actually reads") — something two separate, single-repo graphs cannot
# answer (VTID-04121).
#
# Both source graphs must already exist and be reasonably fresh — this
# script does not build or refresh either one. In a Claude Code session,
# .claude/hooks/session-start-codeintel-setup.sh already builds
# graphify-out/graph.json for whichever repo it runs in; run it in the
# other repo's checkout too (or `graphify update <path> --no-cluster`)
# before merging, or the merge will be querying a stale/absent graph.
#
# Usage:
#   scripts/graphify/merge-cross-repo-graph.sh [vitana-v1-path] [out-path]
#
# Defaults assume the sibling-checkout layout this environment always uses
# (both repos live under /home/user/).
set -euo pipefail

PLATFORM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
V1_DIR="${1:-/home/user/vitana-v1}"
OUT_PATH="${2:-$PLATFORM_DIR/graphify-out/cross-repo-graph.json}"

PLATFORM_GRAPH="$PLATFORM_DIR/graphify-out/graph.json"
V1_GRAPH="$V1_DIR/graphify-out/graph.json"

if [ ! -f "$PLATFORM_GRAPH" ]; then
  echo "error: $PLATFORM_GRAPH does not exist — run 'graphify update $PLATFORM_DIR --no-cluster' first" >&2
  exit 1
fi
if [ ! -f "$V1_GRAPH" ]; then
  echo "error: $V1_GRAPH does not exist — run 'graphify update $V1_DIR --no-cluster' in that checkout first" >&2
  exit 1
fi

echo "Merging:" >&2
echo "  platform: $PLATFORM_GRAPH" >&2
echo "  vitana-v1: $V1_GRAPH" >&2
echo "  -> $OUT_PATH" >&2

graphify merge-graphs "$PLATFORM_GRAPH" "$V1_GRAPH" --out "$OUT_PATH"

echo "Done. Query it with, e.g.:" >&2
echo "  graphify query \"<question>\" --graph \"$OUT_PATH\"" >&2
echo "  graphify path \"<A>\" \"<B>\" --graph \"$OUT_PATH\"" >&2
