#!/usr/bin/env bash
# VTID-05023 part 4: proves the Aurora side of the auth bridge on throwaway
# local Postgres databases. Never touches Supabase or Aurora.
#
#   1. "supabase" db: stub auth.users + the six provisioning triggers verbatim;
#      four sign-ups.
#   2. "aurora" db: Aurora's auth.uid()/auth.jwt() shim
#      (scripts/aurora/migrations/0001_auth_shim.sql) + the real
#      scripts/aws/aurora-cutover-auth-bridge.sql, applied twice (re-runnable);
#      the same four users through ensure_provisioned(), twice (idempotent).
#   3. Both databases' provisioned rows are diffed: they must be identical.
#   4. aurora-tests.sql: the db-pre-request hook (read-only GET and null uid are
#      no-ops, an unprovisioned member's write succeeds after it provisions),
#      grants, service-account exclusion and the deletion path.
#
# Uses PG* env vars when PGHOST is set (CI service container); otherwise starts
# a private cluster with initdb/pg_ctl (apt postgresql-16 or similar).
# Usage: npm run test:auth-bridge
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DIR="$ROOT/scripts/aws/test/auth-bridge"
BRIDGE="$ROOT/scripts/aws/aurora-cutover-auth-bridge.sql"
SHIM="$ROOT/scripts/aurora/migrations/0001_auth_shim.sql"

case "${PGHOST:-local}" in
  *supabase*|*amazonaws*|*rds*) echo "refusing: PGHOST=${PGHOST} is not a throwaway database" >&2; exit 2 ;;
esac

WORK="$(mktemp -d)"
STARTED_LOCAL=0
RUN_AS=()
cleanup() {
  if [ "$STARTED_LOCAL" = 1 ]; then
    "${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
  else
    dropdb --if-exists "$SB_DB" >/dev/null 2>&1 || true
    dropdb --if-exists "$AU_DB" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
SB_DB="auth_bridge_supabase_$$"
AU_DB="auth_bridge_aurora_$$"
trap cleanup EXIT

if [ -z "${PGHOST:-}" ]; then
  PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
  [ -x "${PGBIN:-}/initdb" ] || { echo "initdb not found (install postgresql or set PGBIN / PGHOST)"; exit 2; }
  if [ "$(id -u)" = "0" ]; then
    chown postgres "$WORK"
    RUN_AS=(sudo -u postgres)
  fi
  PORT="${PGPORT_TEST:-55433}"
  "${RUN_AS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
  "${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -w start >/dev/null
  STARTED_LOCAL=1
  export PGHOST="$WORK" PGPORT="$PORT" PGUSER=postgres
fi

createdb "$SB_DB"
createdb "$AU_DB"
sb() { psql -X -q -v ON_ERROR_STOP=1 -d "$SB_DB" "$@"; }
au() { psql -X -q -v ON_ERROR_STOP=1 -d "$AU_DB" "$@"; }

echo "== supabase: six triggers, four sign-ups"
sb -f "$DIR/common.sql" -f "$DIR/supabase-triggers.sql" -f "$DIR/supabase-signups.sql"

echo "== aurora: shim + aurora-cutover-auth-bridge.sql (twice), ensure_provisioned (twice)"
# Same contract as scripts/aws/aurora-run-sql.sh: every non-comment line is one statement.
grep -v '^--' "$BRIDGE" | grep -v '^[[:space:]]*$' | while IFS= read -r stmt; do
  case "$stmt" in *';') ;; *) echo "FAIL: statement does not end on its line: ${stmt:0:120}" >&2; exit 1 ;; esac
done
au -f "$DIR/common.sql" -f "$SHIM"
au -f "$BRIDGE"
au -f "$BRIDGE"
au -f "$DIR/aurora-provision.sql"

echo "== rows: triggers (supabase) vs ensure_provisioned (aurora)"
sb -A -t -f "$DIR/snapshot.sql" > "$WORK/supabase.txt"
au -A -t -f "$DIR/snapshot.sql" > "$WORK/aurora.txt"
lines=$(wc -l < "$WORK/supabase.txt")
[ "$lines" -ge 40 ] || { echo "FAIL: snapshot unexpectedly small ($lines lines)"; cat "$WORK/supabase.txt"; exit 1; }
if ! diff -u "$WORK/supabase.txt" "$WORK/aurora.txt"; then
  echo "FAIL: ensure_provisioned does not create the same rows as the six triggers" >&2
  exit 1
fi
echo "ok: ensure_provisioned created the same $lines rows as the six triggers"

echo "== aurora: db-pre-request hook, grants, deletion"
au -o /dev/null -f "$DIR/aurora-tests.sql"

echo "PASS vtid-05023 auth bridge"
