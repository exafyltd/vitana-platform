#!/bin/bash
# VTID-04408 — print the developer morning pack at session start.
#
# The pack (GET /api/v1/dev-memory/morning-pack) holds the latest Operator
# thread handoffs, the knowledge recorded in dev_agent_memory in the last
# week, and the VTIDs still in progress. A SessionStart hook's stdout is
# added to the session's context, so the session starts from where the
# work stopped instead of from nothing.
#
# Read-only. Needs DEV_MEMORY_PACK_TOKEN in the environment (a read-only
# token the gateway compares against its own DEV_MEMORY_PACK_TOKEN); without
# it the hook prints nothing and exits 0. Never fails the session: any
# error, timeout or non-200 is reported on stderr only.
set -uo pipefail

TOKEN="${DEV_MEMORY_PACK_TOKEN:-}"
BASE="${DEV_MEMORY_PACK_URL:-https://preview-aws-gateway.vitanaland.com}"
REPO_NAME="${DEV_MEMORY_PACK_REPO:-vitana-platform}"

if [ -z "$TOKEN" ]; then
  echo "dev-memory-pack: DEV_MEMORY_PACK_TOKEN not set — skipping the morning pack" >&2
  exit 0
fi

QS="repo=${REPO_NAME}&format=text"
if [ -n "${DEV_MEMORY_PACK_AUTHOR:-}" ]; then QS="${QS}&author_user_id=${DEV_MEMORY_PACK_AUTHOR}"; fi

BODY_FILE="$(mktemp)"
CODE="$(curl -sS -m 8 -o "$BODY_FILE" -w '%{http_code}' \
  -H "X-Dev-Memory-Token: ${TOKEN}" \
  "${BASE}/api/v1/dev-memory/morning-pack?${QS}" 2>/dev/null || echo 000)"

if [ "$CODE" = "200" ]; then
  cat "$BODY_FILE"
else
  echo "dev-memory-pack: ${BASE} returned HTTP ${CODE} — no morning pack this session" >&2
fi
rm -f "$BODY_FILE"
exit 0
