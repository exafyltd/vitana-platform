#!/usr/bin/env bash
# VTID-04933: per-offering keep offline / allow listing against the VTID-04769
# go-live gate, on a throwaway database. Needs PG* env vars (or a local socket)
# pointing at a disposable Postgres. Refuses anything that looks like Supabase or Aurora.
set -euo pipefail
case "${PGHOST:-local}" in
  *supabase*|*amazonaws*|*rds*) echo "refusing: PGHOST=${PGHOST} is not a throwaway database" >&2; exit 2 ;;
esac
cd "$(dirname "$0")"
d="partner_review_test_$$"
createdb "$d"
trap 'dropdb --if-exists "$d"' EXIT
psql -X -q -v ON_ERROR_STOP=1 -d "$d" -f vtid-04933-keep-offline.test.sql
