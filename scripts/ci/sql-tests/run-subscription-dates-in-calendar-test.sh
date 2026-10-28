#!/usr/bin/env bash
# VTID-04994: runs the subscription dates -> calendar mirror test against a throwaway database.
# Needs PG* env vars (or a local socket) pointing at a disposable Postgres.
# Refuses to run against anything that looks like Supabase or Aurora.
set -euo pipefail
case "${PGHOST:-local}" in
  *supabase*|*amazonaws*|*rds*) echo "refusing: PGHOST=${PGHOST} is not a throwaway database" >&2; exit 2 ;;
esac
cd "$(dirname "$0")"
db="subscription_calendar_test_$$"
createdb "$db"
trap 'dropdb --if-exists "$db"' EXIT
psql -X -q -v ON_ERROR_STOP=1 -d "$db" -f vtid-04994-subscription-dates-in-calendar.test.sql
