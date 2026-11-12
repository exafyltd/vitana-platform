#!/usr/bin/env bash
# VTID-05023 part 10: tests scripts/aws/rehearsal-apply-migrations.sh against a local fake of
# the RDS Data API. No AWS call and no network. A fake `aws` on PATH logs every call. It answers
# the identity and cluster describes for the identifier it is asked about, and it fails the
# execute-statement whose SQL contains the marker in FAKE_FAIL_ON. The real apply script runs
# underneath, so its transaction and statement logic is exercised too.
#   1. --cluster other than vitana-aurora-rehearsal (prod, look-alikes, empty, missing) is
#      refused, with no aws call and no log file
#   2. the held drop in the list is refused, with no aws call
#   3. a list entry that is not an existing .sql file, or is listed twice, is refused
#   4. a failing file stops the run: earlier files applied, the failing file is named, the
#      later files' SQL is never sent
#   5. every file OK: one line per file in list order, exit 0, only the rehearsal cluster used
# Usage: bash scripts/aws/test/rehearsal-apply-migrations.test.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
RUNNER="$ROOT/scripts/aws/rehearsal-apply-migrations.sh"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/mig"
export FAKE_LOG="$WORK/aws.log" AWS_REGION=eu-central-1

cat > "$WORK/bin/aws" <<'FAKE'
#!/usr/bin/env bash
# fake aws: logs each call, answers identity and describes, records the SQL of each
# execute-statement in $FAKE_LOG.sql, fails it when the SQL contains $FAKE_FAIL_ON.
echo "$*" >> "$FAKE_LOG"
arg() { local want="$1"; shift; while [ $# -gt 0 ]; do if [ "$1" = "$want" ]; then echo "$2"; return; fi; shift; done; }
case "$1 $2" in
  "sts get-caller-identity") echo 472838866351 ;;
  "rds describe-db-clusters")
    id="$(arg --db-cluster-identifier "$@")"
    case "$(arg --query "$@")" in
      *SecretArn*) echo "arn:aws:secretsmanager:eu-central-1:472838866351:secret:rds!cluster-fake-AbCdEf" ;;
      *) echo "arn:aws:rds:eu-central-1:472838866351:cluster:$id" ;;
    esac ;;
  "rds-data begin-transaction") echo '{"transactionId":"tx-fake"}' ;;
  "rds-data execute-statement")
    req="$(arg --cli-input-json "$@")"; req="${req#file://}"
    sql="$(jq -r .sql "$req")"
    printf '%s\n' "$sql" >> "$FAKE_LOG.sql"
    if [ -n "${FAKE_FAIL_ON:-}" ] && [[ "$sql" == *"$FAKE_FAIL_ON"* ]]; then
      echo "An error occurred (BadRequestException) when calling the ExecuteStatement operation: fake syntax error" >&2
      exit 254
    fi
    echo '{}' ;;
  "rds-data commit-transaction"|"rds-data rollback-transaction") echo '{}' ;;
  *) echo "fake aws: unexpected call: $*" >&2; exit 99 ;;
esac
FAKE
chmod +x "$WORK/bin/aws"

# Fixtures. Each file carries a marker that the fake can match on.
printf "CREATE TABLE public.rehearsal_alpha (a int);\nSELECT 'MARK_ALPHA';\n" > "$WORK/mig/20261101000001_alpha.sql"
printf "CREATE TABLE public.rehearsal_beta (a int);\nSELECT 'MARK_BETA';\n" > "$WORK/mig/20261101000002_beta.sql"
printf "CREATE TABLE public.rehearsal_gamma (a int);\nSELECT 'MARK_GAMMA';\n" > "$WORK/mig/20261101000003_gamma.sql"
printf "DROP TABLE public.legacy_messages;\nSELECT 'MARK_HELD';\n" > "$WORK/mig/20261102052300_vtid_05573_legacy_messages_drop.sql"
A="$WORK/mig/20261101000001_alpha.sql"; B="$WORK/mig/20261101000002_beta.sql"
G="$WORK/mig/20261101000003_gamma.sql"; H="$WORK/mig/20261102052300_vtid_05573_legacy_messages_drop.sql"
printf '# cutover order\n%s\n\n%s\n%s\n' "$A" "$B" "$G" > "$WORK/list-ok.txt"
printf '%s\n%s\n' "$A" "$H" > "$WORK/list-held.txt"
printf '%s\n%s\n' "$A" "$WORK/mig/does-not-exist.sql" > "$WORK/list-missing.txt"
printf '%s\n%s\n' "$A" "$A" > "$WORK/list-dup.txt"
printf '%s\n' "$WORK/mig/20261101000001_alpha.sql" > "$WORK/list-ok-one.txt"

