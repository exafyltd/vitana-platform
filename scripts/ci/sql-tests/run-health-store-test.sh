#!/usr/bin/env bash
# VTID-05158: runs the health store test against throwaway databases.
# Needs PG* env vars (or a local socket) pointing at a disposable Postgres.
# Refuses to run against anything that looks like Supabase or Aurora.
#
#   1. vtid-05158-health-store.test.sql — an Aurora-shaped database (no
#      auth.users, no storage.objects): partitions, ingest, rollups, purge,
#      suppression, erase_user_data() across partitions, RLS, grants.
#   2. Placement guard — the migration must refuse a Supabase-shaped database
#      (auth.users AND storage.objects), must apply with an auth.users stub
#      alone, and must apply on a Supabase-shaped one only with
#      SET vitana.health_store_target = 'aurora'.
set -euo pipefail
case "${PGHOST:-local}" in
  *supabase*|*amazonaws*|*rds*) echo "refusing: PGHOST=${PGHOST} is not a throwaway database" >&2; exit 2 ;;
esac
cd "$(dirname "$0")"
MIGRATION=../../../supabase/migrations/20261014100100_vtid_05158_health_store.sql
dbs=()
cleanup() { for d in "${dbs[@]}"; do dropdb --if-exists "$d"; done; }
trap cleanup EXIT
newdb() { local d="health_store_test_$$_$1"; createdb "$d"; dbs+=("$d"); echo "$d"; }

PRE="do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end \$\$;
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as \$f\$ select null::uuid \$f\$;"

# 1. Main test.
db=$(newdb main)
psql -X -q -v ON_ERROR_STOP=1 -d "$db" -f vtid-05158-health-store.test.sql

# 2a. An auth.users stub alone does not trip the guard.
db=$(newdb stub)
psql -X -q -v ON_ERROR_STOP=1 -d "$db" -c "$PRE" -c "create table auth.users (id uuid primary key);" >/dev/null
psql -X -q -v ON_ERROR_STOP=1 -d "$db" -c "set client_min_messages = warning" -f "$MIGRATION" >/dev/null
psql -X -q -At -d "$db" -c "select to_regclass('public.health_series_5m') is not null" | grep -qx t \
  || { echo "FAIL: migration did not apply with an auth.users stub alone" >&2; exit 1; }

# 2b. auth.users + storage.objects (Supabase): refused, nothing created.
db=$(newdb supa)
psql -X -q -v ON_ERROR_STOP=1 -d "$db" -c "$PRE" -c "create table auth.users (id uuid primary key); create schema storage; create table storage.objects (id uuid primary key);" >/dev/null
if out=$(psql -X -q -v ON_ERROR_STOP=1 -d "$db" -f "$MIGRATION" 2>&1); then
  echo "FAIL: migration applied on a Supabase-shaped database" >&2; exit 1
fi
echo "$out" | grep -q 'health store placement guard' || { echo "FAIL: unexpected error: $out" >&2; exit 1; }
psql -X -q -At -d "$db" -c "select count(*) from pg_class where relnamespace = 'public'::regnamespace and relname like 'health\_%'" | grep -qx 0 \
  || { echo "FAIL: refused migration left objects behind" >&2; exit 1; }

# 2c. Same database with the explicit Aurora override: applies.
PGOPTIONS='-c vitana.health_store_target=aurora' psql -X -q -v ON_ERROR_STOP=1 -d "$db" -c "set client_min_messages = warning" -f "$MIGRATION" >/dev/null
psql -X -q -At -d "$db" -c "select to_regclass('public.health_series_5m') is not null" | grep -qx t \
  || { echo "FAIL: migration did not apply with vitana.health_store_target = aurora" >&2; exit 1; }

echo 'PASS vtid-05158 placement guard'
