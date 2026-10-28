#!/usr/bin/env bash
# VTID-05123: tests apply-sql-via-management-api.sh --record-migration against a
# throwaway database. Runs the REAL script with a fake `curl` first on PATH; the
# fake reads the JSON payload, runs `.query` on the local database with
# `psql -c`, and answers like the Management API (200 + rows, or 200 +
# {"message": ...} when the SQL fails). Never talks to Supabase.
#
# ASSUMPTION (re-verify if the Supabase Management API changes):
# `psql -c "<string>"` sends the whole string over the simple-query protocol.
# There a multi-statement string without an explicit BEGIN runs as ONE implicit
# transaction, and the first error aborts the rest of the string. This test
# assumes the Management API `database/query` endpoint behaves the same way —
# that is the property "no schema_migrations row without a successful
# migration" depends on (the recording INSERT is appended to the migration's
# own request). If the endpoint ever starts running statements independently,
# re-verify the "fails" cases below against it before trusting the row.
#
# Needs PG* env vars (or a local socket) pointing at a disposable Postgres.
# Refuses to run against anything that looks like Supabase or Aurora.
set -euo pipefail
case "${PGHOST:-local}" in
  *supabase*|*amazonaws*|*rds*) echo "refusing: PGHOST=${PGHOST} is not a throwaway database" >&2; exit 2 ;;
esac

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
SCRIPT="$ROOT/scripts/ci/apply-sql-via-management-api.sh"
db="record_migration_test_$$"
work=$(mktemp -d)
createdb "$db"
trap 'dropdb --if-exists "$db"; rm -rf "$work"' EXIT
export PGDATABASE="$db"

q() { psql -X -q -At -v ON_ERROR_STOP=1 -c "$1"; }

# Live shape of supabase_migrations.schema_migrations (2026-10-12).
q "CREATE SCHEMA supabase_migrations;
   CREATE TABLE supabase_migrations.schema_migrations (
     version text PRIMARY KEY, statements text[], name text, created_by text,
     idempotency_key text UNIQUE, rollback text[]);"

# ---- fake curl -------------------------------------------------------------
mkdir -p "$work/bin"
cat > "$work/bin/curl" <<'FAKE'
#!/usr/bin/env bash
# Fake Management API: only understands the flags the script uses.
set -uo pipefail
out=""; fmt=""; data=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) fmt="$2"; shift 2 ;;
    --data-binary) data="$2"; shift 2 ;;
    -X|-H) shift 2 ;;
    -sS) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  https://api.supabase.com/v1/projects/*/database/query) ;;
  *) echo "fake curl: unexpected url $url" >&2; exit 7 ;;
esac
query=$(printf '%s' "$data" | jq -r '.query')
echo "$query" >> "$FAKE_CURL_LOG"
echo "-----" >> "$FAKE_CURL_LOG"
is_precheck=0
case "$query" in "SELECT idempotency_key, name FROM supabase_migrations.schema_migrations WHERE version"*) is_precheck=1 ;; esac
if [ "$is_precheck" = 1 ] && [ -n "${FAKE_CURL_FAIL_PRECHECK:-}" ]; then
  # A bare 503 with an array body: only the HTTP-status check can stop it.
  printf '[]' > "$out"; printf '503'; exit 0
fi
case "$query" in
  SELECT*) run="SELECT coalesce(json_agg(t), '[]'::json) FROM (${query}) t" ;;
  *) run="$query" ;;
esac
if res=$(psql -X -q -At -c "$run" 2>"$out.err"); then
  case "$query" in SELECT*) printf '%s' "$res" > "$out" ;; *) printf '[]' > "$out" ;; esac
  grep -h 'WARNING' "$out.err" >&2 || true
else
  jq -n --arg m "$(cat "$out.err")" '{message: $m}' > "$out"
fi
rm -f "$out.err"
# Race hook: another run inserts the same version right after our pre-check.
if [ "$is_precheck" = 1 ] && [ -n "${FAKE_CURL_RACE_SQL:-}" ]; then
  psql -X -q -c "$FAKE_CURL_RACE_SQL" >/dev/null
