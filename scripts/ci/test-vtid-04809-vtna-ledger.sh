#!/usr/bin/env bash
# VTID-04809: apply the VTNA ledger migration (twice) to a throwaway local
# Postgres that reproduces the live wallet tables, then run the assertions.
# Needs a local PostgreSQL server (initdb/pg_ctl), e.g. apt postgresql-16.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261001180000_vtid_04809_vtna_reward_ledger.sql"
FIXTURE="$ROOT/supabase/tests/vtid_04809_fixture.sql"
TESTS="$ROOT/supabase/tests/vtid_04809_vtna_reward_ledger.test.sql"

PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "$PGBIN/initdb" ] || { echo "initdb not found (set PGBIN)"; exit 2; }

WORK="$(mktemp -d)"
RUN_AS=()
if [ "$(id -u)" = "0" ]; then
  chown postgres "$WORK"
  RUN_AS=(sudo -u postgres)
fi
PORT="${PGPORT_TEST:-55432}"
cleanup() { "${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

"${RUN_AS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
"${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -w start >/dev/null

PSQL=("${RUN_AS[@]}" psql -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d postgres)
"${PSQL[@]}" -f "$FIXTURE"
"${PSQL[@]}" -f "$MIGRATION"
"${PSQL[@]}" -f "$MIGRATION"
"${PSQL[@]}" -f "$TESTS"
