#!/usr/bin/env bash
#
# VTID-03492 — apply SQL to Supabase from GitHub Actions, over HTTPS.
#
# WHY THIS EXISTS
# ---------------
# The workflows that apply migrations used `psql "$SUPABASE_DB_URL" -f file.sql`.
# That cannot connect from GitHub Actions: the Supabase project has a network
# allow-list and runner IPs are not on it —
#
#   psql: error: ... FATAL: (EADDRNOTALLOWED) address not in tenant allow_list
#
# and runner IPs differ per run, so allow-listing them is not practical.
#
# The read-only health checks were moved to PostgREST RPCs. That does NOT work
# here: PostgREST cannot execute arbitrary DDL. The alternative — an RPC that
# EXECUTEs caller-supplied SQL — would be a remote-DDL-execution endpoint on
# production, and was deliberately NOT built.
#
# The Supabase Management API is the supported path for arbitrary SQL over
# HTTPS. It is a control-plane service on api.supabase.com and is not subject
# to the database's network allow-list.
#
# REQUIRED SECRET
# ---------------
#   SUPABASE_ACCESS_TOKEN — a Supabase personal access token
#                           (https://supabase.com/dashboard/account/tokens)
# This secret does NOT yet exist on the repo. Until it is added, these
# workflows fail immediately with an explicit message rather than silently.
# The project ref is derived from SUPABASE_URL, so no second secret is needed.
#
# ERROR HANDLING
# --------------
# Preserves the VTID-03174 hardening that `psql -v ON_ERROR_STOP=1` provided:
# a SQL error must FAIL the step. Prior to VTID-03174 a rolled-back migration
# could report success, which is worse than a red run. Here we require both a
# 2xx HTTP status AND the absence of an error payload before returning 0.
#
# Usage:
#   apply-sql-via-management-api.sh --file path/to/migration.sql
#   apply-sql-via-management-api.sh --sql "NOTIFY pgrst, 'reload schema';"

set -euo pipefail

MODE=""
ARG=""
SINGLE_TX=0
while [ $# -gt 0 ]; do
  case "$1" in
    --file) MODE=file; ARG="${2:-}"; shift 2 ;;
    --sql)  MODE=sql;  ARG="${2:-}"; shift 2 ;;
    # Replaces `psql -1`: run the whole file as one transaction so a failure
    # rolls back cleanly instead of leaving a half-applied migration.
    --single-transaction) SINGLE_TX=1; shift ;;
    *) echo "::error::unknown argument: $1"; exit 2 ;;
  esac
done

if [ -z "$MODE" ] || [ -z "$ARG" ]; then
  echo "::error::usage: $0 --file <path> | --sql <statement>"
  exit 2
fi

if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "::error::SUPABASE_ACCESS_TOKEN is not set. This workflow applies SQL over the Supabase Management API because psql cannot reach the database from GitHub Actions (network allow-list). Create a personal access token at https://supabase.com/dashboard/account/tokens and add it as the repo secret SUPABASE_ACCESS_TOKEN."
  exit 1
fi

if [ -z "${SUPABASE_URL:-}" ]; then
  echo "::error::SUPABASE_URL is not set — needed to derive the project ref."
  exit 1
fi

# https://<ref>.supabase.co -> <ref>
PROJECT_REF=$(printf '%s' "$SUPABASE_URL" | sed -E 's#^https?://##; s#\..*$##')
if [ -z "$PROJECT_REF" ]; then
  echo "::error::Could not derive project ref from SUPABASE_URL."
  exit 1
fi

if [ "$MODE" = "file" ]; then
  if [ ! -f "$ARG" ]; then
    echo "::error::SQL file not found: $ARG"
    exit 1
  fi
  echo "Applying SQL file: $ARG (project $PROJECT_REF)"
  SQL_TEXT=$(cat "$ARG")
else
  echo "Applying inline SQL (project $PROJECT_REF)"
  SQL_TEXT="$ARG"
fi

if [ "$SINGLE_TX" = "1" ]; then
  # Only wrap when the file does not already manage its own transaction.
  # Double-wrapping is not a no-op: a nested BEGIN is ignored with a warning,
  # but the file's own COMMIT would then close OUR transaction early and the
  # remaining statements would run unprotected — silently losing the atomicity
  # this flag exists to provide. So detect and defer to the file.
  if printf '%s' "$SQL_TEXT" | grep -qiE '^[[:space:]]*BEGIN[[:space:]]*;'; then
    echo "Note: file manages its own transaction (BEGIN found) — not adding an outer one."
  else
    SQL_TEXT="BEGIN;
${SQL_TEXT}
COMMIT;"
    echo "Wrapped in a single transaction."
  fi
fi

# jq -Rs slurps raw stdin into a single correctly-escaped JSON string, which is
# the only safe way to embed arbitrary SQL (quotes, newlines, $$ bodies).
PAYLOAD=$(printf '%s' "$SQL_TEXT" | jq -Rs '{query: .}')

RESPONSE_FILE=$(mktemp)
trap 'rm -f "$RESPONSE_FILE"' EXIT

HTTP=$(curl -sS -o "$RESPONSE_FILE" -w '%{http_code}' \
  -X POST "https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query" \
  -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data-binary "$PAYLOAD")

BODY=$(head -c 2000 "$RESPONSE_FILE" 2>/dev/null || true)

if [ "$HTTP" != "200" ] && [ "$HTTP" != "201" ]; then
  echo "::error::Management API returned HTTP $HTTP"
  echo "$BODY"
  exit 1
fi

# A 200 with an error object still means the SQL failed. Without this check we
# would reintroduce exactly the VTID-03174 bug: a green run over a rolled-back
# transaction.
if printf '%s' "$BODY" | jq -e 'if type=="object" then has("error") or has("message") else false end' >/dev/null 2>&1; then
  echo "::error::SQL execution reported an error:"
  echo "$BODY"
  exit 1
fi

echo "$BODY"
echo "SQL applied successfully"
