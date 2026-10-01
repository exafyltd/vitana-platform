#!/usr/bin/env bash
# VTID-04765: runs the erase_user_data() test against a throwaway database.
# Needs PG* env vars (or a local socket) pointing at a disposable Postgres.
# Refuses to run against anything that looks like Supabase or Aurora.
set -euo pipefail
case "${PGHOST:-local}" in
  *supabase*|*amazonaws*|*rds*) echo "refusing: PGHOST=${PGHOST} is not a throwaway database" >&2; exit 2 ;;
esac
db="erase_test_$$"
createdb "$db"
trap 'dropdb --if-exists "$db"' EXIT
cd "$(dirname "$0")"
psql -X -q -v ON_ERROR_STOP=1 -d "$db" -f vtid-04765-erase-user-data.test.sql