fi
printf '200'
FAKE
chmod +x "$work/bin/curl"
export PATH="$work/bin:$PATH"
[ "$(command -v curl)" = "$work/bin/curl" ] || { echo "fake curl is not first on PATH" >&2; exit 2; }
export FAKE_CURL_LOG="$work/curl.log"
export SUPABASE_ACCESS_TOKEN=not-a-real-token
export SUPABASE_URL=https://localfake.supabase.co
export RUN_ID=424242

repo="$work/repo"
mkdir -p "$repo/supabase/migrations/data-fixups"
cd "$repo"

fail=0; n=0
check() { # check <label> <expected> <actual>
  n=$((n+1))
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: expected [$2] got [$3]"; fail=1; fi
}
run() { # run <file> -> sets RC and OUT
  set +e
  OUT=$("$SCRIPT" --file "$1" --record-migration 2>&1)
  RC=$?
  set -e
}
rows() { q "SELECT count(*) FROM supabase_migrations.schema_migrations WHERE ${1:-true}"; }
exists() { q "SELECT to_regclass('$1') IS NOT NULL"; }
has_warning() { if printf '%s' "$OUT" | grep -q '::warning::'; then echo yes; else echo no; fi; }
m=supabase/migrations

# 1. plain file (no BEGIN) succeeds -> one row, right values, exit 0
printf 'CREATE TABLE plain_t (id int);\n' > $m/20261101000000_vtid_09001_plain.sql
run $m/20261101000000_vtid_09001_plain.sql
check "plain: exit 0" 0 "$RC"
check "plain: table exists" t "$(exists plain_t)"
check "plain: row values" "20261101000000|vtid_09001_plain|github-actions:RUN-MIGRATION:424242|20261101000000_vtid_09001_plain.sql" \
  "$(q "SELECT version||'|'||name||'|'||created_by||'|'||idempotency_key FROM supabase_migrations.schema_migrations WHERE idempotency_key='20261101000000_vtid_09001_plain.sql'")"
check "plain: statements/rollback NULL" "t" "$(q "SELECT statements IS NULL AND rollback IS NULL FROM supabase_migrations.schema_migrations WHERE version='20261101000000'")"

# 2. own BEGIN ... COMMIT succeeds -> one row, exit 0
printf 'BEGIN;\nCREATE TABLE own_tx_t (id int);\nCOMMIT;\n' > $m/20261101000100_vtid_09002_own_tx.sql
run $m/20261101000100_vtid_09002_own_tx.sql
check "own tx: exit 0" 0 "$RC"
check "own tx: table exists" t "$(exists own_tx_t)"
check "own tx: one row" 1 "$(rows "idempotency_key='20261101000100_vtid_09002_own_tx.sql'")"

# 3. RAISE without BEGIN -> zero rows, DDL rolled back, exit 1
printf "CREATE TABLE raise_plain_t (id int);\nDO \$\$ BEGIN RAISE EXCEPTION 'drift guard'; END \$\$;\n" > $m/20261101000200_vtid_09003_raise_plain.sql
run $m/20261101000200_vtid_09003_raise_plain.sql
check "raise plain: exit 1" 1 "$RC"
check "raise plain: DDL rolled back" f "$(exists raise_plain_t)"
check "raise plain: no row" 0 "$(rows "version='20261101000200'")"

# 4. RAISE inside its own BEGIN -> zero rows, DDL rolled back, exit 1
printf "BEGIN;\nCREATE TABLE raise_tx_t (id int);\nDO \$\$ BEGIN RAISE EXCEPTION 'drift guard'; END \$\$;\nCOMMIT;\n" > $m/20261101000300_vtid_09004_raise_tx.sql
run $m/20261101000300_vtid_09004_raise_tx.sql
check "raise tx: exit 1" 1 "$RC"
check "raise tx: DDL rolled back" f "$(exists raise_tx_t)"
check "raise tx: no row" 0 "$(rows "version='20261101000300'")"

