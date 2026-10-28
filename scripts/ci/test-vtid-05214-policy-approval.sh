#!/usr/bin/env bash
# VTID-05214: policy approval of converged plans + Project Manager tables. On a throwaway local Postgres that
# reproduces vtid_ledger and the VTID-04868 gate, apply the VTID-05214 migration twice, run the assertions, then the
# rollback (gate back to owner-only approval) and re-apply. Needs initdb/pg_ctl. Never points at a live database.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PRIOR="$ROOT/supabase/migrations/20260628120000_fix_allocate_global_vtid_seq_drift.sql"
G1="$ROOT/supabase/migrations/20261004110000_vtid_04868_plan_sparring_gate.sql"
G2="$ROOT/supabase/migrations/20261004120000_vtid_04868_plan_sparring_hardening.sql"
MIG="$ROOT/supabase/migrations/20261015180000_vtid_05214_plan_sparring_policy_approval.sql"
FIXTURE="$ROOT/supabase/tests/vtid_04868_fixture.sql"
TESTS="$ROOT/supabase/tests/vtid_05214_policy_approval.test.sql"
ROLLBACK="$ROOT/docs/validation/VTID-05214/rollback.sql"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "$PGBIN/initdb" ] || { echo "initdb not found (set PGBIN)"; exit 2; }
WORK="$(mktemp -d)"
RUN_AS=()
if [ "$(id -u)" = "0" ]; then
  chown postgres "$WORK"
  chmod o+r "$PRIOR" "$G1" "$G2" "$MIG" "$FIXTURE" "$TESTS" "$ROLLBACK" 2>/dev/null || true
  RUN_AS=(sudo -u postgres)
fi
PORT="${PGPORT_TEST:-55438}"
cleanup() { "${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
"${RUN_AS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
"${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -w start >/dev/null
PSQL=("${RUN_AS[@]}" psql -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d postgres)
"${PSQL[@]}" -f "$FIXTURE"
"${PSQL[@]}" -f "$PRIOR" 2>/dev/null
"${PSQL[@]}" -f "$G1"
"${PSQL[@]}" -f "$G2"
"${PSQL[@]}" -f "$MIG"
"${PSQL[@]}" -f "$MIG"
"${PSQL[@]}" -t -f "$TESTS"
"${PSQL[@]}" -f "$ROLLBACK"
"${PSQL[@]}" -c "DO \$\$ BEGIN
  ASSERT to_regclass('public.pm_lease') IS NULL AND to_regclass('public.pm_digests') IS NULL, 'rollback: pm tables gone';
  ASSERT NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'plan_sparring_sessions' AND column_name = 'policy_approved_at'), 'rollback: column gone';
  ASSERT position('policy_approved_at' in pg_get_functiondef('public._plan_sparring_gate_eval(text,jsonb,text)'::regprocedure)) = 0, 'rollback: gate owner-only';
END \$\$;"
"${PSQL[@]}" -f "$MIG"
"${PSQL[@]}" -c "DO \$\$ BEGIN ASSERT to_regclass('public.pm_lease') IS NOT NULL, 're-apply'; END \$\$;"
echo 'VTID-05214: rollback + re-apply passed'
