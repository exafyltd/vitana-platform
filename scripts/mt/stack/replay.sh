#!/usr/bin/env bash
# mt-guardrails-r2 / local-test-stack: build the schema by replaying the
# committed migrations on the local stack. This replay is the only schema
# source; no dump, no live endpoint.
#
# Applies the top-level supabase/migrations/*.sql files (subdirectories such as
# data-fixups/ are not replayed) in filename (= timestamp) order, byte-wise
# (LC_ALL=C), one file per transaction (psql --single-transaction,
# ON_ERROR_STOP=1), through `docker exec` into the local container.
# A file that contains a statement PostgreSQL refuses inside a transaction
# block (CREATE/DROP INDEX CONCURRENTLY, REINDEX ... CONCURRENTLY,
# ALTER TYPE ... ADD VALUE, VACUUM) runs without the wrapping transaction,
# still with ON_ERROR_STOP=1.
# Files listed in supabase/tests/local-stack/replay-skip.json are skipped; after
# the replay each skipped file is tried once more, and one that now applies is
# reported as a stale skip (it must leave the list).
#
# Usage: scripts/mt/stack/replay.sh [--discover]
#   default     stop at the first failing file (exit 1); a stale skip also exits 1.
#   --discover  record every failure and keep going; exit 0 unless the replay
#               itself could not run. The caller reads the report.
#               Multi-pass: after the first pass the failed files are retried
#               in timestamp order, pass after pass, until a pass applies
#               nothing new (at most MT_REPLAY_MAX_PASSES passes in all,
#               default 5). Each file keeps the error of its last attempt.
# Output: $OUT_DIR/replay-report.json and $OUT_DIR/replay-logs/<file>.log
set -euo pipefail

CONTAINER="${MT_STACK_CONTAINER:-mt-local-stack}"
DB_USER="${MT_STACK_DB_USER:-postgres}"
export PGPASSWORD="${POSTGRES_PASSWORD:-postgres}"
OUT_DIR="${OUT_DIR:-${TMPDIR:-/tmp}/mt-stack}"

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MIGRATIONS="$ROOT/supabase/migrations"
SKIP_FILE="$ROOT/supabase/tests/local-stack/replay-skip.json"

DISCOVER=0
for arg in "$@"; do
  case "$arg" in
    --discover) DISCOVER=1 ;;
    *) echo "replay.sh: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

[ -f "$SKIP_FILE" ] || { echo "replay.sh: missing $SKIP_FILE" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "replay.sh: python3 not found" >&2; exit 2; }

LOG_DIR="$OUT_DIR/replay-logs"
mkdir -p "$LOG_DIR"
RESULTS="$OUT_DIR/replay-results.tsv"
: > "$RESULTS"

# Skip-list: a JSON array of {file, error, reason}; every field required.
skip_names="$(python3 - "$SKIP_FILE" <<'PY'
import json, sys
entries = json.load(open(sys.argv[1], encoding="utf-8"))
if not isinstance(entries, list):
    sys.exit("replay-skip.json must be a JSON array")
for i, e in enumerate(entries):
    if not isinstance(e, dict) or not all(isinstance(e.get(k), str) and e.get(k) for k in ("file", "error", "reason")):
        sys.exit(f"replay-skip.json entry {i} needs non-empty string fields file, error, reason")
    print(e["file"])
PY
)"
SKIPS=()
if [ -n "$skip_names" ]; then
  mapfile -t SKIPS <<< "$skip_names"
fi

is_skipped() {
  local name="$1" s
  for s in "${SKIPS[@]}"; do
    [ "$s" = "$name" ] && return 0
  done
  return 1
}

MAX_PASSES="${MT_REPLAY_MAX_PASSES:-5}"
case "$MAX_PASSES" in ''|*[!0-9]*) echo "replay.sh: MT_REPLAY_MAX_PASSES must be a positive integer" >&2; exit 2 ;; esac
[ "$MAX_PASSES" -ge 1 ] || { echo "replay.sh: MT_REPLAY_MAX_PASSES must be >= 1" >&2; exit 2; }

