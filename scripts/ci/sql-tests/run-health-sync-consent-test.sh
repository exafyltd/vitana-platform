#!/usr/bin/env bash
# VTID-05164: runs the Health Sync consent keys migration test against throwaway databases.
# Needs PG* env vars (or a local socket) pointing at a disposable Postgres.
# Refuses to run against anything that looks like Supabase or Aurora.
#
#   1. vtid-05164-health-sync-consent.test.sql — catalogue rows, connector rows,
#      category and granted_via CHECK supersets, fn_set_health_consent, privileges,
#      the VTID-05156 revoke in place, idempotency.
#   2. Without VTID-05092 the migration refuses to apply and leaves nothing behind.
set -euo pipefail
case "${PGHOST:-local}" in
  *supabase*|*amazonaws*|*rds*) echo "refusing: PGHOST=${PGHOST} is not a throwaway database" >&2; exit 2 ;;
esac
cd "$(dirname "$0")"
M=../../../supabase/migrations
MIGRATION=$M/20261014130000_vtid_05164_health_sync_consent_keys.sql
dbs=()
cleanup() { for d in "${dbs[@]}"; do dropdb --if-exists "$d"; done; }
trap cleanup EXIT
newdb() { local d="health_sync_consent_test_$$_$1"; createdb "$d"; dbs+=("$d"); echo "$d"; }

# 1. Main test.
db=$(newdb main)
psql -X -q -v ON_ERROR_STOP=1 -d "$db" -f vtid-05164-health-sync-consent.test.sql

# 2. Prerequisite guard: connector framework present, VTID-05092 absent.
db=$(newdb noprereq)
psql -X -q -v ON_ERROR_STOP=1 -d "$db" -c "set client_min_messages = warning" \
  -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if; if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if; if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if; end \$\$;" \
  -c "create schema if not exists auth; create or replace function auth.uid() returns uuid language sql stable as 'select null::uuid';" \
  -f "$M/20260417000000_vtid_02100_connector_framework.sql" >/dev/null
if out=$(psql -X -q -v ON_ERROR_STOP=1 -d "$db" -f "$MIGRATION" 2>&1); then
  echo "FAIL: VTID-05164 migration applied without VTID-05092" >&2; exit 1
fi
echo "$out" | grep -q 'VTID-05164: apply 20261012180000_vtid_05092_health_consent_categories.sql first' || { echo "FAIL: unexpected error: $out" >&2; exit 1; }
psql -X -q -At -d "$db" -c "select count(*) from public.connector_registry where id in ('apple_health','health_connect')" | grep -qx 0 \
  || { echo "FAIL: refused migration left rows behind" >&2; exit 1; }
psql -X -q -At -d "$db" -c "select count(*) from pg_constraint where conrelid = 'public.connector_registry'::regclass and pg_get_constraintdef(oid) ilike '%health_store%'" | grep -qx 0 \
  || { echo "FAIL: refused migration changed the category check" >&2; exit 1; }
echo 'PASS vtid-05164 prerequisite guard'
