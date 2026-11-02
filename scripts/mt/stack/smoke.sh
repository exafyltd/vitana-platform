#!/usr/bin/env bash
# mt-guardrails-r2 / local-test-stack: end-to-end smoke of the disposable local
# stack (the T0 spike and the T5 smoke test, docs/multitenancy/LOCAL-STACK.md).
#
#   1. up.sh                      boot the pinned image, digest checked
#   2. auth.users pre-exists      to_regclass before any replay
#   3. pgtap spike                pg_available_extensions + CREATE EXTENSION
#   4. replay.sh --discover       every failing migration recorded
#   5. required tables            supabase/tests/local-stack/required-tables.txt
#   6. seed.sh twice              fixture row counts identical (idempotency)
#   7. pg_prove                   supabase/tests/local-stack/*.sql, from an
#                                 ubuntu:24.04 container with the pinned apt package
#
# Every step runs (except after a failed boot); the script prints a summary
# block and exits non-zero if any step failed. Evidence goes to $OUT_DIR.
# Nothing here connects to a remote host: the database is the local container.
# Env: OUT_DIR (default ${TMPDIR:-/tmp}/mt-stack), MT_STACK_KEEP=1 keeps the
# container running afterwards.
set -euo pipefail

PG_PROVE_APT="libtap-parser-sourcehandler-pgtap-perl=3.36-2"
PG_PROVE_IMAGE="ubuntu:24.04"
CONTAINER="${MT_STACK_CONTAINER:-mt-local-stack}"
DB_USER="${MT_STACK_DB_USER:-postgres}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-postgres}"
export PGPASSWORD="$POSTGRES_PASSWORD"
export OUT_DIR="${OUT_DIR:-${TMPDIR:-/tmp}/mt-stack}"
export MT_STACK_CONTAINER="$CONTAINER" MT_STACK_DB_USER="$DB_USER"

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
REQUIRED="$ROOT/supabase/tests/local-stack/required-tables.txt"
TESTS_DIR="$ROOT/supabase/tests/local-stack"

mkdir -p "$OUT_DIR"
SUMMARY="$OUT_DIR/smoke-summary.txt"
: > "$SUMMARY"
FAILURES=0

record() {
  # $1 = PASS|FAIL|INFO, $2 = step, $3 = detail
  printf '%-4s %-22s %s\n' "$1" "$2" "$3" >> "$SUMMARY"
  [ "$1" = "FAIL" ] && FAILURES=$(( FAILURES + 1 ))
  return 0
}

q() {
  docker exec -e PGPASSWORD "$CONTAINER" \
    psql -X -q -At -h 127.0.0.1 -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 -c "$1"
}

print_summary() {
  echo
  echo "================ MT LOCAL STACK SMOKE SUMMARY ================"
  cat "$SUMMARY"
  echo "--------------------------------------------------------------"
  echo "evidence: $OUT_DIR"
  if [ "$FAILURES" -eq 0 ]; then
    echo "RESULT: PASS"
  else
    echo "RESULT: FAIL ($FAILURES failing step(s))"
  fi
  echo "=============================================================="
}

