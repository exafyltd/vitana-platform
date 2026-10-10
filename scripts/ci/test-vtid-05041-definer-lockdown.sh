#!/usr/bin/env bash
# VTID-05041: reproduce the live exposure of the S2 SECURITY DEFINER functions
# (fixture), prove the S2 migration refuses to apply while VTID-04981 is still
# open (and rolls back as a whole), then apply VTID-04981 and the S2 migration
# (twice) to a throwaway local Postgres and run the assertions.
# Needs a local PostgreSQL server (initdb/pg_ctl), e.g. apt postgresql-16.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIXTURE="$ROOT/supabase/tests/vtid_05041_fixture.sql"
CONSUME="$ROOT/supabase/migrations/20261008170000_vtid_04981_consume_credits_lockdown.sql"
MIGRATION="${VTID_05041_MIGRATION:-$ROOT/supabase/migrations/20261010164100_vtid_05041_definer_functions_lockdown.sql}"
TESTS="$ROOT/supabase/tests/vtid_05041_definer_lockdown.test.sql"

PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "$PGBIN/initdb" ] || { echo "initdb not found (set PGBIN)"; exit 2; }

WORK="$(mktemp -d)"
RUN_AS=()
if [ "$(id -u)" = "0" ]; then
  chown postgres "$WORK"
  RUN_AS=(sudo -u postgres)
fi
PORT="${PGPORT_TEST:-55441}"
cleanup() { "${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

# Copy the inputs next to the cluster so the postgres user can read them
# wherever the checkout lives.
for f in "$FIXTURE" "$CONSUME" "$MIGRATION" "$TESTS"; do cp "$f" "$WORK/"; done
FIXTURE="$WORK/$(basename "$FIXTURE")"; CONSUME="$WORK/$(basename "$CONSUME")"
MIGRATION="$WORK/$(basename "$MIGRATION")"; TESTS="$WORK/$(basename "$TESTS")"
[ "$(id -u)" = "0" ] && chown postgres "$WORK"/*.sql

"${RUN_AS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
"${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -w start >/dev/null

PSQL=("${RUN_AS[@]}" psql -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d postgres)
"${PSQL[@]}" -f "$FIXTURE"
"${PSQL[@]}" -c "DO \$\$ BEGIN
  ASSERT has_function_privilege('authenticated','public.write_fact(uuid,uuid,text,text,text,text,text,uuid,numeric,uuid)','EXECUTE'), 'precondition: members can call write_fact (live exposure reproduced)';
  ASSERT has_function_privilege('authenticated','public.fn_consume_credits(uuid,uuid,integer,text,text,text)','EXECUTE'), 'precondition: VTID-04981 not yet applied';
  ASSERT pg_get_function_result('public.get_user_profile_by_identifier(text)'::regprocedure) ILIKE '%email%', 'precondition: profile lookup returns email';
END \$\$;"

# Order guard: before VTID-04981 the S2 migration must refuse and change nothing.
if "${PSQL[@]}" -f "$MIGRATION" >"$WORK/order.log" 2>&1; then
  echo "S2 applied although fn_consume_credits was still open"; exit 1
fi
grep -q 'apply VTID-04981 (20261008170000) first' "$WORK/order.log" || { cat "$WORK/order.log"; exit 1; }
"${PSQL[@]}" -c "DO \$\$ BEGIN
  ASSERT has_function_privilege('authenticated','public.write_fact(uuid,uuid,text,text,text,text,text,uuid,numeric,uuid)','EXECUTE'), 'refused apply rolled back the revokes';
  ASSERT pg_get_function_result('public.get_user_profile_by_identifier(text)'::regprocedure) ILIKE '%email%', 'refused apply rolled back the profile change';
END \$\$;"
echo 'order guard: S2 refused before VTID-04981 and rolled back'

"${PSQL[@]}" -f "$CONSUME"
"${PSQL[@]}" -f "$MIGRATION"
"${PSQL[@]}" -f "$MIGRATION"
"${PSQL[@]}" -f "$TESTS"
