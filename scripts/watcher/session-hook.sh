#!/usr/bin/env bash
# =============================================================================
# VTID-03464 — Watcher Phase 5: Claude Code session hook
# =============================================================================
# Plan: docs/WATCHER-AGENT-PLAN.md (VTID-03454) Phase 5.
#
# Records what a Claude Code session did onto the Watcher timeline, and at
# session end reconciles the repo state to catch the one failure mode that
# has already cost this project real time:
#
#   CLAUDE.md changelog, 2026-07-29 — VTID-03419 executed a genuine
#   production cutover, and "the doc-update step in VTID-03419's own spec
#   was apparently never pushed before that session's context was
#   summarized." The infrastructure change was real; the paper trail
#   describing it was lost. A later session had to rediscover it.
#
# That is not a code bug and no test would have caught it. It is a session
# that ended with work on disk and nothing pushed — which is exactly what
# this script looks for.
#
# Usage (wired in .claude/settings.json):
#   session-hook.sh start
#   session-hook.sh stop
#
# =============================================================================
# SAFETY CONTRACT — read before editing
# =============================================================================
#   * Exits 0 ALWAYS. A hook that fails must never fail the session it is
#     observing; an observer that can break the thing it observes is worse
#     than no observer.
#   * Strict no-op when WATCHER_SESSION_TOKEN or the gateway URL is unset.
#     No token means the ingest endpoint is closed anyway (it 503s), so
#     firing would be pure noise.
#   * Never writes to the repo, never stages, never commits, never pushes.
#     It reports; a human decides.
#   * Short curl timeouts. A slow or dead gateway must not hang a session.
# =============================================================================

set -u

ACTION="${1:-stop}"

GATEWAY="${WATCHER_GATEWAY_URL:-${GATEWAY_URL:-https://gateway.vitanaland.com}}"
TOKEN="${WATCHER_SESSION_TOKEN:-}"
SESSION_ID="${CLAUDE_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-}}"

# --- no-op guards ------------------------------------------------------------
[ -n "$TOKEN" ] || exit 0
[ -n "$GATEWAY" ] || exit 0

# Without a session id there is no work_unit to attach steps to, and
# inventing one would create orphan rows that never join up.
if [ -z "$SESSION_ID" ]; then
  SESSION_ID="$(git -C "${CLAUDE_PROJECT_DIR:-.}" rev-parse --short HEAD 2>/dev/null || echo '')"
  [ -n "$SESSION_ID" ] || exit 0
  SESSION_ID="adhoc-${SESSION_ID}"
fi

REPO_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"

post_step() {
  # $1 step, $2 outcome, $3 ref, $4 evidence json
  curl -s -m 5 -o /dev/null \
    -X POST "${GATEWAY}/api/v1/watcher/session-step" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H 'Content-Type: application/json' \
    -d "{\"session_id\":\"${SESSION_ID}\",\"step\":\"$1\",\"outcome\":\"$2\",\"ref\":\"$3\",\"evidence\":$4}" \
    2>/dev/null || true
}

json_escape() {
  # Keep it dependency-free: sed, not jq. Hooks run on machines we do not
  # control, and a hard jq dependency would make this silently stop firing.
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\n'
}

case "$ACTION" in
  start)
    BRANCH="$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
    post_step running unknown session_start \
      "{\"branch\":\"$(json_escape "$BRANCH")\"}"
    ;;

  stop)
    # -------------------------------------------------------------------
    # End-of-session reconciliation
    # -------------------------------------------------------------------
    # Three states worth distinguishing. Only the last one is a finding.
    DIRTY="$(git -C "$REPO_DIR" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
    BRANCH="$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"

    # Commits on this branch not present on its upstream. `@{u}` fails when
    # there is no upstream, which is itself the "never pushed" case.
    if git -C "$REPO_DIR" rev-parse '@{u}' >/dev/null 2>&1; then
      UNPUSHED="$(git -C "$REPO_DIR" rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)"
      HAS_UPSTREAM=true
    else
      UNPUSHED="$(git -C "$REPO_DIR" rev-list --count HEAD 2>/dev/null || echo 0)"
      HAS_UPSTREAM=false
    fi

    # Documentation specifically. A session that changed only code and left
    # it uncommitted is an ordinary work-in-progress; a session that changed
    # DOCS and left them unpushed is the VTID-03419 shape, because the doc
    # is the only record that the work happened at all.
    DOCS_DIRTY="$(git -C "$REPO_DIR" status --porcelain 2>/dev/null \
      | grep -cE '(CLAUDE\.md|DATABASE_SCHEMA\.md|docs/|\.md$)' || true)"
    DOCS_DIRTY="${DOCS_DIRTY:-0}"

    EVIDENCE="{\"branch\":\"$(json_escape "$BRANCH")\",\"dirty_files\":${DIRTY},\"unpushed_commits\":${UNPUSHED},\"has_upstream\":${HAS_UPSTREAM},\"dirty_doc_files\":${DOCS_DIRTY}}"

    if [ "${DIRTY}" -gt 0 ] || [ "${UNPUSHED}" -gt 0 ]; then
      # outcome=failure is deliberate and is the whole point: this row is
      # what a future session's reminder is distilled FROM. Recording it as
      # a success would teach the memory that ending unpushed is fine.
      post_step completed failure session_end "$EVIDENCE"
      if [ "${DOCS_DIRTY}" -gt 0 ]; then
        post_step doc_updated failure session_end_docs "$EVIDENCE"
      fi
      echo "[watcher] session ended with ${DIRTY} uncommitted file(s) and ${UNPUSHED} unpushed commit(s) on ${BRANCH}." >&2
      if [ "${DOCS_DIRTY}" -gt 0 ]; then
        echo "[watcher] ${DOCS_DIRTY} of them are docs — this is the VTID-03419 shape (work real, paper trail unpushed)." >&2
      fi
    else
      post_step completed success session_end "$EVIDENCE"
    fi
    ;;

  *)
    ;;
esac

# Always succeed. See the safety contract above.
exit 0
