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
#   apply-sql-via-management-api.sh --file supabase/migrations/<f>.sql --record-migration
#
# --record-migration (VTID-05123, RUN-MIGRATION only)
# ---------------------------------------------------
# Also writes one row per applied repo file to
# supabase_migrations.schema_migrations, as an audit trail (the table is NOT
# the authority on what is applied — MIGRATION-DRIFT-CHECK is, VTID-03486):
#   version = leading digits of the basename, name = the rest without .sql,
#   idempotency_key = the basename, created_by = github-actions:RUN-MIGRATION:<RUN_ID>.
# The INSERT is appended to the SAME request as the migration, after a "\n;\n",
# so it only runs if every statement before it succeeded (the body runs as one
# simple-query string; Postgres aborts the rest on the first error).
# A read-only pre-check first looks at the version: if another file (or an
# MCP/dashboard row) holds it, the INSERT is left out with a ::warning::. A
# DO ... EXCEPTION WHEN unique_violation guard covers the race between the
# pre-check and the apply. A read-only post-verify warns if no row exists.
# Exit codes: 0 applied (recorded, or not recorded with a ::warning::);
#             1 pre-check failed (nothing applied) or the migration failed;
#             2 usage error.
# Nothing is recorded for a path outside supabase/migrations/<file>.sql, a
# basename that does not match ^[0-9]{8,14}_[A-Za-z0-9_.-]+\.sql$ or contains
# a quote, a RUN_ID that is not all digits, or a file using CONCURRENTLY/VACUUM
# (those cannot run in the implicit transaction an appended INSERT creates).

set -euo pipefail

MODE=""
ARG=""
SINGLE_TX=0
RECORD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --file) MODE=file; ARG="${2:-}"; shift 2 ;;
    --sql)  MODE=sql;  ARG="${2:-}"; shift 2 ;;
    # Replaces `psql -1`: run the whole file as one transaction so a failure
    # rolls back cleanly instead of leaving a half-applied migration.
    --single-transaction) SINGLE_TX=1; shift ;;
    --record-migration) RECORD=1; shift ;;
    *) echo "::error::unknown argument: $1"; exit 2 ;;
  esac
done

if [ -z "$MODE" ] || [ -z "$ARG" ]; then
  echo "::error::usage: $0 --file <path> | --sql <statement>"
  exit 2
fi

if [ "$RECORD" = "1" ] && [ "$MODE" != "file" ]; then
  echo "::error::--record-migration needs --file"
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

# One extra read-only request (pre-check / post-verify for --record-migration).
# Prints the response body; returns 1 on a non-2xx status or an error payload.
mgmt_query() {
  local out http body
  out=$(mktemp)
  http=$(curl -sS -o "$out" -w '%{http_code}' \
    -X POST "https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query" \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    -H 'Content-Type: application/json' \
    --data-binary "$(printf '%s' "$1" | jq -Rs '{query: .}')") || { rm -f "$out"; return 1; }
  body=$(head -c 2000 "$out" 2>/dev/null || true)
  rm -f "$out"
  printf '%s' "$body"
  if [ "$http" != "200" ] && [ "$http" != "201" ]; then return 1; fi
  if printf '%s' "$body" | jq -e 'if type=="object" then has("error") or has("message") else false end' >/dev/null 2>&1; then
    return 1
  fi
  return 0
}

