#!/usr/bin/env bash
# VTID-04988: apply the VTID-04809 wallet fixture + migration (the real
# credit_wallet), fn_consume_credits as VTID-03107 created it, the VTID-04981
# lockdown, a feature_entitlements fixture with the VTID-03107 rows, then the
# VTID-04988 migration (twice) to a throwaway local Postgres, and run the
# assertions.
# Needs a local PostgreSQL server (initdb/pg_ctl), e.g. apt postgresql-16.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
W_FIXTURE="$ROOT/supabase/tests/vtid_04809_fixture.sql"
W_MIGRATION="$ROOT/supabase/migrations/20261001180000_vtid_04809_vtna_reward_ledger.sql"
ORIGIN="$ROOT/supabase/migrations/20260526040000_VTID_03107_usage_helpers.sql"
LOCKDOWN="$ROOT/supabase/migrations/20261008170000_vtid_04981_consume_credits_lockdown.sql"
FIXTURE="$ROOT/supabase/tests/vtid_04988_fixture.sql"
MIGRATION="$ROOT/supabase/migrations/20261008190000_vtid_04988_earned_vtna_rewards_only.sql"
TESTS="$ROOT/supabase/tests/vtid_04988_rewards_only.test.sql"

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

# fn_consume_credits as shipped by VTID-03107: from its CREATE through its GRANT.
sed -n '/^CREATE OR REPLACE FUNCTION public.fn_consume_credits(/,/^GRANT EXECUTE ON FUNCTION public.fn_consume_credits/p' "$ORIGIN" > "$WORK/origin.sql"
grep -q 'TO service_role, authenticated;' "$WORK/origin.sql" || { echo "could not extract fn_consume_credits from $ORIGIN"; exit 2; }
[ "$(id -u)" = "0" ] && chown postgres "$WORK/origin.sql"

"${RUN_AS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
"${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -w start >/dev/null

PSQL=("${RUN_AS[@]}" psql -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d postgres)
"${PSQL[@]}" -f "$W_FIXTURE"
"${PSQL[@]}" -f "$W_MIGRATION"
"${PSQL[@]}" -f "$WORK/origin.sql"
"${PSQL[@]}" -f "$LOCKDOWN"
"${PSQL[@]}" -f "$FIXTURE"
"${PSQL[@]}" -f "$MIGRATION"
"${PSQL[@]}" -f "$MIGRATION"
"${PSQL[@]}" -f "$TESTS"
