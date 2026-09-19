#!/bin/bash
# Installs and refreshes the two codebase-intelligence tools CLAUDE.md's
# "Mandatory Codebase Intelligence Workflow" requires (RepoWise, Graphify),
# so that workflow has real tooling behind it at session start instead of
# being an instruction with nothing installed to satisfy it (VTID-04121).
#
# Idempotent by construction: pip/uv installs are no-ops once the package
# is present, and both tools' own "update" commands are incremental
# (tree-sitter/AST re-extraction only touches files that changed since the
# last run) — so a cached container pays the full first-index cost once,
# and every session after that is fast. Never blocks session start on
# failure: a codeintel outage should degrade to "index stale/missing",
# not "session won't open."
set -uo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

REPO_DIR="${CLAUDE_PROJECT_DIR:-/home/user/vitana-platform}"
export PATH="$HOME/.local/bin:$PATH"

cd "$REPO_DIR" || exit 0

log() { echo "session-start-codeintel-setup: $*" >&2; }

# --- Install (no-op if already present) -------------------------------
if ! command -v repowise >/dev/null 2>&1; then
  log "installing repowise..."
  pip3 install --user --quiet repowise || log "repowise install FAILED, skipping RepoWise this session"
fi

if ! command -v graphify >/dev/null 2>&1; then
  log "installing graphifyy (graphify CLI)..."
  if command -v uv >/dev/null 2>&1; then
    uv tool install --quiet graphifyy || log "graphify install FAILED, skipping Graphify this session"
  else
    log "uv not found, cannot install graphify"
  fi
fi

# --- Index / refresh (bounded — never let a slow index hang the hook) -
if command -v graphify >/dev/null 2>&1; then
  log "refreshing graphify graph..."
  timeout 240 graphify update "$REPO_DIR" --no-cluster \
    || log "graphify update did not complete in time or failed — graph may be stale"
fi

if command -v repowise >/dev/null 2>&1; then
  if [ -d "$REPO_DIR/.repowise" ]; then
    log "incrementally updating repowise index..."
    timeout 240 repowise update || log "repowise update did not complete in time or failed — index may be stale"
  else
    log "first-time repowise index (this is the slow run; later sessions will be incremental)..."
    timeout 280 repowise init --no-prose -y || log "repowise init did not complete in time or failed — no index this session"
  fi
fi

log "done (graphify-out/graph.json + .repowise/ are what get_overview/graphify query read from)"
exit 0