REC_OK=0
if [ "$RECORD" = "1" ]; then
  REC_FILE=$(basename -- "$ARG")
  if ! printf '%s' "$ARG" | grep -qE '^supabase/migrations/[^/]+\.sql$'; then
    echo "::warning::$ARG is not under supabase/migrations/ — applied but not recorded in schema_migrations"
  elif ! printf '%s' "$REC_FILE" | grep -qE '^[0-9]{8,14}_[A-Za-z0-9_.-]+\.sql$'; then
    echo "::warning::basename $REC_FILE does not match <digits>_<name>.sql — applied but not recorded in schema_migrations"
  elif [ "${REC_FILE#*\'}" != "$REC_FILE" ]; then
    # Redundant with the regex above on purpose: survives a later regex edit.
    echo "::warning::basename contains a quote — applied but not recorded in schema_migrations"
  elif ! printf '%s' "${RUN_ID:-}" | grep -qE '^[0-9]+$'; then
    echo "::warning::RUN_ID '${RUN_ID:-}' is not numeric — $REC_FILE applied but not recorded in schema_migrations"
  elif printf '%s' "$SQL_TEXT" | sed 's/--.*$//' | grep -qiE '\b(CONCURRENTLY|VACUUM)\b'; then
    echo "::warning::$REC_FILE uses CONCURRENTLY/VACUUM, which cannot share a request with the recording INSERT — applied but not recorded in schema_migrations"
  else
    REC_OK=1
    REC_VERSION=$(printf '%s' "$REC_FILE" | grep -oE '^[0-9]+')
    REC_NAME=${REC_FILE#"${REC_VERSION}_"}
    REC_NAME=${REC_NAME%.sql}
  fi
fi

if [ "$REC_OK" = "1" ]; then
  # Read-only. If it fails, nothing has been applied yet, so failing is safe.
  if ! PRE=$(mgmt_query "SELECT idempotency_key, name FROM supabase_migrations.schema_migrations WHERE version = '${REC_VERSION}'"); then
    echo "::error::schema_migrations pre-check failed — migration NOT applied:"
    echo "$PRE"
    exit 1
  fi
  if ! printf '%s' "$PRE" | jq -e 'type=="array"' >/dev/null 2>&1; then
    echo "::error::schema_migrations pre-check returned an unexpected body — migration NOT applied:"
    echo "$PRE"
    exit 1
  fi
  HELD=$(printf '%s' "$PRE" | jq -r --arg f "$REC_FILE" '[.[] | select(.idempotency_key != $f)] | first | if . == null then "" else (.name // "(no name)") end')
  if [ -n "$HELD" ]; then
    echo "::warning::version ${REC_VERSION} already recorded as ${HELD}; ${REC_FILE} applied but not recorded"
  else
    SQL_TEXT="${SQL_TEXT}
-- appended by apply-sql-via-management-api.sh --record-migration (VTID-05123)
;
DO \$record\$
BEGIN
  INSERT INTO supabase_migrations.schema_migrations (version, name, created_by, idempotency_key)
  VALUES ('${REC_VERSION}', '${REC_NAME}', 'github-actions:RUN-MIGRATION:${RUN_ID}', '${REC_FILE}')
  ON CONFLICT (idempotency_key) DO NOTHING;
EXCEPTION WHEN unique_violation THEN
  -- version PK taken by another file between the pre-check and now: never fail an applied migration
  RAISE WARNING 'schema_migrations: version % already held by another file; not recorded', '${REC_VERSION}';
END
\$record\$;"
    echo "Will record ${REC_FILE} in supabase_migrations.schema_migrations (version ${REC_VERSION})."
  fi
fi

# jq -Rs slurps raw stdin into a single correctly-escaped JSON string, which is
# the only safe way to embed arbitrary SQL (quotes, newlines, $$ bodies).
PAYLOAD=$(printf '%s' "$SQL_TEXT" | jq -Rs '{query: .}')

HTTP=$(curl -sS -o mgmt-response.json -w '%{http_code}' \
  -X POST "https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query" \
  -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data-binary "$PAYLOAD")

BODY=$(head -c 2000 mgmt-response.json 2>/dev/null || true)

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

if [ "$REC_OK" = "1" ]; then
  # Read-only. The migration already applied, so nothing here fails the run:
  # a red run would push people to re-run a migration that succeeded.
  if POST=$(mgmt_query "SELECT version FROM supabase_migrations.schema_migrations WHERE idempotency_key = '${REC_FILE}'"); then
    if printf '%s' "$POST" | jq -e 'type=="array" and length > 0' >/dev/null 2>&1; then
      echo "Recorded in supabase_migrations.schema_migrations: ${REC_FILE}"
    else
      HOLDER=$(mgmt_query "SELECT idempotency_key, name FROM supabase_migrations.schema_migrations WHERE version = '${REC_VERSION}'" || true)
      echo "::warning::${REC_FILE} applied but has no schema_migrations row; version ${REC_VERSION} is held by: ${HOLDER}"
    fi
  else
    echo "::warning::schema_migrations post-verify read failed; ${REC_FILE} applied, row not confirmed: ${POST}"
  fi
fi
