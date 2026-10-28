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
#   session-hook.sh start   # SessionStart
#   session-hook.sh end     # SessionEnd   ('stop' accepted as a legacy alias)
#
# =============================================================================
# HOOK CONTRACT — three corrections, VTID-03531
# =============================================================================
# The first version of this script got all three of these wrong. They were
# caught in review of exafyltd/vitana-v1#969 and confirmed against
# https://code.claude.com/docs/en/hooks before being fixed here.
#
# 1. THE SESSION ID ARRIVES ON STDIN, NOT IN THE ENVIRONMENT.
#    There is no CLAUDE_SESSION_ID or CLAUDE_CODE_SESSION_ID env var — the
#    documented hook input is a JSON object on stdin carrying session_id.
#    Reading the env var meant this ALWAYS fell through to the adhoc-<sha>
#    fallback, which merges unrelated sessions that share a commit and splits
#    one session into two ids if it commits between start and end.
#
# 2. RECONCILIATION BELONGS ON SessionEnd, NOT Stop.
#    Stop fires once per assistant RESPONSE — many times in a multi-turn
#    session. SessionEnd fires once, when the session terminates. On Stop this
#    posted a 'completed' row after every turn; and because watcher_steps is
#    upserted with ignoreDuplicates, the FIRST write wins, so a dirty tree on
#    turn one would permanently brand a session that ended perfectly clean as
#    a failure. The timeline would have been actively wrong, not merely noisy.
#
# 3. NO UPSTREAM != EVERY COMMIT IS UNPUSHED.
#    `git rev-list --count HEAD` with no upstream counts the entire reachable
#    history, so a fresh clean branch reported thousands of unpushed commits
#    and every reconciliation recorded a false failure. Observed live: 68
#    "unpushed commits" on a branch with one real commit.
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

ACTION="${1:-end}"

GATEWAY="${WATCHER_GATEWAY_URL:-${GATEWAY_URL:-https://gateway.vitanaland.com}}"
TOKEN="${WATCHER_SESSION_TOKEN:-}"

# --- no-op guards ------------------------------------------------------------
# Before reading stdin: with no token there is nothing to send, and consuming
# the hook payload for no reason is pointless work.
[ -n "$TOKEN" ] || exit 0
[ -n "$GATEWAY" ] || exit 0

REPO_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"

# --- hook input --------------------------------------------------------------
# Guarded on `-t 0` so a human running this by hand from a terminal does not
# hang waiting on a payload that will never come.
HOOK_INPUT=''
if [ ! -t 0 ]; then
  HOOK_INPUT="$(cat 2>/dev/null || true)"
fi

# Extract a top-level string field from the hook JSON.
#
# jq when available, sed otherwise. The sed path is not decoration: hooks run
# on machines we do not control, and making this script hard-depend on jq is
# how it would silently stop firing on one. Session ids and reasons are
# simple tokens, so the naive pattern is sufficient for these two fields.
json_field() {
  _jf_key="$1"
  _jf_out=''
  if command -v jq >/dev/null 2>&1; then
    _jf_out="$(printf '%s' "$HOOK_INPUT" | jq -r --arg k "$_jf_key" '.[$k] // empty' 2>/dev/null || true)"
  fi
  if [ -z "$_jf_out" ]; then
    _jf_out="$(printf '%s' "$HOOK_INPUT" \
      | sed -n "s/.*\"${_jf_key}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" \
      | head -1)"
  fi
  printf '%s' "$_jf_out"
}

SESSION_ID="$(json_field session_id)"

# Fallback only. Kept because a missing id would otherwise drop the step
# entirely, and a coarse work_unit beats no record — but it is explicitly
# marked adhoc- so nobody mistakes it for a real session id when reading the
# timeline. See correction 1 above for why this used to be the ONLY path.
if [ -z "$SESSION_ID" ]; then
  SESSION_ID="$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo '')"
  [ -n "$SESSION_ID" ] || exit 0
  SESSION_ID="adhoc-${SESSION_ID}"
fi

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
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\n'
}

# Commits on this branch that are not yet on a remote.
#
# Prefers the configured upstream. With no upstream, falls back to the repo's
# default remote branch rather than counting all of HEAD (correction 3). If
# neither resolves, reports -1 = UNKNOWN — an honest "cannot tell" beats a
# fabricated number that turns every clean session into a recorded failure.
count_unpushed() {
  if git -C "$REPO_DIR" rev-parse '@{u}' >/dev/null 2>&1; then
    git -C "$REPO_DIR" rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0
    return
  fi
  for _base in \
    "$(git -C "$REPO_DIR" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)" \
    origin/main origin/master
  do
    [ -n "$_base" ] || continue
    if git -C "$REPO_DIR" rev-parse --verify --quiet "$_base" >/dev/null 2>&1; then
      git -C "$REPO_DIR" rev-list --count "${_base}..HEAD" 2>/dev/null || echo 0
      return
    fi
  done
  echo -1
}

case "$ACTION" in
  start)
    BRANCH="$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
    SOURCE="$(json_field source)"
    post_step running unknown session_start \
      "{\"branch\":\"$(json_escape "$BRANCH")\",\"source\":\"$(json_escape "${SOURCE:-unknown}")\"}"
    ;;

  end|stop)
    # -------------------------------------------------------------------
    # End-of-session reconciliation
    # -------------------------------------------------------------------
    DIRTY="$(git -C "$REPO_DIR" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
    BRANCH="$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
    UNPUSHED="$(count_unpushed)"
    REASON="$(json_field reason)"

    # Documentation specifically. A session that changed only code and left
    # it uncommitted is an ordinary work-in-progress; a session that changed
    # DOCS and left them unpushed is the VTID-03419 shape, because the doc
    # is the only record that the work happened at all.
    DOCS_DIRTY="$(git -C "$REPO_DIR" status --porcelain 2>/dev/null \
      | grep -cE '(CLAUDE\.md|DATABASE_SCHEMA\.md|docs/|\.md$)' || true)"
    DOCS_DIRTY="${DOCS_DIRTY:-0}"

    EVIDENCE="{\"branch\":\"$(json_escape "$BRANCH")\",\"dirty_files\":${DIRTY},\"unpushed_commits\":${UNPUSHED},\"dirty_doc_files\":${DOCS_DIRTY},\"end_reason\":\"$(json_escape "${REASON:-unknown}")\"}"

    # -1 is UNKNOWN, not "lots". Treating it as a failure signal would
    # reintroduce correction 3 by a different route.
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
