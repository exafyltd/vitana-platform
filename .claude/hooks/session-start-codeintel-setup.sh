#!/bin/bash
# Installs and refreshes the two codebase-intelligence tools CLAUDE.md's
# "Mandatory Codebase Intelligence Workflow" requires (RepoWise, Graphify),
# so that workflow has real tooling behind it at session start instead of
# being an instruction with nothing installed to satisfy it (VTID-04116).
#
# Idempotent by construction: pip/uv installs are no-ops once the package
# is present, and both tools' own "update" commands are incremental
# (tree-sitter/AST re-extraction only touches files that changed since the
# last run) — so a cached container pays the full first-index cost once,
# and every session after that is fast. Never blocks session start on
# failure: a codeintel outage should degrade to "index stale/missing",
# not "session won't open."
#
# VTID-04121 additions:
#   - graphify now gets its "bedrock" extra (boto3) so community clustering
#     can be LABELED with real semantic names via Amazon Bedrock, not left
#     as bare "Community N" placeholders — this session's own AWS
#     credentials (ambient in this remote environment) are enough; Bedrock
#     is this codebase's own standing-mandated LLM path (CLAUDE.md §2b),
#     never Google. If no AWS creds are present, falls back to the
#     unlabeled `--no-cluster` build exactly as before — never blocks.
#   - `repowise hook install` wires the git post-commit auto-sync hook so
#     the index stays current across commits within one session, not just
#     at session start.
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

if command -v uv >/dev/null 2>&1; then
  log "ensuring graphify is installed (with bedrock extra for community labeling)..."
  uv tool install --quiet "graphifyy[bedrock]" || log "graphify install FAILED, skipping Graphify this session"
else
  log "uv not found, cannot install graphify"
fi

# --- Index / refresh (bounded — never let a slow index hang the hook) -
if command -v graphify >/dev/null 2>&1; then
  if [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ]; then
    log "refreshing graphify graph with real Bedrock community labeling..."
    timeout 300 graphify label "$REPO_DIR" --backend bedrock --model eu.anthropic.claude-sonnet-4-6 \
      || {
        log "graphify label failed or timed out — falling back to unlabeled clustering"
        timeout 120 graphify update "$REPO_DIR" --no-cluster \
          || log "graphify update also failed — graph may be stale"
      }
  else
    log "no AWS credentials in this session — refreshing graphify graph without community labeling..."
    timeout 240 graphify update "$REPO_DIR" --no-cluster \
      || log "graphify update did not complete in time or failed — graph may be stale"
  fi
fi

if command -v repowise >/dev/null 2>&1; then
  if [ -d "$REPO_DIR/.repowise" ]; then
    log "incrementally updating repowise index..."
    timeout 240 repowise update || log "repowise update did not complete in time or failed — index may be stale"
  else
    log "first-time repowise index (this is the slow run; later sessions will be incremental)..."
    timeout 280 repowise init --no-prose -y || log "repowise init did not complete in time or failed — no index this session"
  fi
  repowise hook install >/dev/null 2>&1 \
    || log "repowise hook install failed (non-fatal) — git post-commit auto-sync not active this session"
fi

log "done (graphify-out/graph.json + .repowise/ are what get_overview/graphify query read from)"
exit 0
