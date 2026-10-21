#!/usr/bin/env bash
# VTID-05150: tenant brand pack + provision_tenant() on a throwaway local
# PostgreSQL. Database 1: fixture (live shapes) → Lane A M1 (the real
# 20261014000100 file when it is in the checkout, else the stand-in) → both
# VTID-05150 migrations, each applied twice → the SQL assertions → rollback.sql
# (must STOP before dropping columns: tenants were provisioned) →
# rollback-complete.sql. Database 2: the M2 order guard (refuses without Lane A
# M1), then both migrations → rollback.sql drops everything (no provisioned
# tenant) → re-apply works.
# Needs a local PostgreSQL server (initdb/pg_ctl), e.g. apt postgresql-16.
# Refuses any remote host: it only ever talks to the cluster it starts.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
T="$ROOT/supabase/tests"
FIXTURE="$T/vtid_05150_fixture.sql"
AFTER_A="$T/vtid_05150_fixture_after_a.sql"
A_M1="${VTID_05150_LANE_A_M1:-$(ls "$ROOT"/supabase/migrations/20261014000100_*.sql 2>/dev/null | head -1 || true)}"
[ -n "$A_M1" ] || A_M1="$T/vtid_05150_lane_a_m1_standin.sql"
M1="$ROOT/supabase/migrations/20261014000400_vtid_05150_tenant_brand_pack.sql"
M2="$ROOT/supabase/migrations/20261014000500_vtid_05150_provision_tenant.sql"
TESTS="$T/vtid_05150_provision_tenant.test.sql"
RB="$ROOT/docs/validation/VTID-05150/rollback.sql"
RBC="$ROOT/docs/validation/VTID-05150/rollback-complete.sql"

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

# Copy the inputs next to the cluster so the postgres user can read them.
for f in "$FIXTURE" "$AFTER_A" "$A_M1" "$M1" "$M2" "$TESTS" "$RB" "$RBC"; do cp "$f" "$WORK/"; done
w() { echo "$WORK/$(basename "$1")"; }
[ "$(id -u)" = "0" ] && chown postgres "$WORK"/*.sql
echo "lane A M1: $(basename "$A_M1")"

"${RUN_AS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
"${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -w start >/dev/null

PSQL=("${RUN_AS[@]}" psql -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres)
"${PSQL[@]}" -d postgres -c 'CREATE DATABASE t1' -c 'CREATE DATABASE t2'

# ── database 1: full run ─────────────────────────────────────────────────
P1=("${PSQL[@]}" -d t1)
"${P1[@]}" -f "$(w "$FIXTURE")"
"${P1[@]}" -f "$(w "$A_M1")"
"${P1[@]}" -f "$(w "$AFTER_A")"
"${P1[@]}" -f "$(w "$M1")"
"${P1[@]}" -f "$(w "$M1")"
"${P1[@]}" -f "$(w "$M2")"
"${P1[@]}" -f "$(w "$M2")"
echo 'migrations: both applied twice'
"${P1[@]}" -f "$(w "$TESTS")" >"$WORK/tests.log" 2>&1 || { cat "$WORK/tests.log"; exit 1; }
sed -n 's/^.*NOTICE:  //p; /all assertions passed/p' "$WORK/tests.log"

"${P1[@]}" -f "$(w "$RB")" 2>"$WORK/rb1.log"
grep -q 'STOPPED before dropping columns' "$WORK/rb1.log" || { cat "$WORK/rb1.log"; exit 1; }
"${P1[@]}" -c "DO \$\$ BEGIN
  ASSERT to_regprocedure('public.provision_tenant(text,text,text,uuid,text,text,numeric,text,text[],text,text)') IS NULL, 'function dropped';
  ASSERT to_regclass('public.reserved_tenant_slugs') IS NULL, 'reserved table dropped';
  ASSERT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tenant_settings' AND column_name='display_name'), 'columns kept';
  ASSERT (SELECT count(*) FROM public.bak_vtid_05150_tenant_settings WHERE provisioned_at IS NOT NULL) = 2, 'backup holds both provisioned packs';
END \$\$;"
echo 'rollback: stopped before dropping columns (2 provisioned tenants backed up)'
"${P1[@]}" -f "$(w "$RBC")"
"${P1[@]}" -c "DO \$\$ BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tenant_settings'
    AND column_name IN ('display_name','brand','provisioned_at','persona_facts','enabled_locales')), 'columns dropped';
  ASSERT to_regclass('public.bak_vtid_05150_tenant_settings') IS NOT NULL, 'backup kept';
END \$\$;"
echo 'rollback-complete: columns dropped, backup kept'

# ── database 2: order guard + clean rollback ─────────────────────────────
P2=("${PSQL[@]}" -d t2)
"${P2[@]}" -f "$(w "$FIXTURE")"
"${P2[@]}" -f "$(w "$M1")"
if "${P2[@]}" -f "$(w "$M2")" >"$WORK/order.log" 2>&1; then
  echo "provision_tenant applied without Lane A M1"; exit 1
fi
grep -q 'apply Lane A M1' "$WORK/order.log" || { cat "$WORK/order.log"; exit 1; }
"${P2[@]}" -c "DO \$\$ BEGIN ASSERT to_regprocedure('public.provision_tenant(text,text,text,uuid,text,text,numeric,text,text[],text,text)') IS NULL, 'refused apply left no function'; END \$\$;"
echo 'order guard: M2 refused before Lane A M1 and left nothing behind'
"${P2[@]}" -f "$(w "$A_M1")"
"${P2[@]}" -f "$(w "$M2")"
"${P2[@]}" -c 'SELECT md5(string_agg(row_to_json(s)::text, $$|$$ ORDER BY tenant_id)) FROM (SELECT tenant_id, profile, branding, feature_flags, integrations, domains, billing, updated_at, updated_by FROM public.tenant_settings) s' -At > "$WORK/before.md5"
"${P2[@]}" -f "$(w "$RB")" 2>"$WORK/rb2.log"
grep -q 'rollback: complete' "$WORK/rb2.log" || { cat "$WORK/rb2.log"; exit 1; }
"${P2[@]}" -c 'SELECT md5(string_agg(row_to_json(s)::text, $$|$$ ORDER BY tenant_id)) FROM (SELECT * FROM public.tenant_settings) s' -At > "$WORK/after.md5"
cmp -s "$WORK/before.md5" "$WORK/after.md5" || { echo 'rollback changed the pre-existing tenant_settings columns'; exit 1; }
echo 'rollback (no provisioned tenant): everything dropped, pre-existing settings byte-identical'
"${P2[@]}" -f "$(w "$M1")"
"${P2[@]}" -f "$(w "$M2")"
echo 're-apply after rollback: ok'
echo 'VTID-05150: harness passed'