# 5. partial apply (accepted edge case): committed DDL, no row, exit 1
printf 'BEGIN;\nCREATE TABLE partial_t (id int);\nCOMMIT;\nSELECT 1/0;\n' > $m/20261101000400_vtid_09005_partial.sql
run $m/20261101000400_vtid_09005_partial.sql
check "partial: exit 1" 1 "$RC"
check "partial: table exists (committed before the error)" t "$(exists partial_t)"
check "partial: no row" 0 "$(rows "version='20261101000400'")"

# 6. same file twice -> still one row, exit 0 both times
printf 'CREATE TABLE IF NOT EXISTS twice_t (id int);\n' > $m/20261101000500_vtid_09006_twice.sql
run $m/20261101000500_vtid_09006_twice.sql; rc1=$RC
run $m/20261101000500_vtid_09006_twice.sql; rc2=$RC
check "twice: exit 0 / 0" "0/0" "$rc1/$rc2"
check "twice: one row" 1 "$(rows "version='20261101000500'")"
check "twice: no warning on re-run" no "$(has_warning)"
check "twice: re-run is an ON CONFLICT no-op, not a caught collision" no "$(printf '%s' "$OUT" | grep -q 'already held by another file' && echo yes || echo no)"

# 7. two files sharing a prefix -> first recorded; second applied, no row, warning, exit 0
printf 'CREATE TABLE dup_a_t (id int);\n' > $m/20261101000600_vtid_09007_dup_a.sql
printf 'CREATE TABLE dup_b_t (id int);\n' > $m/20261101000600_vtid_09008_dup_b.sql
run $m/20261101000600_vtid_09007_dup_a.sql
check "dup a: exit 0" 0 "$RC"
run $m/20261101000600_vtid_09008_dup_b.sql
check "dup b: exit 0" 0 "$RC"
check "dup b: applied" t "$(exists dup_b_t)"
check "dup: one row, held by a" "20261101000600_vtid_09007_dup_a.sql" "$(q "SELECT string_agg(idempotency_key, ',') FROM supabase_migrations.schema_migrations WHERE version='20261101000600'")"
check "dup b: warning names the holder" yes "$(printf '%s' "$OUT" | grep -q '::warning::version 20261101000600 already recorded as vtid_09007_dup_a' && echo yes || echo no)"

# 8. version held by an MCP-style row (NULL idempotency_key) -> applied, not recorded, warning, exit 0
q "INSERT INTO supabase_migrations.schema_migrations (version, name, created_by) VALUES ('20261101000700', 'mcp_applied', 'someone@example.com')"
printf 'CREATE TABLE mcp_t (id int);\n' > $m/20261101000700_vtid_09009_mcp.sql
run $m/20261101000700_vtid_09009_mcp.sql
check "mcp: exit 0" 0 "$RC"
check "mcp: applied" t "$(exists mcp_t)"
check "mcp: still only the MCP row" "mcp_applied|" "$(q "SELECT name||'|'||coalesce(idempotency_key,'') FROM supabase_migrations.schema_migrations WHERE version='20261101000700'")"
check "mcp: warning" yes "$(has_warning)"

# 9. race: another run inserts the version between pre-check and apply -> applied, guard catches, exit 0
printf 'CREATE TABLE race_t (id int);\n' > $m/20261101000800_vtid_09010_race.sql
export FAKE_CURL_RACE_SQL="INSERT INTO supabase_migrations.schema_migrations (version, name, idempotency_key) VALUES ('20261101000800', 'racer', '20261101000800_racer.sql')"
run $m/20261101000800_vtid_09010_race.sql
unset FAKE_CURL_RACE_SQL
check "race: exit 0" 0 "$RC"
check "race: applied" t "$(exists race_t)"
check "race: only the racer's row" "20261101000800_racer.sql" "$(q "SELECT string_agg(idempotency_key, ',') FROM supabase_migrations.schema_migrations WHERE version='20261101000800'")"
check "race: unique_violation turned into a warning" yes "$(printf '%s' "$OUT" | grep -q 'already held by another file' && echo yes || echo no)"
check "race: post-verify warning" yes "$(has_warning)"

