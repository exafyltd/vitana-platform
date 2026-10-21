#!/usr/bin/env bash
# VTID-05012: on a throwaway local Postgres, apply the VTID-04754 base migration, then the VTID-05012
# migration twice (idempotent), run the assertions, apply the rollback, and check the old shape is back.
# Needs a local PostgreSQL server (initdb/pg_ctl). Never points at a live database.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BASE="$ROOT/supabase/migrations/20261001100000_vtid_04754_jev_spend_and_shadow.sql"
MIGRATION="$ROOT/supabase/migrations/20261009120000_vtid_05012_jev_gate_observability.sql"
FIXTURE="$ROOT/supabase/tests/vtid_05012_fixture.sql"
TESTS="$ROOT/supabase/tests/vtid_05012_jev_gate_observability.test.sql"
ROLLBACK="$ROOT/docs/validation/VTID-05012/rollback.sql"

PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "$PGBIN/initdb" ] || { echo "initdb not found (set PGBIN)"; exit 2; }

WORK="$(mktemp -d)"
RUN_AS=()
if [ "$(id -u)" = "0" ]; then
  chown postgres "$WORK"
  RUN_AS=(sudo -u postgres)
fi
PORT="${PGPORT_TEST:-55438}"
cleanup() { "${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

copy() { cp "$1" "$WORK/$(basename "$1")"; chmod o+r "$WORK/$(basename "$1")"; echo "$WORK/$(basename "$1")"; }
B="$(copy "$BASE")"; M="$(copy "$MIGRATION")"; X="$(copy "$FIXTURE")"; T="$(copy "$TESTS")"; R="$(copy "$ROLLBACK")"

"${RUN_AS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
"${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -w start >/dev/null
PSQL=("${RUN_AS[@]}" psql -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d postgres)

"${PSQL[@]}" -f "$X"
"${PSQL[@]}" -f "$B"
"${PSQL[@]}" -f "$M"
"${PSQL[@]}" -f "$M"            # idempotent
"${PSQL[@]}" -f "$T"

# Rollback restores the VTID-04754 shape.
"${PSQL[@]}" -f "$R"
"${PSQL[@]}" -tA -c "SELECT count(*) FROM information_schema.columns WHERE table_name='jev_shadow_decisions' AND column_name IN ('skip_reason','lean_agreed')" | grep -qx 0
"${PSQL[@]}" -tA -c "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='jev_shadow_decisions_jev_outcome_check'" | grep -vq skipped
"${PSQL[@]}" -tA -c "SELECT count(*) FROM pg_indexes WHERE indexname='uq_jev_shadow_skip'" | grep -qx 0
"${PSQL[@]}" -tA -c "SELECT pg_get_function_result('public.jev_shadow_gate_stats(int)'::regprocedure)" | grep -vq skipped
"${PSQL[@]}" -tA -c "SELECT has_function_privilege('service_role','public.jev_shadow_gate_stats(int)','EXECUTE')" | grep -qx t
echo "VTID-05012 rollback restores the VTID-04754 shape"
