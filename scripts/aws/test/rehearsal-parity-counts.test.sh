#!/usr/bin/env bash
# VTID-05023 rehearsal parity counts: tests with a fake psql and a fake aws on PATH.
# No network and no database. Checks that:
#   - a cluster other than vitana-aurora-rehearsal is refused before any call;
#   - identical rows on both sides exit 0;
#   - a differing row exits 1 and is reported as MISMATCH;
#   - each side runs one read-only REPEATABLE READ transaction;
#   - no write statement is ever sent to either side.
# Usage: bash scripts/aws/test/rehearsal-parity-counts.test.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT="$ROOT/scripts/aws/rehearsal-parity-counts.sh"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/data"
export FAKE_LOG="$WORK/calls.log" FAKE_DATA="$WORK/data"
export SUPABASE_RO_URL="postgres://ro@supabase.test:5432/postgres"
printf 'public.users\n# a comment\n\npublic.events\n' > "$WORK/tables.txt"

# Fake psql: logs the call and the statements on stdin, prints data/supabase.txt.
cat > "$WORK/bin/psql" <<'FAKE'
#!/usr/bin/env bash
echo "psql" >> "$FAKE_LOG"
cat >> "$FAKE_LOG"
cat "$FAKE_DATA/supabase.txt"
FAKE

# Fake aws: logs every call. Answers the cluster describes and the Data API calls.
# execute-statement returns the next row of data/aurora.txt for each count query.
cat > "$WORK/bin/aws" <<'FAKE'
#!/usr/bin/env bash
echo "aws $*" >> "$FAKE_LOG"
case "$1 $2" in
  "rds describe-db-clusters")
    case "$*" in
      *DBClusterArn*) echo "arn:aws:rds:eu-central-1:000000000000:cluster:vitana-aurora-rehearsal" ;;
      *SecretArn*) echo "arn:aws:secretsmanager:eu-central-1:000000000000:secret:fake" ;;
    esac ;;
  "rds-data begin-transaction") echo "tx-1" ;;
  "rds-data commit-transaction") : ;;
  "rds-data execute-statement")
    sql=""; prev=""
    for a in "$@"; do [ "$prev" = "--sql" ] && sql="$a"; prev="$a"; done
    case "$sql" in
      SET*) : ;;
      *) n=$(cat "$FAKE_DATA/aurora.n" 2>/dev/null || echo 0)
         n=$((n+1)); echo "$n" > "$FAKE_DATA/aurora.n"
         sed -n "${n}p" "$FAKE_DATA/aurora.txt" ;;
    esac ;;
  *) echo "fake aws: unexpected call $*" >&2; exit 254 ;;
esac
FAKE
chmod +x "$WORK/bin/psql" "$WORK/bin/aws"
export PATH="$WORK/bin:$PATH"

pass=0; fail=0
ok()  { pass=$((pass+1)); echo "PASS: $1"; }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
reset_run() { : > "$FAKE_LOG"; rm -f "$FAKE_DATA/aurora.n"; }
run() { # run cluster-id -> sets rc and out
  set +e; out=$(bash "$SCRIPT" "$1" "$WORK/tables.txt" 2>&1); rc=$?; set -e
}

# 1. Wrong cluster is refused, and nothing is called.
reset_run
printf '%s\n' '3|aaaa1111' '0|' > "$FAKE_DATA/supabase.txt"
printf '%s\n' '3|aaaa1111' '0|' > "$FAKE_DATA/aurora.txt"
run vitana-aurora-prod
echo "$out"
if [ "$rc" -eq 2 ] && [[ "$out" == *"refusing cluster"* ]] && [ ! -s "$FAKE_LOG" ]; then
  ok "refuses wrong cluster with exit 2 and no psql or aws call"
else
  bad "refuses wrong cluster (rc=$rc)"
fi

# 2. Identical rows: exit 0.
reset_run
run vitana-aurora-rehearsal
echo "$out"
if [ "$rc" -eq 0 ] && [[ "$out" == *"all 2 tables match"* ]]; then
  ok "matching rows exit 0"
else
  bad "matching rows exit 0 (rc=$rc)"
fi

# 3. One differing checksum: exit 1 and reported as MISMATCH.
reset_run
printf '%s\n' '3|aaaa1111' '5|bbbb2222' > "$FAKE_DATA/supabase.txt"
printf '%s\n' '3|aaaa1111' '5|cccc3333' > "$FAKE_DATA/aurora.txt"
run vitana-aurora-rehearsal
echo "$out"
if [ "$rc" -eq 1 ] && [[ "$out" == *"public.events"*"MISMATCH"* ]] && [[ "$out" == *"1 of 2 tables mismatched"* ]]; then
  ok "differing checksum exits 1 and is reported"
else
  bad "differing checksum exits 1 (rc=$rc)"
fi

# 4. Each side runs one read-only REPEATABLE READ transaction, one psql call on Supabase.
if [ "$(grep -c '^psql$' "$FAKE_LOG")" -eq 1 ] \
  && grep -q 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;' "$FAKE_LOG" \
  && [ "$(grep -c 'aws rds-data begin-transaction' "$FAKE_LOG")" -eq 1 ] \
  && grep -q 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY' "$FAKE_LOG"; then
  ok "one REPEATABLE READ read-only transaction per side"
else
  bad "one REPEATABLE READ read-only transaction per side"
fi

# 5. No write statement is sent to either side (checked on the run above).
if grep -iwE 'insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|copy|vacuum|reindex' "$FAKE_LOG"; then
  bad "no write statement sent to either side"
else
  ok "no write statement sent to either side"
fi

# 6. Match case: exit 0 with the matching run, and the matching run is also write-free.
reset_run
printf '%s\n' '3|aaaa1111' '0|' > "$FAKE_DATA/supabase.txt"
printf '%s\n' '3|aaaa1111' '0|' > "$FAKE_DATA/aurora.txt"
run vitana-aurora-rehearsal
if [ "$rc" -eq 0 ] && ! grep -iwE 'insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|copy|vacuum|reindex' "$FAKE_LOG"; then
  ok "match run exits 0 and sends no write statement"
else
  bad "match run exits 0 and sends no write statement (rc=$rc)"
fi

echo "---"
echo "passed: $pass  failed: $fail"
[ "$fail" -eq 0 ]
