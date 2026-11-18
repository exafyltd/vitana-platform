#!/usr/bin/env bash
# VTID-05446 (mt-guardrails-r2/isolation-suite): run scripts/ci/sql-tests/mt-isolation.test.sql on the PGlite local stack
# (scripts/mt/stack) through the pgTAP-compatible shim. Real pgTAP and pg_prove are not used on this stack
# (.kiro/specs/mt-guardrails-r2/plan.md Amendment 2, decision 7). Needs Node and `pnpm install` (the pinned PGlite); no
# database server, no network, no secret.
#
#   run-mt-isolation-test.sh                      STRICT by default: a table or claim the stack cannot verify FAILS the suite (exit 1, no PASS
#                                                 marker; Amendment 3, decision 3). Today 14 claims are unverified, so this run is red.
#   run-mt-isolation-test.sh --strict             the same as the default
#   run-mt-isolation-test.sh --report             opt-in report: lists the UNVERIFIED claims, exits 0, last line `REPORT mt-isolation: ...`;
#                                                 it NEVER prints `PASS mt-isolation`
#   run-mt-isolation-test.sh --self-test          prove the PGHOST guard: PGHOST=x.supabase.co must exit 2 before anything runs
#   run-mt-isolation-test.sh --self-test-default  prove the strict default and that --report never prints the PASS marker
#
# Every claim this suite makes is on NON-PRODUCTION tenant resolution and policies (docs/multitenancy/LOCAL-STACK.md,
# "Isolation gap on the present tables"). The last line, `PASS mt-isolation`, is printed only after a strict run exits 0 (nothing unverified).
set -euo pipefail
case "${PGHOST:-local}" in
  *supabase*|*amazonaws*|*rds*) echo "refusing: PGHOST=${PGHOST} is not a throwaway database" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SPEC="$ROOT/scripts/ci/sql-tests/mt-isolation.test.sql"
REQUIRED="$ROOT/supabase/tests/local-stack/required-tables.txt"
HEALTH="$ROOT/scripts/mt/inventory/health-tables.mjs"
TAP="$ROOT/scripts/mt/stack/run-tap.mjs"

STRICT=1   # no environment override: only --report turns strict off
REPORT=0
case "${1:-}" in
  --strict) STRICT=1 ;;
  --report) STRICT=0; REPORT=1 ;;
  --self-test)
    rc=0
    PGHOST=x.supabase.co bash "$0" >/dev/null 2>&1 || rc=$?
    if [ "$rc" -ne 2 ]; then echo "self-test FAILED: PGHOST=x.supabase.co exited $rc, expected 2" >&2; exit 1; fi
    echo "self-test ok: PGHOST=x.supabase.co exits 2 before anything runs"
    exit 0 ;;
  --self-test-default)
    # the default is strict: with unverified claims a no-argument run exits 1 and prints no PASS marker; --report never prints it
    rcr=0; rep="$(bash "$0" --report 2>&1)" || rcr=$?
    rcd=0; def="$(bash "$0" 2>&1)" || rcd=$?
    nunv="$(printf '%s\n' "$rep" | grep -c '^# UNVERIFIED' || true)"
    if [ "$rcr" -ne 0 ]; then echo "self-test-default FAILED: --report exited $rcr, expected 0" >&2; exit 1; fi
    if printf '%s\n' "$rep" | grep -q '^PASS mt-isolation'; then echo "self-test-default FAILED: --report printed the PASS marker" >&2; exit 1; fi
    if [ "$nunv" -gt 0 ]; then
      if [ "$rcd" -ne 1 ]; then echo "self-test-default FAILED: default run with $nunv unverified claim(s) exited $rcd, expected 1" >&2; exit 1; fi
      if printf '%s\n' "$def" | grep -q '^PASS mt-isolation'; then echo "self-test-default FAILED: default run printed the PASS marker over $nunv unverified claim(s)" >&2; exit 1; fi
    else
      if [ "$rcd" -ne 0 ] || ! printf '%s\n' "$def" | grep -q '^PASS mt-isolation'; then echo "self-test-default FAILED: nothing unverified but the default run did not pass" >&2; exit 1; fi
    fi
    echo "self-test-default ok: ${nunv} unverified; default exit ${rcd} without PASS marker; --report exit ${rcr} without PASS marker"
    exit 0 ;;
  "") ;;
  *) echo "usage: $0 [--report|--strict|--self-test|--self-test-default]" >&2; exit 64 ;;
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
echo "mt-isolation: ${UNVERIFIED} claim(s) UNVERIFIED (not passed); strict=${STRICT}. Passed claims are on non-production tenant resolution (docs/multitenancy/LOCAL-STACK.md)."
if [ "$REPORT" -eq 1 ]; then
  echo "REPORT mt-isolation: ${UNVERIFIED} unverified (report mode is not a pass)"
  exit 0
fi
if [ "$UNVERIFIED" -gt 0 ]; then
  echo "FAIL mt-isolation (${UNVERIFIED} unverified claim(s) in a strict run)" >&2
  exit 1
fi
echo "PASS mt-isolation"
