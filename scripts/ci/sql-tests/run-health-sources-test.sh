#!/usr/bin/env bash
# VTID-05161: runs the health_sources test against throwaway databases.
# Needs PG* env vars (or a local socket) pointing at a disposable Postgres.
# Refuses to run against anything that looks like Supabase or Aurora.
#
#   1. vtid-05161-health-sources.test.sql — an Aurora-shaped database (roles,
#      auth.uid() shim, an auth.users stub, NO storage.objects): table, backfill,
#      idempotency, connector FK, RLS, reconcile counts, erase_user_data()
#      discovery, and the user_integrations browser-write revoke.
#   2. Placement guard — the health_sources migration must refuse a
#      Supabase-shaped database (auth.users AND storage.objects) and leave
#      nothing behind; with SET vitana.health_store_target = 'aurora' it applies.
#      The user_integrations revoke migration (Supabase target) applies there.
set -euo pipefail
case "${PGHOST:-local}" in
  *supabase*|*amazonaws*|*rds*) echo "refusing: PGHOST=${PGHOST} is not a throwaway database" >&2; exit 2 ;;
esac
cd "$(dirname "$0")"
M=../../../supabase/migrations
SOURCES=$M/20261014100200_vtid_05161_health_sources.sql
REVOKE=$M/20261014100300_vtid_05161_user_integrations_revoke_browser_writes.sql
dbs=()
cleanup() { for d in "${dbs[@]}"; do dropdb --if-exists "$d"; done; }
trap cleanup EXIT
newdb() { local d="health_sources_test_$$_$1"; createdb "$d"; dbs+=("$d"); echo "$d"; }

PRE="do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end \$\$;
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as \$f\$ select null::uuid \$f\$;
create table auth.users (id uuid primary key);
create schema storage; create table storage.objects (id uuid primary key);
create or replace function public.upsert_knowledge_doc(p_title text, p_path text, p_source_type text, p_tags text[], p_content text) returns uuid language sql as \$f\$ select null::uuid \$f\$;
create table public.user_tenants (tenant_id uuid not null, user_id uuid not null, is_primary boolean not null default false, created_at timestamptz not null default now());"

# 1. Main test.
db=$(newdb main)
psql -X -q -v ON_ERROR_STOP=1 -d "$db" -f vtid-05161-health-sources.test.sql

# 2. Supabase-shaped database: health_sources refused, nothing created.
db=$(newdb supa)
psql -X -q -v ON_ERROR_STOP=1 -d "$db" -c "$PRE" >/dev/null
for f in 20260417000000_vtid_02100_connector_framework.sql 20260417000100_vtid_02100_connector_registry_seed.sql \
         20260417010000_vtid_02100_connector_registry_update.sql 20260423200000_vitana_integrations_v1.sql; do
  psql -X -q -v ON_ERROR_STOP=1 -d "$db" -c "set client_min_messages = warning" -f "$M/$f" >/dev/null
done
if out=$(psql -X -q -v ON_ERROR_STOP=1 -d "$db" -f "$SOURCES" 2>&1); then
  echo "FAIL: health_sources migration applied on a Supabase-shaped database" >&2; exit 1
fi
echo "$out" | grep -q 'VTID-05161 health store placement guard' || { echo "FAIL: unexpected error: $out" >&2; exit 1; }
psql -X -q -At -d "$db" -c "select count(*) from pg_class where relnamespace = 'public'::regnamespace and relname like 'health\_sources%'" | grep -qx 0 \
  || { echo "FAIL: refused migration left objects behind" >&2; exit 1; }

# 2b. The Supabase-target revoke migration applies there (twice).
psql -X -q -v ON_ERROR_STOP=1 -d "$db" -c "set client_min_messages = warning" -f "$REVOKE" >/dev/null
psql -X -q -v ON_ERROR_STOP=1 -d "$db" -c "set client_min_messages = warning" -f "$REVOKE" >/dev/null
psql -X -q -At -d "$db" -c "select has_table_privilege('authenticated','public.user_integrations','INSERT')" | grep -qx f \
  || { echo "FAIL: revoke migration did not remove the browser INSERT grant" >&2; exit 1; }

# 2c. Same database with the explicit Aurora override: health_sources applies.
PGOPTIONS='-c vitana.health_store_target=aurora' psql -X -q -v ON_ERROR_STOP=1 -d "$db" -c "set client_min_messages = warning" -f "$SOURCES" >/dev/null
psql -X -q -At -d "$db" -c "select to_regclass('public.health_sources') is not null" | grep -qx t \
  || { echo "FAIL: migration did not apply with vitana.health_store_target = aurora" >&2; exit 1; }

echo 'PASS vtid-05161 placement guard'