needs_no_txn() {
  # $1 = path. True when the file holds a statement that cannot run inside a
  # transaction block. A match inside a comment only drops the wrapper (the
  # file then loses atomicity, nothing else).
  grep -Eiq '(create[[:space:]]+(unique[[:space:]]+)?index[[:space:]]+concurrently|drop[[:space:]]+index[[:space:]]+concurrently|reindex[[:space:]]+.*concurrently|alter[[:space:]]+type[[:space:]].*[[:space:]]add[[:space:]]+value|^[[:space:]]*vacuum\b)' "$1"
}

apply_file() {
  # $1 = path, $2 = log file. Returns psql's exit status.
  local txn=(--single-transaction)
  if needs_no_txn "$1"; then
    txn=()
    echo "replay.sh: $(basename "$1"): non-transactional (CONCURRENTLY / ADD VALUE / VACUUM)" > "$2"
  else
    : > "$2"
  fi
  docker exec -i -e PGPASSWORD "$CONTAINER" \
    psql -X -q -h 127.0.0.1 -U "$DB_USER" -d postgres \
      -v ON_ERROR_STOP=1 "${txn[@]}" -f - < "$1" >> "$2" 2>&1
}

first_error() {
  local line
  line="$(grep -m1 'ERROR:' "$1" || true)"
  [ -n "$line" ] || line="$(tail -n 1 "$1" || true)"
  printf '%s' "$line" | tr '\t\r\n' '   '
}

write_report() {
  python3 - "$RESULTS" "$OUT_DIR/replay-report.json" "$DISCOVER" "$PASSES_RUN" <<'PY'
import json, sys
results_path, out_path, discover = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
passes_run = int(sys.argv[4])
rows = []
with open(results_path, encoding="utf-8", errors="replace") as fh:
    for line in fh:
        parts = line.rstrip("\n").split("\t")
        while len(parts) < 4:
            parts.append("")
        rows.append({"file": parts[0], "status": parts[1], "error": parts[2], "pass": parts[3]})
def pick(status):
    return [r for r in rows if r["status"] == status]
report = {
    "mode": "discover" if discover else "strict",
    "passes": passes_run,
    "applied_after_pass_1": len([r for r in rows if r["status"] == "applied" and r["pass"] not in ("", "1")]),
    "total": len([r for r in rows if r["status"] in ("applied", "failed", "skipped")]),
    "applied": len(pick("applied")),
    "skipped": len(pick("skipped")),
    "failed": [{"file": r["file"], "error": r["error"], "attempts": int(r["pass"] or 1)} for r in pick("failed")],
    "skips_still_failing": [{"file": r["file"], "error": r["error"]} for r in pick("skip_still_failing")],
    "stale_skips": [r["file"] for r in pick("stale_skip")],
}
with open(out_path, "w", encoding="utf-8") as fh:
    json.dump(report, fh, indent=2)
    fh.write("\n")
print(f"replay.sh: report {out_path}: total={report['total']} applied={report['applied']} "
      f"skipped={report['skipped']} failed={len(report['failed'])} stale_skips={len(report['stale_skips'])} "
      f"passes={report['passes']} applied_after_pass_1={report['applied_after_pass_1']}")
PY
}

mapfile -t FILES < <(find "$MIGRATIONS" -mindepth 1 -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | LC_ALL=C sort)
[ "${#FILES[@]}" -gt 0 ] || { echo "replay.sh: no migrations in $MIGRATIONS" >&2; exit 2; }

echo "replay.sh: ${#FILES[@]} migrations, ${#SKIPS[@]} on the skip-list, mode=$([ "$DISCOVER" -eq 1 ] && echo discover || echo strict)"

