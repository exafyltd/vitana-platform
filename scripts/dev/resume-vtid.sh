#!/bin/bash
# VTID-05060 — print where one VTID stands, to continue it in Kiro IDE, the
# Command Hub Operator or any Claude Code session.
#
#   scripts/dev/resume-vtid.sh VTID-05047
#
# Reads GET /api/v1/dev-memory/resume/<VTID>?format=text: the ledger row, its
# PRs in both repos, its evidence, handoff notes and deploy state, followed by
# the instructions block. Read-only. Needs DEV_MEMORY_PACK_TOKEN (the same
# read-only token as the SessionStart morning pack). Base URL:
# DEV_MEMORY_PACK_URL, default the staging gateway. Exits non-zero with the
# reason on any failure; never prints the token.
set -uo pipefail

VTID="${1:-}"
if ! [[ "$VTID" =~ ^VTID-[0-9]{5}$ ]]; then
  echo "usage: scripts/dev/resume-vtid.sh VTID-12345" >&2
  exit 2
fi
TOKEN="${DEV_MEMORY_PACK_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  echo "resume-vtid: DEV_MEMORY_PACK_TOKEN is not set — ask an admin for the read-only dev-memory pack token" >&2
  exit 3
fi
BASE="${DEV_MEMORY_PACK_URL:-https://preview-aws-gateway.vitanaland.com}"

BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT
CODE="$(curl -sS -m 30 -o "$BODY_FILE" -w '%{http_code}' \
  -H "X-Dev-Memory-Token: ${TOKEN}" \
  "${BASE}/api/v1/dev-memory/resume/${VTID}?format=text")" || { echo "resume-vtid: request to ${BASE} failed" >&2; exit 4; }
if [ "$CODE" != "200" ]; then
  echo "resume-vtid: HTTP ${CODE} from ${BASE}: $(head -c 300 "$BODY_FILE")" >&2
  exit 5
fi
cat "$BODY_FILE"
