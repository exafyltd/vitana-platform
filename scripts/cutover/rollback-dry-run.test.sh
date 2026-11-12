#!/usr/bin/env bash
# Tests for rollback-dry-run.sh. A PATH stub for aws logs every call and fails.
# Each test that must not touch AWS asserts the call log is empty.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SCRIPT="$HERE/rollback-dry-run.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

STUB_DIR="$WORK/bin"
CALLS="$WORK/aws-calls.log"
mkdir -p "$STUB_DIR"
: > "$CALLS"
cat > "$STUB_DIR/aws" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$CALLS"
exit 1
EOF
chmod +x "$STUB_DIR/aws"

FAILS=0
PASSES=0

pass() { PASSES=$((PASSES + 1)); echo "PASS: $1"; }
fail() { FAILS=$((FAILS + 1)); echo "FAIL: $1"; }

# run <args...>: sets RC and OUT, clears the aws call log first.
run() {
  : > "$CALLS"
  OUT=$(PATH="$STUB_DIR:$PATH" bash "$SCRIPT" "$@" 2>&1)
  RC=$?
}

no_aws_calls() {
  [[ ! -s "$CALLS" ]]
}

# 1. No arguments: refused, names the required revision, no AWS call.
run
if (( RC != 0 )) && grep -q -- '--previous-revision' <<<"$OUT" && no_aws_calls; then
  pass "no arguments is refused and names --previous-revision"
else
  fail "no arguments (rc=$RC)"; echo "$OUT"
fi

# 2. Dry run with a revision: exits 0, steps print in order 1, 2, 3, nothing executed.
run --previous-revision 41
l1=$(grep -n '^STEP 1:' <<<"$OUT" | cut -d: -f1)
l2=$(grep -n '^STEP 2:' <<<"$OUT" | cut -d: -f1)
l3=$(grep -n '^STEP 3:' <<<"$OUT" | cut -d: -f1)
if (( RC == 0 )) && [[ -n "$l1" && -n "$l2" && -n "$l3" ]] && (( l1 < l2 && l2 < l3 )); then
  pass "dry run prints steps in order 1, 2, 3"
else
  fail "step order (rc=$RC, lines $l1 $l2 $l3)"; echo "$OUT"
fi
if no_aws_calls && grep -q 'not verified: no AWS access from this sandbox' <<<"$OUT" \
  && grep -q 'owner to verify' <<<"$OUT" && grep -q 'Nothing was executed' <<<"$OUT"; then
  pass "dry run without --execute makes no AWS call and marks checks not verified"
else
  fail "dry run executed or missed the not-verified marks"; cat "$CALLS"
fi

# 3. Production target, dry run: refused, no AWS call.
run --target production --previous-revision 41
if (( RC == 3 )) && grep -q 'refused' <<<"$OUT" && no_aws_calls; then
  pass "production target refused in dry run"
else
  fail "production target dry run (rc=$RC)"; echo "$OUT"
fi

# 4. Production target with --execute --verify-aws: refused before any AWS call.
run --target production --previous-revision 41 --execute --verify-aws
if (( RC == 3 )) && grep -q 'refused' <<<"$OUT" && no_aws_calls; then
  pass "production target refused with --execute"
else
  fail "production target with --execute (rc=$RC)"; echo "$OUT"
fi

# 5. --execute without --verify-aws: refused, no AWS call.
run --previous-revision 41 --execute
if (( RC == 4 )) && no_aws_calls; then
  pass "--execute without --verify-aws is refused"
else
  fail "--execute without --verify-aws (rc=$RC)"; echo "$OUT"
fi

# 6. --execute --verify-aws with AWS unreachable: refused, and no mutating call is made.
run --previous-revision 41 --execute --verify-aws
if (( RC == 4 )) && ! grep -qE 'update-service|stop-replication-task' "$CALLS"; then
  pass "--execute refuses when checks fail, and no update or stop call is made"
else
  fail "--execute with unreachable AWS (rc=$RC)"; echo "$OUT"; cat "$CALLS"
fi

# 7. Dry run with --verify-aws and AWS unreachable: exits 0 and reports the failed checks.
run --previous-revision 41 --verify-aws
if (( RC == 0 )) && grep -q 'owner to verify' <<<"$OUT" && grep -q 'sts get-caller-identity' "$CALLS" \
  && ! grep -qE 'update-service|stop-replication-task' "$CALLS"; then
  pass "dry run with --verify-aws reports unreachable AWS and runs only read-only calls"
else
  fail "dry run with --verify-aws (rc=$RC)"; echo "$OUT"; cat "$CALLS"
fi

# 8. Non-numeric revision: refused.
run --previous-revision 41a
if (( RC == 2 )) && no_aws_calls; then
  pass "non-numeric revision is refused"
else
  fail "non-numeric revision (rc=$RC)"; echo "$OUT"
fi

echo
echo "Passed: $PASSES  Failed: $FAILS"
(( FAILS == 0 ))
