#!/usr/bin/env bash
# VTID-05092: runs the health consent categories migration test against a throwaway database.
# Needs PG* env vars (or a local socket) pointing at a disposable Postgres.
# Refuses to run against anything that looks like Supabase or Aurora.
set -euo pipefail
case "${PGHOST:-local}" in
  *supabase*|*amazonaws*|*rds*) echo "refusing: PGHOST=${PGHOST} is not a throwaway database" >&2; exit 2 ;;
esac
cd "$(dirname "$0")"
db="health_consent_test_$$"
trap 'dropdb --if-exists "$db"' EXIT
createdb "$db"
psql -X -q -v ON_ERROR_STOP=1 -d "$db" -f vtid-05092-health-consent.test.sql
