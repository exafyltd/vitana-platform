#!/usr/bin/env bash
# VTID-05446 (mt-guardrails-r2/isolation-suite): run scripts/ci/sql-tests/mt-isolation.test.sql on the PGlite local stack
# (scripts/mt/stack) through the pgTAP-compatible shim. Real pgTAP and pg_prove are not used on this stack
# (.kiro/specs/mt-guardrails-r2/plan.md Amendment 2, decision 7). Needs Node and `pnpm install` (the pinned PGlite); no
# database server, no network, no secret.
#
#   run-mt-isolation-test.sh                run the suite; unverified tables are listed, never counted as passed
#   run-mt-isolation-test.sh --strict       the same, but a table the stack cannot replay FAILS the suite (Amendment 3, decision 3)
#   run-mt-isolation-test.sh --self-test    prove the PGHOST guard: PGHOST=x.supabase.co must exit 2 before anything runs
#
# Every claim this suite makes is on NON-PRODUCTION tenant resolution and policies (docs/multitenancy/LOCAL-STACK.md,
# "Isolation gap on the present tables"). The last line, `PASS mt-isolation`, is printed only after the run exits 0.
set -euo pipefail
case "${PGHOST:-local}" in
  *supabase*|*amazonaws*|*rds*) echo "refusing: PGHOST=${PGHOST} is not a throwaway database" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SPEC="$ROOT/scripts/ci/sql-tests/mt-isolation.test.sql"
REQUIRED="$ROOT/supabase/tests/local-stack/required-tables.txt"
HEALTH="$ROOT/scripts/mt/inventory/health-tables.mjs"
TAP="$ROOT/scripts/mt/stack/run-tap.mjs"

STRICT="${MT_ISOLATION_STRICT:-0}"
case "${1:-}" in
  --strict) STRICT=1 ;;
  --self-test)
    rc=0
    PGHOST=x.supabase.co bash "$0" >/dev/null 2>&1 || rc=$?
    if [ "$rc" -ne 2 ]; then echo "self-test FAILED: PGHOST=x.supabase.co exited $rc, expected 2" >&2; exit 1; fi
    echo "self-test ok: PGHOST=x.supabase.co exits 2 before anything runs"
    exit 0 ;;
  "") ;;
  *) echo "usage: $0 [--strict|--self-test]" >&2; exit 64 ;;
esac

for f in "$SPEC" "$REQUIRED" "$HEALTH" "$TAP"; do
  [ -f "$f" ] || { echo "missing: $f" >&2; exit 2; }
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
OUT="$WORK/output.txt"

# the shared health-table list (scripts/mt/inventory/health-tables.json via health-tables.mjs): read, never copied
HEALTH_LIST="$(node --input-type=module -e "import { HEALTH_TABLES } from '$HEALTH'; process.stdout.write(HEALTH_TABLES.join(','))")"
[ -n "$HEALTH_LIST" ] || { echo "empty health-table list" >&2; exit 2; }
REQUIRED_LIST="$(grep -v '^[[:space:]]*#' "$REQUIRED" | grep -v '^[[:space:]]*$' | paste -sd, -)"

FILE="$WORK/mt-isolation.tap.sql"
{
  echo "SELECT set_config('mt.health_tables', '$HEALTH_LIST', false);"
  echo "SELECT set_config('mt.required_tables', '$REQUIRED_LIST', false);"
  echo "SELECT set_config('mt.strict', '$STRICT', false);"
  cat "$SPEC"
} > "$FILE"

rc=0
node "$TAP" "$FILE" > "$OUT" 2>&1 || rc=$?
cat "$OUT"
if [ "$rc" -ne 0 ]; then
  echo "FAIL mt-isolation (run-tap exit $rc)" >&2
  exit 1
fi
UNVERIFIED="$(grep -c '^# UNVERIFIED' "$OUT" || true)"
echo "mt-isolation: ${UNVERIFIED} claim(s) UNVERIFIED (not passed, not failed); strict=${STRICT}. Passed claims are on non-production tenant resolution (docs/multitenancy/LOCAL-STACK.md)."
echo "PASS mt-isolation"