# 10. pre-check request fails -> exit 1, DDL absent
printf 'CREATE TABLE precheck_t (id int);\n' > $m/20261101000900_vtid_09011_precheck.sql
export FAKE_CURL_FAIL_PRECHECK=1
run $m/20261101000900_vtid_09011_precheck.sql
unset FAKE_CURL_FAIL_PRECHECK
check "precheck fail: exit 1" 1 "$RC"
check "precheck fail: DDL absent" f "$(exists precheck_t)"
check "precheck fail: no row" 0 "$(rows "version='20261101000900'")"

# 11. last line is a -- comment without a newline -> row still written
printf 'CREATE TABLE comment_t (id int) -- trailing comment, no semicolon, no newline' > $m/20261101001000_vtid_09012_comment.sql
run $m/20261101001000_vtid_09012_comment.sql
check "trailing comment: exit 0" 0 "$RC"
check "trailing comment: applied" t "$(exists comment_t)"
check "trailing comment: one row" 1 "$(rows "version='20261101001000'")"

# 12. paths/basenames/RUN_ID that must never be recorded -> applied, warning, exit 0
before=$(rows)
printf 'CREATE TABLE fixup_t (id int);\n' > $m/data-fixups/20261101001100_fixup.sql
run $m/data-fixups/20261101001100_fixup.sql
check "data-fixups: exit 0 + applied + warning" "0/t/yes" "$RC/$(exists fixup_t)/$(has_warning)"
printf 'CREATE TABLE odd_t (id int);\n' > $m/odd_name.sql
run $m/odd_name.sql
check "odd basename: exit 0 + applied + warning" "0/t/yes" "$RC/$(exists odd_t)/$(has_warning)"
printf 'CREATE TABLE quote_t (id int);\n' > "$m/20261101001200_it's.sql"
run "$m/20261101001200_it's.sql"
check "quote basename: exit 0 + applied + warning" "0/t/yes" "$RC/$(exists quote_t)/$(has_warning)"
printf 'CREATE TABLE runid_t (id int);\n' > $m/20261101001300_vtid_09013_runid.sql
RUN_ID=abc; run $m/20261101001300_vtid_09013_runid.sql; RUN_ID=424242
check "RUN_ID=abc: exit 0 + applied + warning" "0/t/yes" "$RC/$(exists runid_t)/$(has_warning)"
check "8-digit prefix accepted by regex" yes "$(printf '20260209_vtid_01228_x.sql' | grep -qE '^[0-9]{8,14}_[A-Za-z0-9_.-]+\.sql$' && echo yes || echo no)"
check "nothing recorded by step 12" "$before" "$(rows)"

# 13. a file using CONCURRENTLY is not recorded and its payload is untouched
: > "$FAKE_CURL_LOG"
printf 'CREATE INDEX CONCURRENTLY conc_i ON plain_t (id);\n' > $m/20261101001400_vtid_09014_conc.sql
run $m/20261101001400_vtid_09014_conc.sql
check "concurrently: exit 0 + index built + warning" "0/t/yes" "$RC/$(exists conc_i)/$(has_warning)"
check "concurrently: no recording block sent" no "$(grep -q 'record-migration' "$FAKE_CURL_LOG" && echo yes || echo no)"

# 14. flag off (every other caller) -> exactly one request, payload unchanged, no row
: > "$FAKE_CURL_LOG"
printf 'CREATE TABLE noflag_t (id int);\n' > $m/20261101001500_vtid_09015_noflag.sql
set +e; OUT=$("$SCRIPT" --file $m/20261101001500_vtid_09015_noflag.sql 2>&1); RC=$?; set -e
check "no flag: exit 0 + applied" "0/t" "$RC/$(exists noflag_t)"
check "no flag: one request, file text only" "CREATE TABLE noflag_t (id int);|1" "$(head -1 "$FAKE_CURL_LOG")|$(grep -c '^-----$' "$FAKE_CURL_LOG")"
check "no flag: no row" 0 "$(rows "version='20261101001500'")"
set +e; "$SCRIPT" --sql "SELECT 1" --record-migration >/dev/null 2>&1; RC=$?; set -e
check "--record-migration with --sql: usage error" 2 "$RC"

if [ "$fail" != 0 ]; then echo "FAILED vtid-05123 record migration row ($n checks)"; exit 1; fi
echo "PASS vtid-05123 record migration row ($n checks)"