cleanup() {
  if [ "${MT_STACK_KEEP:-0}" != "1" ]; then
    bash "$HERE/down.sh" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# 1. Boot
if bash "$HERE/up.sh" 2>&1 | tee "$OUT_DIR/up.log"; then
  record PASS up "supabase/postgres:17.4.1.074 booted, digest verified"
else
  record FAIL up "boot failed, see up.log"
  print_summary
  exit 1
fi
docker image inspect --format '{{join .RepoDigests " "}}' supabase/postgres:17.4.1.074 > "$OUT_DIR/image-digest.txt" || true

# 2. auth.users before the replay
if [ "$(q "SELECT to_regclass('auth.users') IS NOT NULL")" = "t" ]; then
  record PASS auth.users "pre-exists before replay"
else
  record FAIL auth.users "to_regclass('auth.users') is NULL before replay"
fi

# 3. pgtap spike
avail="$(q "SELECT name, default_version FROM pg_available_extensions WHERE name='pgtap'" 2>&1 || true)"
echo "pgtap available: ${avail:-<none>}" | tee "$OUT_DIR/pgtap-spike.txt"
if create_out="$(q "CREATE EXTENSION IF NOT EXISTS pgtap" 2>&1)"; then
  installed="$(q "SELECT extversion FROM pg_extension WHERE extname='pgtap'" 2>&1 || true)"
  echo "CREATE EXTENSION IF NOT EXISTS pgtap: ok (installed ${installed:-?}) ${create_out}" | tee -a "$OUT_DIR/pgtap-spike.txt"
  record PASS pgtap "available '${avail}', installed ${installed:-?}"
else
  echo "CREATE EXTENSION IF NOT EXISTS pgtap: FAILED: $create_out" | tee -a "$OUT_DIR/pgtap-spike.txt"
  record FAIL pgtap "CREATE EXTENSION failed: $create_out"
fi

# 4. Replay (discover)
if bash "$HERE/replay.sh" --discover 2>&1 | tee "$OUT_DIR/replay.log"; then
  read -r n_failed n_stale n_applied n_total < <(python3 - "$OUT_DIR/replay-report.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1], encoding="utf-8"))
print(len(r["failed"]), len(r["stale_skips"]), r["applied"], r["total"])
PY
  )
  if [ "$n_failed" -eq 0 ] && [ "$n_stale" -eq 0 ]; then
    record PASS replay "$n_applied/$n_total applied, skip-list entries still failing"
  else
    record FAIL replay "$n_failed failing, $n_stale stale skip(s); see replay-report.json"
    python3 - "$OUT_DIR/replay-report.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1], encoding="utf-8"))
for f in r["failed"]:
    print(f"  replay FAIL {f['file']}: {f['error']}")
for f in r["stale_skips"]:
    print(f"  replay STALE SKIP {f}")
PY
  fi
else
  record FAIL replay "replay.sh could not run, see replay.log"
fi

# 5. Required tables
missing=()
present=0
while IFS= read -r line; do
  name="${line%%#*}"
  name="${name//[[:space:]]/}"
  [ -n "$name" ] || continue
  case "$name" in *.*) qualified="$name" ;; *) qualified="public.$name" ;; esac
  if [ "$(q "SELECT to_regclass('$qualified') IS NOT NULL")" = "t" ]; then
    present=$(( present + 1 ))
    echo "present $qualified"
  else
    missing+=("$qualified")
    echo "MISSING $qualified"
  fi
done < "$REQUIRED" > "$OUT_DIR/required-tables.txt"
cat "$OUT_DIR/required-tables.txt"
if [ "${#missing[@]}" -eq 0 ]; then
  record PASS required-tables "$present present"
else
  record FAIL required-tables "${#missing[@]} missing: ${missing[*]}"
fi

# 6. Seed twice
fixture_counts() {
  q "SELECT
       (SELECT count(*) FROM public.tenants WHERE id IN ('0a000000-0000-4000-8000-00000000000a','0b000000-0000-4000-8000-00000000000b')) || ' ' ||
       (SELECT count(*) FROM auth.users WHERE email LIKE '%@vitanatest.exafy.io') || ' ' ||
       (SELECT count(*) FROM public.user_tenants WHERE tenant_id IN ('0a000000-0000-4000-8000-00000000000a','0b000000-0000-4000-8000-00000000000b'))"
}
if bash "$HERE/seed.sh" 2>&1 | tee "$OUT_DIR/seed-1.log"; then
  counts1="$(fixture_counts 2>&1 || true)"
  if bash "$HERE/seed.sh" 2>&1 | tee "$OUT_DIR/seed-2.log"; then
    counts2="$(fixture_counts 2>&1 || true)"
    if [ "$counts1" = "$counts2" ]; then
      record PASS seed "loaded twice, counts identical (tenants users memberships: $counts1)"
    else
      record FAIL seed "not idempotent: first '$counts1', second '$counts2'"
    fi
  else
    record FAIL seed "second load failed, see seed-2.log"
  fi
else
  record FAIL seed "first load failed, see seed-1.log"
fi

# 7. pg_prove from ubuntu:24.04 with the pinned apt package, sharing the
# stack container's network namespace (127.0.0.1 is the local stack).
if docker run --rm \
  --network "container:$CONTAINER" \
  -e PGPASSWORD \
  -e DEBIAN_FRONTEND=noninteractive \
  -v "$TESTS_DIR:/tests:ro" \
  "$PG_PROVE_IMAGE" \
  bash -c "set -euo pipefail
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends $PG_PROVE_APT postgresql-client >/dev/null
    dpkg-query -W libtap-parser-sourcehandler-pgtap-perl
    pg_prove --verbose -h 127.0.0.1 -p 5432 -U $DB_USER -d postgres /tests/*.sql" \
  2>&1 | tee "$OUT_DIR/pg_prove.log"; then
  record PASS pg_prove "$PG_PROVE_APT on $PG_PROVE_IMAGE, all pgTAP files pass"
else
  record FAIL pg_prove "pgTAP failures or install error, see pg_prove.log"
fi

print_summary
[ "$FAILURES" -eq 0 ]