PASS=0
ok() { PASS=$((PASS+1)); echo "ok: $*"; }
die() { echo "FAIL: $*" >&2; for f in out err; do [ -f "$WORK/$f" ] && sed 's/^/  | /' "$WORK/$f" >&2; done; exit 1; }
# run <args...>: one runner call with fresh state. Sets RC and the out/err files.
run() {
  rm -f "$FAKE_LOG" "$FAKE_LOG.sql" "$WORK/run.log"; : > "$FAKE_LOG"
  set +e
  PATH="$WORK/bin:$PATH" bash "$RUNNER" "$@" --log "$WORK/run.log" > "$WORK/out" 2> "$WORK/err"
  RC=$?
  set -e
}
aws_calls() { wc -l < "$FAKE_LOG" | tr -d ' '; }

# ---- 1. refuse any cluster but vitana-aurora-rehearsal ------------------------------
for c in vitana-aurora-prod vitana-aurora-rehearsal-2 "vitana-aurora-rehearsal " ""; do
  run --cluster "$c" --list "$WORK/list-ok.txt"
  [ "$RC" != 0 ] || die "cluster '$c' accepted"
  grep -q "REFUSED" "$WORK/err" || die "cluster '$c': no refusal message"
  [ "$(aws_calls)" = 0 ] || die "cluster '$c': aws was called"
  [ ! -e "$WORK/run.log" ] || die "cluster '$c': a log file was written"
done
run --list "$WORK/list-ok.txt"
[ "$RC" = 2 ] && [ "$(aws_calls)" = 0 ] || die "missing --cluster: rc=$RC, aws calls $(aws_calls)"
ok "cluster other than vitana-aurora-rehearsal (prod, look-alikes, empty, missing) refused before any aws call; no log written"

# ---- 2. refuse the held drop --------------------------------------------------------
run --cluster vitana-aurora-rehearsal --list "$WORK/list-held.txt"
[ "$RC" = 2 ] || die "held drop: rc=$RC"
grep -q "held drop" "$WORK/err" || die "held drop: no refusal message"
[ "$(aws_calls)" = 0 ] || die "held drop: aws was called"
ok "held drop 20261102052300_vtid_05573_legacy_messages_drop.sql refused before any aws call"

# ---- 3. list validation -------------------------------------------------------------
run --cluster vitana-aurora-rehearsal --list "$WORK/list-missing.txt"
[ "$RC" = 2 ] && grep -q "file not found" "$WORK/err" && [ "$(aws_calls)" = 0 ] || die "missing file not refused"
run --cluster vitana-aurora-rehearsal --list "$WORK/list-dup.txt"
[ "$RC" = 2 ] && grep -q "listed twice" "$WORK/err" && [ "$(aws_calls)" = 0 ] || die "duplicate entry not refused"
ok "list entry that does not exist, or is listed twice, refused before any aws call"

