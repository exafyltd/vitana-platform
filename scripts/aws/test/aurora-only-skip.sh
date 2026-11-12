#!/usr/bin/env bash
# VTID-05023: a file marked AURORA-ONLY in its header is skipped by the Supabase apply path
# and applied by the Aurora path. No network and no database: a fake curl on PATH records
# Supabase calls, and the Aurora path runs with --dry-run.
#
#   1. marked fixture, target Supabase: skipped, exit 0, no curl call.       (passing fixture)
#   2. marker below line 30, target Supabase: not a header marker, so applied (curl called).
#   3. plain fixture, target Supabase: applied (curl called).
#   4. marked fixture, target Aurora (dry run): accepted and announced as applied to Aurora.
#
# Usage: bash scripts/aws/test/aurora-only-skip.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SUPABASE_APPLY="$ROOT/scripts/ci/apply-sql-via-management-api.sh"
AURORA_APPLY="$ROOT/scripts/aws/aurora-apply-migration.sh"
FIX="$ROOT/scripts/aws/test/fixtures/aurora-only"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"
cat > "$WORK/bin/curl" <<'EOF'
#!/usr/bin/env bash
# Fake curl: logs the call and answers HTTP 200 with an empty JSON array.
echo called >> "$FAKE_CURL_LOG"
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-o" ]; then out="$2"; fi
  shift
done
printf '[]' > "$out"
printf '200'
EOF
chmod +x "$WORK/bin/curl"

FAILS=0
pass() { echo "ok - $1"; }
fail() { echo "not ok - $1"; FAILS=$((FAILS+1)); }

# run_supabase <file>: runs the Supabase apply path in a scratch dir; sets OUT and RC, and CALLS (curl calls).
run_supabase() {
  : > "$WORK/curl.log"
  set +e
  OUT=$(cd "$WORK" && PATH="$WORK/bin:$PATH" FAKE_CURL_LOG="$WORK/curl.log" \
    SUPABASE_ACCESS_TOKEN=test-token SUPABASE_URL=https://testref.supabase.co \
    bash "$SUPABASE_APPLY" --file "$1" 2>&1)
  RC=$?
  set -e
  CALLS=$(wc -l < "$WORK/curl.log")
}

run_supabase "$FIX/aurora-only-marked.sql"
if [ "$RC" = 0 ] && [ "$CALLS" = 0 ] && printf '%s' "$OUT" | grep -q 'skipped for Supabase'; then
  pass "marked file is skipped on Supabase without a network call"
else
  fail "marked file is skipped on Supabase (rc=$RC calls=$CALLS)"; echo "$OUT"
fi

run_supabase "$FIX/aurora-only-late-marker.sql"
if [ "$RC" = 0 ] && [ "$CALLS" = 1 ]; then
  pass "marker below line 30 does not skip the file on Supabase"
else
  fail "late marker must not skip (rc=$RC calls=$CALLS)"; echo "$OUT"
fi

run_supabase "$FIX/plain.sql"
if [ "$RC" = 0 ] && [ "$CALLS" = 1 ]; then
  pass "plain file is applied on Supabase"
else
  fail "plain file must be applied (rc=$RC calls=$CALLS)"; echo "$OUT"
fi

set +e
AOUT=$(bash "$AURORA_APPLY" --file "$FIX/aurora-only-marked.sql" --dry-run 2>&1)
ARC=$?
set -e
if [ "$ARC" = 0 ] && printf '%s' "$AOUT" | grep -q 'AURORA-ONLY file: applied to Aurora' && printf '%s' "$AOUT" | grep -q 'Dry run'; then
  pass "marked file is accepted by the Aurora path"
else
  fail "Aurora path must accept the marked file (rc=$ARC)"; echo "$AOUT"
fi

if [ "$FAILS" -gt 0 ]; then echo "# $FAILS failing"; exit 1; fi
echo "# all 4 passed"
