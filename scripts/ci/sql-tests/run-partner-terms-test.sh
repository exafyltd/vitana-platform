#!/usr/bin/env bash
# VTID-04895 / VTID-04909: runs the partner terms migration tests against throwaway databases.
# Needs PG* env vars (or a local socket) pointing at a disposable Postgres.
# Refuses to run against anything that looks like Supabase or Aurora.
set -euo pipefail
case "${PGHOST:-local}" in
  *supabase*|*amazonaws*|*rds*) echo "refusing: PGHOST=${PGHOST} is not a throwaway database" >&2; exit 2 ;;
esac
cd "$(dirname "$0")"
dbs=()
trap 'for d in "${dbs[@]}"; do dropdb --if-exists "$d"; done' EXIT
fresh() { local d="partner_terms_test_$1_$$"; createdb "$d"; dbs+=("$d"); echo "$d"; }

# VTID-04895 lifecycle (English rules as written then).
psql -X -q -v ON_ERROR_STOP=1 -d "$(fresh lifecycle)" -f vtid-04895-partner-terms.test.sql

# VTID-04909 German binding on top of it.
psql -X -q -v ON_ERROR_STOP=1 -d "$(fresh german)" -f vtid-04909-partner-terms-german.test.sql

# VTID-04909 guard: with a row present, the migration must refuse and change nothing.
g="$(fresh guard)"
if out=$(psql -X -q -v ON_ERROR_STOP=1 -d "$g" -f vtid-04909-partner-terms-guard.test.sql 2>&1); then
  echo "$out"; echo "FAIL: the VTID-04909 migration ran on a non-empty partner_terms_versions" >&2; exit 1
fi
echo "$out" | grep -q 'GUARD-SETUP-DONE' || { echo "$out"; echo "FAIL: guard setup did not complete" >&2; exit 1; }
echo "$out" | grep -q 'VTID-04909 refused: partner terms must be empty (versions=1, acceptances=0)' || { echo "$out"; echo "FAIL: wrong refusal" >&2; exit 1; }
[ "$(psql -X -qtA -d "$g" -c "select binding_locale || ':' || (select pg_get_constraintdef(oid) like '%''en''%' from pg_constraint where conname='partner_terms_versions_binding_locale_check') from public.partner_terms_versions")" = "en:true" ] \
  || { echo "FAIL: the refused migration changed something" >&2; exit 1; }
echo 'PASS vtid-04909 migration refuses unless empty'
