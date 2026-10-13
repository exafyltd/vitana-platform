#!/usr/bin/env bash
# VTID-05023 parts 8b + 12(i): proves, on a throwaway local Postgres, that
# supabase-cutover-reverse-cdc-triggers.sql disables every public user trigger (so rows the
# Aurora->Supabase DMS tasks apply fire no notification) and that the rollback restores each
# trigger's exact prior state; and, with a fake `aws`, that aurora-to-supabase-cdc.sh builds
# the right task, never starts it and never puts a password on a command line.
# Never touches Supabase, Aurora or AWS. Usage: npm run test:reverse-cdc
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DIR="$ROOT/scripts/aws/test/reverse-cdc"
FWD="$ROOT/scripts/aws/supabase-cutover-reverse-cdc-triggers.sql"
BACK="$ROOT/scripts/aws/supabase-cutover-reverse-cdc-triggers-rollback.sql"
CDC="$ROOT/scripts/aws/aurora-to-supabase-cdc.sh"
case "${PGHOST:-local}" in
  *supabase*|*amazonaws*|*rds*) echo "refusing: PGHOST=${PGHOST} is not a throwaway database" >&2; exit 2 ;;
esac
WORK="$(mktemp -d)"; STARTED_LOCAL=0; RUN_AS=(); DB="reverse_cdc_$$"; DB2="reverse_cdc_empty_$$"
cleanup() {
  if [ "$STARTED_LOCAL" = 1 ]; then "${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
  else dropdb --if-exists "$DB" >/dev/null 2>&1 || true; dropdb --if-exists "$DB2" >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT
if [ -z "${PGHOST:-}" ]; then
  PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
  [ -x "${PGBIN:-}/initdb" ] || { echo "initdb not found (install postgresql or set PGBIN / PGHOST)"; exit 2; }
  if [ "$(id -u)" = "0" ]; then chown postgres "$WORK"; RUN_AS=(sudo -u postgres); fi
  PORT="${PGPORT_TEST:-55434}"
  "${RUN_AS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
  "${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -w start >/dev/null
  STARTED_LOCAL=1
  export PGHOST="$WORK" PGPORT="$PORT" PGUSER=postgres
fi
createdb "$DB"; createdb "$DB2"
q() { psql -X -q -v ON_ERROR_STOP=1 -d "$DB" "$@"; }

echo "== statements are one per line"
for f in "$FWD" "$BACK"; do
  grep -v '^--' "$f" | grep -v '^[[:space:]]*$' | while IFS= read -r s; do
    case "$s" in *';') ;; *) echo "FAIL: $f: statement does not end on its line: ${s:0:100}" >&2; exit 1 ;; esac
  done
done
echo "== rollback refuses without a snapshot"
if psql -X -q -v ON_ERROR_STOP=1 -d "$DB2" -f "$BACK" >/dev/null 2>"$WORK/err"; then echo "FAIL: rollback ran without a snapshot"; exit 1; fi
grep -q "no trigger snapshot" "$WORK/err" || { cat "$WORK/err"; exit 1; }
echo "ok"
echo "== forward twice, checks, rollback twice"
q -f "$DIR/fixture.sql"
q -f "$FWD" 2>/dev/null; q -f "$FWD" 2>/dev/null
q -f "$DIR/checks.sql"
q -f "$BACK"; q -f "$BACK"
q -f "$DIR/after-rollback.sql"

echo "== aurora-to-supabase-cdc.sh: dry run"
for scope in storage-auth rollback; do
  bash "$CDC" --scope "$scope" > "$WORK/dry-$scope.txt"
  grep -q "dry run: nothing created" "$WORK/dry-$scope.txt" || { echo "FAIL: dry run $scope"; exit 1; }
done
grep -q '"rule-name": "include-voucher_orders"' "$WORK/dry-storage-auth.txt" && ! grep -q '"%"' "$WORK/dry-storage-auth.txt" || { echo "FAIL: storage-auth mappings"; exit 1; }
for t in chat_messages auth_user_fk_map outbound_http_requests; do grep -q "\"rule-name\": \"exclude-[a-z-]*-$t\"" "$WORK/dry-rollback.txt" || { echo "FAIL: rollback scope does not exclude $t"; exit 1; }; done
if bash "$CDC" --scope nope >/dev/null 2>&1; then echo "FAIL: bad scope accepted"; exit 1; fi
echo "ok"

echo "== aurora-to-supabase-cdc.sh --apply against a fake aws"
mkdir -p "$WORK/bin"
cat > "$WORK/bin/aws" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_LOG"
for a in "$@"; do case "$a" in file://*) cp "${a#file://}" "$FAKE_DIR/settings-$(date +%s%N).json"; echo "${a#file://}" >> "$FAKE_DIR/paths" ;; esac; done
case "$1 $2" in
  "sts get-caller-identity") echo 472838866351 ;;
  "dms describe-endpoints"|"dms describe-replication-tasks") echo None ;;
  "dms create-endpoint") echo "arn:aws:dms:eu-central-1:472838866351:endpoint:FAKE$RANDOM" ;;
  "dms create-replication-task") echo "arn:aws:dms:eu-central-1:472838866351:task:FAKETASK" ;;
  *) echo "fake aws: unexpected $*" >&2; exit 1 ;;
esac
FAKE
chmod +x "$WORK/bin/aws"
export FAKE_LOG="$WORK/aws.log" FAKE_DIR="$WORK"
printf 'aurora-S3cret-pw\nsupa-S3cret-pw\n' | PATH="$WORK/bin:$PATH" bash "$CDC" --scope storage-auth --apply > "$WORK/apply.txt"
grep -q "created (NOT started): arn:aws:dms:eu-central-1:472838866351:task:FAKETASK" "$WORK/apply.txt" || { cat "$WORK/apply.txt"; echo "FAIL: task not created"; exit 1; }
if grep -q "S3cret" "$FAKE_LOG" "$WORK/apply.txt"; then echo "FAIL: a password reached a command line or the output"; exit 1; fi
grep -q "start-replication-task" "$FAKE_LOG" && { echo "FAIL: the task was started"; exit 1; }
grep -q -- "--migration-type cdc" "$FAKE_LOG" || { echo "FAIL: not a CDC-only task"; exit 1; }
grep -l '"Password": "aurora-S3cret-pw"' "$WORK"/settings-*.json | xargs grep -q '"PluginName": "test-decoding"' || { echo "FAIL: source endpoint settings"; exit 1; }
grep -lq '"Password": "supa-S3cret-pw"' "$WORK"/settings-*.json || { echo "FAIL: target endpoint settings"; exit 1; }
if grep -h '"Password": "supa' "$WORK"/settings-*.json | grep -q -i "replication_role\|AfterConnectScript"; then echo "FAIL: target must not use replica mode (Supabase refuses it)"; exit 1; fi
while read -r p; do [ ! -e "$p" ] || { echo "FAIL: password file $p left on disk"; exit 1; }; done < "$WORK/paths"
echo "ok: endpoints from 0600 temp files (deleted), CDC-only task created, not started, no password on a command line"
echo "PASS vtid-05023 reverse cdc"
