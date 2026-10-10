#!/bin/bash
# SessionStart hook: codebase intelligence (RepoWise + Graphify) for this repo.
#
# All logic lives in scripts/codeintel/session-setup.sh (VTID-04758): install
# both tools in the foreground (~1 min on a fresh container, seconds when
# cached), then index in a detached worker so this hook returns at once instead
# of being killed by its timeout half-way through a ~10 min RepoWise build
# (the VTID-04116/04121 body this replaces never finished on a fresh container).
# RepoWise is seeded from the full-history index CODEINTEL-INDEX.yml publishes;
# Graphify builds locally; both git post-commit hooks keep them current.
#
# This hook only runs when the session's working directory is this repo. A
# multi-repo session (working directory /home/user) never loads it — those
# need the environment setup script, see docs/CODEINTEL-SESSION-SETUP.md.
#
# Never blocks session start: every failure degrades to "index missing/stale".
# Progress: bash scripts/codeintel/session-setup.sh --status

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

REPO_DIR="${CLAUDE_PROJECT_DIR:-/home/user/vitana-platform}"
SETUP="$REPO_DIR/scripts/codeintel/session-setup.sh"
[ -f "$SETUP" ] || exit 0

bash "$SETUP" "$REPO_DIR"
exit 0