# ---- 4. stop on the first error -----------------------------------------------------
export FAKE_FAIL_ON=MARK_BETA
run --cluster vitana-aurora-rehearsal --list "$WORK/list-ok.txt"
unset FAKE_FAIL_ON
[ "$RC" = 1 ] || die "failing run: rc=$RC, want 1"
grep -qx "OK $A" "$WORK/out" || die "failing run: alpha not reported OK"
grep -qx "FAILED $B (apply exit [0-9]*)" "$WORK/out" || die "failing run: beta not reported FAILED"
! grep -q "gamma" "$WORK/out" || die "failing run: gamma reported after the failure"
grep -q "beta" "$WORK/err" && grep -q "FAILED at statement" "$WORK/err" || die "failing run: error does not name beta"
grep -q "fake syntax error" "$WORK/err" || die "failing run: aws error text not printed"
grep -q "1 file(s) after" "$WORK/run.log" || die "failing run: remaining-files line missing"
grep -q "MARK_ALPHA" "$FAKE_LOG.sql" && grep -q "MARK_BETA" "$FAKE_LOG.sql" || die "failing run: earlier files not sent"
! grep -q "MARK_GAMMA" "$FAKE_LOG.sql" || die "failing run: a later file's SQL was sent"
ok "failure in beta: alpha applied, beta FAILED and named with its error, gamma never sent, exit 1"

# ---- 5. all files OK ----------------------------------------------------------------
run --cluster vitana-aurora-rehearsal --list "$WORK/list-ok.txt"
[ "$RC" = 0 ] || die "all-OK run: rc=$RC"
[ "$(grep -c '^OK ' "$WORK/out")" = 3 ] || die "all-OK run: want 3 OK lines"
[ "$(grep -c 'FAILED' "$WORK/out")" = 0 ] || die "all-OK run: a FAILED line"
[ "$(grep '^OK ' "$WORK/out" | sed 's/^OK //' | tr '\n' ' ')" = "$A $B $G " ] || die "all-OK run: order wrong"
[ "$(grep -o 'MARK_[A-Z]*' "$FAKE_LOG.sql" | tr '\n' ' ')" = "MARK_ALPHA MARK_BETA MARK_GAMMA " ] || die "all-OK run: SQL order wrong"
grep -q "vitana-aurora-prod" "$FAKE_LOG" && die "all-OK run: production cluster named in an aws call"
grep -q -- "--db-cluster-identifier vitana-aurora-rehearsal" "$FAKE_LOG" || die "all-OK run: rehearsal cluster not used"
[ "$(grep -c 'begin-transaction' "$FAKE_LOG")" = 3 ] || die "all-OK run: one transaction per file expected"
[ "$(grep -c 'commit-transaction' "$FAKE_LOG")" = 3 ] || die "all-OK run: commit per file expected"
grep -qx "All 3 file(s) applied to vitana-aurora-rehearsal" "$WORK/run.log" || die "all-OK run: summary line missing"
run --cluster vitana-aurora-rehearsal --list "$WORK/list-ok-one.txt"
[ "$RC" = 0 ] && [ "$(grep -c '^OK ' "$WORK/out")" = 1 ] || die "one-file list"
ok "all files OK: one OK line per file in list order, one transaction per file, rehearsal cluster only, exit 0"

# ---- 6. the apply script's override accepts only production or the rehearsal clone -------
rm -f "$FAKE_LOG"; : > "$FAKE_LOG"
set +e
PATH="$WORK/bin:$PATH" AURORA_APPLY_CLUSTER=vitana-aurora-prod-2 bash "$ROOT/scripts/aws/aurora-apply-migration.sh" --file "$A" > "$WORK/out" 2> "$WORK/err"
RC=$?
set -e
[ "$RC" = 2 ] && grep -q "is not an apply target" "$WORK/err" && [ "$(aws_calls)" = 0 ] || die "apply script accepted AURORA_APPLY_CLUSTER=vitana-aurora-prod-2"
ok "aurora-apply-migration.sh refuses an AURORA_APPLY_CLUSTER other than production or the rehearsal clone, before any aws call"

echo "PASS rehearsal-apply-migrations ($PASS checks)"
