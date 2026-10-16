#!/usr/bin/env bash
# VTID-05162: runs the health_features_daily_v2 test against throwaway databases.
# Needs PG* env vars (or a local socket) pointing at a disposable Postgres.
# Refuses to run against anything that looks like Supabase or Aurora.
#
#   1. vtid-05162-health-features-v2.test.sql — an Aurora-shaped database
#      (roles, auth.uid() shim, an auth.users stub, NO storage.objects):
#      columns, unique keys, checks, service-role-only access, idempotency,
#      erase_user_data() discovery of B's four tables.
#   2. Placement guard — the migration must refuse a Supabase-shaped database
#      (auth.users AND storage.objects) and leave nothing behind; with
#      SET vitana.health_store_target = 'aurora' it applies.
set -euo pipefail
case "${PGHOST:-local}" in
  *supabase*|*amazonaws*|*rds*) echo "refusing: PGHOST=${PGHOST} is not a throwaway database" >&2; exit 2 ;;
esac
cd "$(dirname "$0")"
M=../../../supabase/migrations
V2=$M/20261014100700_vtid_05162_health_features_v2.sql
dbs=()
cleanup() { for d in "${dbs[@]}"; do dropdb --if-exists "$d"; done; }
trap cleanup EXIT
newdb() { local d="health_features_v2_test_$$_$1"; createdb "$d"; dbs+=("$d"); echo "$d"; }

PRE="do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end \$\$;
create schema if not exists auth;
create table auth.users (id uuid primary key);
create schema storage; create table storage.objects (id uuid primary key);"

# 1. Main test.
db=$(newdb main)
psql -X -q -v ON_ERROR_STOP=1 -d "$db" -f vtid-05162-health-features-v2.test.sql

# 2. Supabase-shaped database: refused, nothing created.
db=$(newdb supa)
psql -X -q -v ON_ERROR_STOP=1 -d "$db" -c "$PRE" >/dev/null
if out=$(psql -X -q -v ON_ERROR_STOP=1 -d "$db" -f "$V2" 2>&1); then
  echo "FAIL: health_features_v2 migration applied on a Supabase-shaped database" >&2; exit 1
fi
echo "$out" | grep -q 'VTID-05162 health store placement guard' || { echo "FAIL: unexpected error: $out" >&2; exit 1; }
psql -X -q -At -d "$db" -c "select count(*) from pg_class where relnamespace = 'public'::regnamespace and relname like 'health\_features%'" | grep -qx 0 \
  || { echo "FAIL: refused migration left objects behind" >&2; exit 1; }

# 2b. Same database with the explicit Aurora override: it applies.
PGOPTIONS='-c vitana.health_store_target=aurora' psql -X -q -v ON_ERROR_STOP=1 -d "$db" -c "set client_min_messages = warning" -f "$V2" >/dev/null
psql -X -q -At -d "$db" -c "select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relname in ('health_features_daily_v2','health_features_daily_legacy_shadow','health_features_derivation_pending')" | grep -qx 3 \
  || { echo "FAIL: migration did not apply with vitana.health_store_target = aurora" >&2; exit 1; }

echo 'PASS vtid-05162 placement guard'
