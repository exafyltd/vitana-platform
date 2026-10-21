#!/usr/bin/env bash
# VTID-05147 (Track S / S-M): reproduce the live member write exposure on the
# role/membership tables (fixture), prove it is real (a member can forge
# user_tenants.active_role, role_preferences and user_active_roles), then apply
# the S-M migration twice to a throwaway local Postgres and run the assertions.
# Same shape as test-vtid-05041-definer-lockdown.sh.
# Needs a local PostgreSQL server (initdb/pg_ctl), e.g. apt postgresql-16.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIXTURE="$ROOT/supabase/tests/vtid_05147_fixture.sql"
MIGRATION="${VTID_05147_MIGRATION:-$ROOT/supabase/migrations/20261013233000_vtid_05147_s_m_membership_role_lockdown.sql}"
TESTS="$ROOT/supabase/tests/vtid_05147_s_m_lockdown.test.sql"

PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "$PGBIN/initdb" ] || { echo "initdb not found (set PGBIN)"; exit 2; }

WORK="$(mktemp -d)"
RUN_AS=()
if [ "$(id -u)" = "0" ]; then
  chown postgres "$WORK"
  RUN_AS=(sudo -u postgres)
fi
PORT="${PGPORT_TEST:-55447}"
cleanup() { "${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

# Copy the inputs next to the cluster so the postgres user can read them
# wherever the checkout lives.
for f in "$FIXTURE" "$MIGRATION" "$TESTS"; do cp "$f" "$WORK/"; done
FIXTURE="$WORK/$(basename "$FIXTURE")"; MIGRATION="$WORK/$(basename "$MIGRATION")"; TESTS="$WORK/$(basename "$TESTS")"
[ "$(id -u)" = "0" ] && chown postgres "$WORK"/*.sql

"${RUN_AS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
"${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -w start >/dev/null

PSQL=("${RUN_AS[@]}" psql -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d postgres)
"${PSQL[@]}" -f "$FIXTURE"

# Precondition: the fixture reproduces the live hole. Run as member M inside a
# transaction that is rolled back, so the assertions start from clean data.
"${PSQL[@]}" <<'SQL'
\o /dev/null
BEGIN;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000aa01","role":"authenticated","app_metadata":{"active_tenant_id":"0000000a-0000-0000-0000-000000005147"}}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE n int;
BEGIN
  UPDATE public.user_tenants SET active_role = 'admin' WHERE user_id = auth.uid();
  GET DIAGNOSTICS n = ROW_COUNT;
  ASSERT n = 1, 'precondition: a member can set own user_tenants.active_role = admin (live exposure reproduced)';
  INSERT INTO public.role_preferences (user_id, tenant_id, role)
  VALUES (auth.uid(), '0000000b-0000-0000-0000-000000005147', 'developer');
  INSERT INTO public.user_active_roles (user_id, active_role) VALUES (auth.uid(), 'developer')
  ON CONFLICT (user_id) DO UPDATE SET active_role = 'developer';
  ASSERT (public.me_context() ->> 'active_role') = 'developer', 'precondition: me_context serves the forged role';
  PERFORM public.set_role_preference('0000000b-0000-0000-0000-000000005147', 'community');
END $$;
ROLLBACK;
SQL
echo 'precondition: member forged active_role/role_preferences/user_active_roles before the migration'

"${PSQL[@]}" -f "$MIGRATION"
"${PSQL[@]}" -f "$MIGRATION"
echo 'migration applied twice (self-check passed both times)'
"${PSQL[@]}" -f "$TESTS"
