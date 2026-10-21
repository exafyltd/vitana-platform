#!/usr/bin/env bash
# VTID-05151: apply the public tenant registry and the legacy landing seed (each twice) to a
# throwaway local Postgres with the live tenants/tenant_settings shape, prove both rollbacks
# work and re-apply, then run the SQL assertions (anon access, whitelist, exact resolution,
# forward compatibility with lanes A/B).
# Needs a local PostgreSQL server (initdb/pg_ctl), e.g. apt postgresql-16.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIXTURE="$ROOT/supabase/tests/vtid_05151_fixture.sql"
REGISTRY="$ROOT/supabase/migrations/20261014000600_vtid_05151_public_tenant_registry.sql"
SEED="$ROOT/supabase/migrations/20261014000700_vtid_05151_seed_legacy_tenant_landing.sql"
RB_REGISTRY="$ROOT/docs/validation/VTID-05151/rollback-registry.sql"
RB_SEED="$ROOT/docs/validation/VTID-05151/rollback-seed.sql"
TESTS="$ROOT/supabase/tests/vtid_05151_public_tenant_registry.test.sql"

PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "$PGBIN/initdb" ] || { echo "initdb not found (set PGBIN)"; exit 2; }

WORK="$(mktemp -d)"
RUN_AS=()
if [ "$(id -u)" = "0" ]; then
  chown postgres "$WORK"
  RUN_AS=(sudo -u postgres)
fi
PORT="${PGPORT_TEST:-55451}"
cleanup() { "${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

for f in "$FIXTURE" "$REGISTRY" "$SEED" "$RB_REGISTRY" "$RB_SEED" "$TESTS"; do cp "$f" "$WORK/"; done
FIXTURE="$WORK/$(basename "$FIXTURE")"; REGISTRY="$WORK/$(basename "$REGISTRY")"; SEED="$WORK/$(basename "$SEED")"
RB_REGISTRY="$WORK/$(basename "$RB_REGISTRY")"; RB_SEED="$WORK/$(basename "$RB_SEED")"; TESTS="$WORK/$(basename "$TESTS")"
[ "$(id -u)" = "0" ] && chown postgres "$WORK"/*.sql

"${RUN_AS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
"${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -w start >/dev/null

PSQL=("${RUN_AS[@]}" psql -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d postgres)
"${PSQL[@]}" -f "$FIXTURE"

# The seed's own end-state check reads the registry, so applying it first must fail and roll back.
if "${PSQL[@]}" -f "$SEED" >"$WORK/order.log" 2>&1; then
  echo "seed applied without the registry functions"; exit 1
fi
"${PSQL[@]}" -c "DO \$\$ BEGIN
  ASSERT (SELECT profile FROM public.tenant_settings WHERE tenant_id = '11111111-0000-0000-0000-000000000002') = '{}'::jsonb, 'refused seed rolled back';
  ASSERT to_regclass('legacy_archive.bak_vtid_05151_tenant_settings') IS NULL, 'refused seed left no snapshot';
END \$\$;"
echo 'order guard: seed refused before the registry and rolled back'

"${PSQL[@]}" -f "$REGISTRY"
"${PSQL[@]}" -f "$REGISTRY"
"${PSQL[@]}" -f "$SEED"
SNAP1="$("${PSQL[@]}" -At -c "SELECT md5(string_agg(profile::text || branding::text, ',' ORDER BY tenant_id)) FROM public.tenant_settings")"
"${PSQL[@]}" -f "$SEED"
SNAP2="$("${PSQL[@]}" -At -c "SELECT md5(string_agg(profile::text || branding::text, ',' ORDER BY tenant_id)) FROM public.tenant_settings")"
[ "$SNAP1" = "$SNAP2" ] || { echo "seed is not idempotent"; exit 1; }
echo 'idempotent: second registry and seed apply changed nothing'

# Rollbacks restore the pre-seed state and drop the functions; then re-apply.
"${PSQL[@]}" -f "$RB_SEED"
"${PSQL[@]}" -c "DO \$\$ BEGIN
  ASSERT (SELECT profile FROM public.tenant_settings WHERE tenant_id = '11111111-0000-0000-0000-000000000002') = '{}'::jsonb, 'alkalma profile restored';
  ASSERT (SELECT branding FROM public.tenant_settings WHERE tenant_id = '11111111-0000-0000-0000-000000000002') = '{}'::jsonb, 'alkalma branding restored';
  ASSERT NOT (SELECT profile ? 'landing' FROM public.tenant_settings WHERE tenant_id = '11111111-0000-0000-0000-000000000001'), 'maxina landing removed';
END \$\$;"
"${PSQL[@]}" -f "$RB_REGISTRY"
"${PSQL[@]}" -c "DROP TABLE legacy_archive.bak_vtid_05151_tenant_settings;"
echo 'rollback: seed restored, functions dropped'

"${PSQL[@]}" -f "$REGISTRY"
"${PSQL[@]}" -f "$SEED"
"${PSQL[@]}" -f "$TESTS"
