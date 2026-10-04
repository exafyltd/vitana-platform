#!/usr/bin/env bash
# VTID-04868: Plan Sparring Gate DB foundation. On a throwaway local Postgres
# that reproduces vtid_ledger + the current 3-arg allocator, apply the
# migration and the hardening migration twice each, run the gate assertions
# (log + enforce modes, plan-hash binding, collision-skipping allocator,
# round-append conflicts), then apply the rollback and check the 3-arg
# allocator is back and the gate is gone.
# Needs a local PostgreSQL server (initdb/pg_ctl), e.g. apt postgresql-16.
# Never points at a live database.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PRIOR="$ROOT/supabase/migrations/20260628120000_fix_allocate_global_vtid_seq_drift.sql"
MIGRATION="$ROOT/supabase/migrations/20261004110000_vtid_04868_plan_sparring_gate.sql"
HARDENING="$ROOT/supabase/migrations/20261004120000_vtid_04868_plan_sparring_hardening.sql"
FIXTURE="$ROOT/supabase/tests/vtid_04868_fixture.sql"
TESTS="$ROOT/supabase/tests/vtid_04868_plan_sparring_gate.test.sql"
ROLLBACK="$ROOT/docs/validation/VTID-04868/rollback.sql"

PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "$PGBIN/initdb" ] || { echo "initdb not found (set PGBIN)"; exit 2; }

WORK="$(mktemp -d)"
RUN_AS=()
if [ "$(id -u)" = "0" ]; then
  chown postgres "$WORK"
  chmod o+r "$MIGRATION" "$HARDENING" "$FIXTURE" "$TESTS" "$ROLLBACK" "$PRIOR" 2>/dev/null || true
  RUN_AS=(sudo -u postgres)
fi
PORT="${PGPORT_TEST:-55436}"
cleanup() { "${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

"${RUN_AS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
"${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -w start >/dev/null

PSQL=("${RUN_AS[@]}" psql -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d postgres)
"${PSQL[@]}" -f "$FIXTURE"
"${PSQL[@]}" -f "$PRIOR" 2>/dev/null
"${PSQL[@]}" -f "$MIGRATION"
"${PSQL[@]}" -f "$HARDENING"
"${PSQL[@]}" -f "$MIGRATION"
"${PSQL[@]}" -f "$HARDENING"
OUT="$WORK/tests.out"
if ! "${PSQL[@]}" -v migration="$MIGRATION" -v hardening="$HARDENING" -f "$TESTS" >"$OUT" 2>&1; then
  cat "$OUT"; exit 1
fi
# B11 deliberately breaks the gate in log mode; its WARNING is expected.
grep -c 'WARNING:  plan_sparring_gate: evaluation failed' "$OUT" | grep -qx 1 \
  || { echo "expected exactly one log-mode gate WARNING (B11)"; cat "$OUT"; exit 1; }
grep -v 'plan_sparring_gate: evaluation failed' "$OUT" || true

# Rollback: 3-arg back, gate gone, ledger inserts unaffected, tables kept.
"${PSQL[@]}" -f "$ROLLBACK"
"${PSQL[@]}" -c "
DO \$\$ DECLARE r record; n int; BEGIN
  ASSERT to_regprocedure('public.allocate_global_vtid(text,text,text)') IS NOT NULL, 'rollback: 3-arg back';
  ASSERT to_regprocedure('public.allocate_global_vtid(text,text,text,uuid)') IS NULL, 'rollback: 4-arg gone';
  ASSERT to_regprocedure('public.allocate_global_vtid(text,text,text,uuid,text)') IS NULL, 'rollback: 5-arg gone';
  ASSERT to_regprocedure('public.plan_sparring_append_round(uuid,jsonb,int)') IS NULL, 'rollback: 3-arg append gone';
  ASSERT to_regprocedure('public.plan_sparring_append_round(uuid,jsonb)') IS NULL, 'rollback: 2-arg append gone';
  ASSERT NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_plan_sparring_check'), 'rollback: trigger gone';
  ASSERT to_regclass('public.vtid_ledger_sparring_id_unique') IS NULL, 'rollback: index gone';
  ASSERT has_function_privilege('service_role', 'public.allocate_global_vtid(text,text,text)', 'EXECUTE'), 'rollback: service_role grant';
  ASSERT NOT has_function_privilege('anon', 'public.allocate_global_vtid(text,text,text)', 'EXECUTE'), 'rollback: anon revoked';
  n := (SELECT count(*) FROM plan_sparring_shadow_log);
  SELECT * INTO r FROM allocate_global_vtid('claude-code', 'DEV', 'TASK');
  ASSERT r.vtid ~ '^VTID-', 'rollback: allocation works';
  ASSERT (SELECT count(*) FROM plan_sparring_shadow_log) = n, 'rollback: gate no longer logs';
END \$\$;"
# And both migrations re-apply cleanly on top of the rollback.
"${PSQL[@]}" -f "$MIGRATION"
"${PSQL[@]}" -f "$HARDENING"
"${PSQL[@]}" -c "DO \$\$ BEGIN
  ASSERT to_regprocedure('public.allocate_global_vtid(text,text,text)') IS NULL AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_plan_sparring_check'), 're-apply after rollback';
  ASSERT to_regprocedure('public.allocate_global_vtid(text,text,text,uuid)') IS NULL, 're-apply: 4-arg gone';
  ASSERT to_regprocedure('public.allocate_global_vtid(text,text,text,uuid,text)') IS NOT NULL, 're-apply: 5-arg present';
  ASSERT to_regprocedure('public.plan_sparring_append_round(uuid,jsonb)') IS NULL, 're-apply: 2-arg append gone';
  ASSERT to_regprocedure('public.plan_sparring_append_round(uuid,jsonb,int)') IS NOT NULL, 're-apply: 3-arg append present';
END \$\$;"
echo 'VTID-04868: rollback + re-apply passed'
