#!/usr/bin/env bash
# VTID-05023 part 10: applies the cutover migration set to the rehearsal clone
# (vitana-aurora-rehearsal) through the RDS Data API, one file per call, in the
# order of a list file. Stops at the first failing file.
#
#   rehearsal-apply-migrations.sh --cluster vitana-aurora-rehearsal --list <file> [--log <file>]
#
# List file (agent G writes the order to docs/validation/VTID-05023/migration-order.md):
#   - one migration path per line, in apply order. A relative path resolves from the repo root.
#   - blank lines and lines starting with # are ignored.
#   - every entry must name an existing .sql file.
#
# Checked before any AWS call: --cluster is exactly vitana-aurora-rehearsal; the held drop
# 20261102052300_vtid_05573_legacy_messages_drop.sql is not in the list; every entry exists and
# is listed once. A refusal writes nothing, not even the log file.
#
# Each file goes through scripts/aws/aurora-apply-migration.sh with AURORA_APPLY_CLUSTER set to
# the rehearsal cluster. That script does the transaction, statement split and guards.
#
# Output: one line per file, "OK <file>" or "FAILED <file>", on stdout and in the log. The
# apply output of every file goes to the log. For a failing file it is also printed to stderr.
# Exit: 0 all applied; 1 a file failed, later files not run; 2 refused before any AWS call.
# Reads SQL only through the apply script; it never reads or prints credentials. The apply
# script prints the first 100 characters of each statement, so its output is in the log.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
APPLY="$HERE/aurora-apply-migration.sh"
TARGET=vitana-aurora-rehearsal
HELD=20261102052300_vtid_05573_legacy_messages_drop.sql

CLUSTER=""; LIST=""; LOG=""
usage() { echo "usage: $0 --cluster vitana-aurora-rehearsal --list <file> [--log <file>]" >&2; exit 2; }
refuse() { echo "::error::REFUSED: $*" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --cluster) [ $# -ge 2 ] || usage; CLUSTER="$2"; shift 2 ;;
    --list) [ $# -ge 2 ] || usage; LIST="$2"; shift 2 ;;
    --log) [ $# -ge 2 ] || usage; LOG="$2"; shift 2 ;;
    *) echo "::error::unknown argument: $1" >&2; usage ;;
  esac
done

[ "$CLUSTER" = "$TARGET" ] || refuse "cluster '$CLUSTER' is not $TARGET. Nothing was run."
[ -n "$LIST" ] || usage
[ -f "$LIST" ] || refuse "list file not found: $LIST"

# Read and check the whole list first, so a bad entry stops the run before any AWS call.
ENTRIES=(); PATHS=()
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  line="${line#"${line%%[![:space:]]*}"}"   # trim leading blanks
  line="${line%"${line##*[![:space:]]}"}"   # trim trailing blanks
  case "$line" in ''|'#'*) continue ;; esac
  case "$line" in *.sql) ;; *) refuse "list entry is not a .sql file: $line" ;; esac
  path="$line"
  case "$path" in /*) ;; *) path="$ROOT/$path" ;; esac
  [ "$(basename "$path")" != "$HELD" ] || refuse "$line is the held drop and is excluded from the cutover. Nothing was run."
  [ -f "$path" ] || refuse "file not found: $line"
  for seen in "${ENTRIES[@]}"; do
    [ "$seen" != "$line" ] || refuse "$line is listed twice"
  done
  ENTRIES+=("$line"); PATHS+=("$path")
done < "$LIST"
[ "${#ENTRIES[@]}" -gt 0 ] || refuse "list file has no migrations: $LIST"

LOG="${LOG:-rehearsal-apply-migrations-$(date -u +%Y%m%dT%H%M%SZ).log}"
: > "$LOG"
say() { printf '%s\n' "$*" | tee -a "$LOG"; }

N="${#ENTRIES[@]}"
say "Rehearsal apply: $N file(s) from $LIST to $TARGET"
for i in "${!ENTRIES[@]}"; do
  name="${ENTRIES[$i]}"
  start=$(wc -l < "$LOG")
  if AURORA_APPLY_CLUSTER="$TARGET" bash "$APPLY" --file "${PATHS[$i]}" >> "$LOG" 2>&1; then
    say "OK $name"
  else
    rc=$?
    say "FAILED $name (apply exit $rc)"
    echo "::error::stopped at $name (file $((i+1)) of $N). Its output:" >&2
    tail -n +"$((start+1))" "$LOG" >&2
    say "Stopped: $((N-i-1)) file(s) after $name were not run"
    exit 1
  fi
done
say "All $N file(s) applied to $TARGET"