# Per-file final state: STATUS[name] = applied|failed|skipped,
# ERR[name] = error of the last attempt, PASS_OF[name] = pass of the last attempt.
declare -A STATUS=() ERR=() PASS_OF=()
PASSES_RUN=0

attempt() {
  # $1 = name, $2 = pass number. Returns 0 when applied.
  local name="$1" pass="$2" log="$LOG_DIR/$1.log"
  [ "$pass" -gt 1 ] && log="$LOG_DIR/$1.pass$pass.log"
  PASS_OF["$name"]="$pass"
  if apply_file "$MIGRATIONS/$name" "$log"; then
    STATUS["$name"]=applied
    ERR["$name"]=""
    return 0
  fi
  STATUS["$name"]=failed
  ERR["$name"]="$(first_error "$log")"
  return 1
}

flush_results() {
  : > "$RESULTS"
  local name
  for name in "${FILES[@]}"; do
    [ -n "${STATUS[$name]:-}" ] || continue
    printf '%s\t%s\t%s\t%s\n' "$name" "${STATUS[$name]}" "${ERR[$name]:-}" "${PASS_OF[$name]:-}" >> "$RESULTS"
  done
}

# Pass 1: every file in timestamp order.
PASSES_RUN=1
PENDING=()
for name in "${FILES[@]}"; do
  if [ "${#SKIPS[@]}" -gt 0 ] && is_skipped "$name"; then
    STATUS["$name"]=skipped
    continue
  fi
  if ! attempt "$name" 1; then
    echo "replay.sh: FAIL $name: ${ERR[$name]}" >&2
    if [ "$DISCOVER" -ne 1 ]; then
      flush_results
      write_report
      exit 1
    fi
    PENDING+=("$name")
  fi
done

# Passes 2..MAX_PASSES (discover only): retry the failed files in timestamp
# order until a pass applies nothing new.
if [ "$DISCOVER" -eq 1 ]; then
  while [ "${#PENDING[@]}" -gt 0 ] && [ "$PASSES_RUN" -lt "$MAX_PASSES" ]; do
    PASSES_RUN=$(( PASSES_RUN + 1 ))
    still=()
    newly=0
    for name in "${PENDING[@]}"; do
      if attempt "$name" "$PASSES_RUN"; then
        newly=$(( newly + 1 ))
        echo "replay.sh: pass $PASSES_RUN applied $name"
      else
        still+=("$name")
      fi
    done
    echo "replay.sh: pass $PASSES_RUN: $newly newly applied, ${#still[@]} still failing"
    PENDING=("${still[@]+"${still[@]}"}")
    [ "$newly" -gt 0 ] || break
  done
  for name in "${PENDING[@]+"${PENDING[@]}"}"; do
    echo "replay.sh: FINAL FAIL $name (attempts ${PASS_OF[$name]}): ${ERR[$name]}" >&2
  done
fi
failed="${#PENDING[@]}"
flush_results

# Re-check the skip-list: every entry must still fail.
stale=0
for name in "${SKIPS[@]}"; do
  if [ ! -f "$MIGRATIONS/$name" ]; then
    printf '%s\tstale_skip\tfile not found\n' "$name" >> "$RESULTS"
    stale=$(( stale + 1 ))
    continue
  fi
  log="$LOG_DIR/$name.skipcheck.log"
  if apply_file "$MIGRATIONS/$name" "$log"; then
    printf '%s\tstale_skip\t\n' "$name" >> "$RESULTS"
    echo "replay.sh: STALE SKIP $name now applies; remove it from replay-skip.json" >&2
    stale=$(( stale + 1 ))
  else
    printf '%s\tskip_still_failing\t%s\n' "$name" "$(first_error "$log")" >> "$RESULTS"
  fi
done

write_report

if [ "$DISCOVER" -ne 1 ] && [ $(( failed + stale )) -gt 0 ]; then
  exit 1
fi
exit 0
