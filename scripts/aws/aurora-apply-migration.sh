#!/usr/bin/env bash
# Apply one migration file to Aurora (vitana-aurora-prod / vitana) over the RDS
# Data API — VTID-05023 part 8. The Aurora twin of
# scripts/ci/apply-sql-via-management-api.sh, used by RUN-MIGRATION.yml when
# the target is aurora (GitHub runners reach the VPC-private cluster only
# through the Data API, which runs ONE statement per call).
#
#   1. scripts/aws/aurora_sql_split.py cuts the file the way psql does; top-level
#      BEGIN/COMMIT are dropped (this script owns the transaction), a psql
#      meta-command or a top-level ROLLBACK is a hard error.
#   2. All statements transactional (the normal case): begin-transaction, each
#      statement with --transaction-id, commit-transaction. Any failure rolls
#      the whole file back and exits 1 naming the statement — the VTID-03174
#      ON_ERROR_STOP guarantee: a failed migration never exits 0. This matches
#      today's Supabase path, where the whole file goes in one simple query
#      (one implicit transaction).
#   3. Statements Postgres refuses inside a transaction (CREATE INDEX
#      CONCURRENTLY, VACUUM, ...): refused unless EVERY statement is one of
#      them or --allow-non-transactional is given; then they run one by one
#      without a transaction and the first failure stops the run (earlier
#      statements stay applied — said so in the output).
#   4. NOTIFY pgrst, 'reload schema' afterwards (belt and braces next to the
#      aurora-pgrst-ddl-watch.sql event trigger).
#
# Notes: ALTER TYPE ... ADD VALUE runs in the transaction (PG >= 12), but the
# new value cannot be used before COMMIT — split such a file in two. A Data API
# call has a 45 s limit; a slower statement fails the run and rolls back.
#
# Usage: aurora-apply-migration.sh --file <path> [--dry-run] [--allow-non-transactional]
# Env:   MIGRATION_FREEZE=true refuses (cutover schema freeze, runbook part 8).
#        AURORA_DATAAPI_RETRY_SLEEP (default 15) / _TRIES (default 40): wait while
#        the Data API endpoint is still being enabled.
set -euo pipefail

R=eu-central-1
ACCOUNT=472838866351
CLUSTER=vitana-aurora-prod
DB=vitana
HERE="$(cd "$(dirname "$0")" && pwd)"
RETRY_SLEEP="${AURORA_DATAAPI_RETRY_SLEEP:-15}"
RETRY_TRIES="${AURORA_DATAAPI_RETRY_TRIES:-40}"
MAX_SQL_BYTES=65536   # Data API limit for the sql parameter

FILE=""; DRY_RUN=0; ALLOW_NONTX=0
while [ $# -gt 0 ]; do
  case "$1" in
    --file) FILE="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --allow-non-transactional) ALLOW_NONTX=1; shift ;;
    *) echo "::error::unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$FILE" ] || { echo "::error::usage: $0 --file <path> [--dry-run] [--allow-non-transactional]" >&2; exit 2; }
[ -f "$FILE" ] || { echo "::error::SQL file not found: $FILE" >&2; exit 1; }
if [ "${MIGRATION_FREEZE:-}" = "true" ]; then
  echo "::error::MIGRATION_FREEZE=true — schema freeze for the Aurora cutover window (final load to flip). No migrations until it is lifted." >&2
  exit 1
fi

WORK="$(mktemp -d)"
TX_ID=""
cleanup() {
  if [ -n "$TX_ID" ]; then
    echo "Rolling back open transaction" >&2
    aws rds-data rollback-transaction --region "$R" --resource-arn "$CLUSTER_ARN" \
      --secret-arn "$SECRET_ARN" --transaction-id "$TX_ID" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

PLAN="$WORK/plan.json"
python3 "$HERE/aurora_sql_split.py" "$FILE" --out "$PLAN"   # errors -> exit 1 (set -e)

N=$(jq '.counts.statements' "$PLAN")
NONTX=$(jq '.counts.non_transactional' "$PLAN")
DROPPED=$(jq '.counts.dropped' "$PLAN")
echo "Plan for $FILE: $N statement(s), $NONTX non-transactional, $DROPPED transaction-control statement(s) dropped"
jq -r '.dropped[] | "  dropped (line \(.line)): \(.sql | gsub("\\s+"; " ") | .[0:80])"' "$PLAN"
jq -r '.statements[] | "  \(.n). line \(.line)\(if .transactional then "" else " [NON-TRANSACTIONAL]" end): \(.sql | gsub("\\s+"; " ") | .[0:100])"' "$PLAN"

[ "$N" -gt 0 ] || { echo "::error::$FILE contains no SQL statements" >&2; exit 1; }
TOO_BIG=$(jq --argjson max "$MAX_SQL_BYTES" '[.statements[] | select((.sql | utf8bytelength) > $max) | .n] | join(",")' -r "$PLAN")
if [ -n "$TOO_BIG" ]; then
  echo "::error::statement(s) $TOO_BIG exceed the Data API's ${MAX_SQL_BYTES}-byte sql limit" >&2; exit 1
fi

MODE=transaction
if [ "$NONTX" -gt 0 ]; then
  if [ "$NONTX" -eq "$N" ] || [ "$ALLOW_NONTX" = 1 ]; then
    MODE=autocommit
  else
    echo "::error::$FILE mixes $NONTX non-transactional statement(s) (e.g. CREATE INDEX CONCURRENTLY) with transactional ones. Split the file, or pass --allow-non-transactional to run every statement on its own without a transaction (no rollback on failure)." >&2
    exit 1
  fi
fi
if [ "$MODE" = transaction ]; then
  echo "Mode: one Data API transaction (all or nothing)"
else
  echo "Mode: NO transaction — $N statement(s) run one by one; a failure stops the run but does NOT undo earlier statements"
fi

if [ "$DRY_RUN" = 1 ]; then
  echo "Dry run: no AWS call made"
  exit 0
fi

# --- guards -----------------------------------------------------------------
if [ -n "${AWS_REGION:-}" ] && [ "$AWS_REGION" != "$R" ]; then
  echo "::error::AWS_REGION=$AWS_REGION, expected $R" >&2; exit 1
fi
ACCT=$(aws sts get-caller-identity --query Account --output text)
[ "$ACCT" = "$ACCOUNT" ] || { echo "::error::credentials are for account $ACCT, expected $ACCOUNT" >&2; exit 1; }
CLUSTER_ARN=$(aws rds describe-db-clusters --region "$R" --db-cluster-identifier "$CLUSTER" \
  --query 'DBClusters[0].DBClusterArn' --output text)
case "$CLUSTER_ARN" in
  "arn:aws:rds:$R:$ACCOUNT:cluster:$CLUSTER") ;;
  *) echo "::error::unexpected cluster ARN '$CLUSTER_ARN'" >&2; exit 1 ;;
esac
SECRET_ARN=$(aws rds describe-db-clusters --region "$R" --db-cluster-identifier "$CLUSTER" \
  --query 'DBClusters[0].MasterUserSecret.SecretArn' --output text)
case "$SECRET_ARN" in
  arn:aws:secretsmanager:"$R":"$ACCOUNT":secret:*) ;;
  *) echo "::error::could not resolve the cluster's master secret ARN" >&2; exit 1 ;;
esac

# data_api <out-file> <args...>: run an rds-data call, retrying only while the
# Data API endpoint is still being enabled. stderr of the last try in $WORK/err.
data_api() {
  local out="$1"; shift
  local tries=0
  until aws rds-data "$@" --region "$R" >"$out" 2>"$WORK/err"; do
    if grep -q HttpEndpointNotEnabled "$WORK/err" && [ "$tries" -lt "$RETRY_TRIES" ]; then
      tries=$((tries+1)); echo "Data API not ready yet, retrying in ${RETRY_SLEEP}s ($tries/$RETRY_TRIES)..."
      sleep "$RETRY_SLEEP"
    else
      return 1
    fi
  done
}

# execute <sql-file> [transaction-id]: one statement, passed via --cli-input-json
# so no SQL text is ever re-parsed by the shell or the CLI.
execute() {
  local sqlfile="$1" tx="${2:-}"
  jq -n --rawfile sql "$sqlfile" --arg c "$CLUSTER_ARN" --arg s "$SECRET_ARN" --arg d "$DB" --arg t "$tx" \
    '{resourceArn: $c, secretArn: $s, database: $d, sql: $sql} + (if $t == "" then {} else {transactionId: $t} end)' \
    > "$WORK/req.json"
  data_api "$WORK/out.json" execute-statement --cli-input-json "file://$WORK/req.json"
}

fail_statement() {
  local i="$1"
  echo "::error::FAILED at statement $i of $N (line $(jq -r --argjson i "$i" '.statements[$i-1].line' "$PLAN") of $FILE):" >&2
  jq -r --argjson i "$i" '.statements[$i-1].sql | .[0:300]' "$PLAN" >&2
  sed 's/^/  /' "$WORK/err" >&2
}

if [ "$MODE" = transaction ]; then
  data_api "$WORK/begin.json" begin-transaction --resource-arn "$CLUSTER_ARN" \
    --secret-arn "$SECRET_ARN" --database "$DB" \
    || { echo "::error::begin-transaction failed" >&2; cat "$WORK/err" >&2; exit 1; }
  TX_ID=$(jq -r '.transactionId // empty' "$WORK/begin.json")
  [ -n "$TX_ID" ] || { echo "::error::begin-transaction returned no transactionId" >&2; exit 1; }
  for i in $(seq 1 "$N"); do
    jq -j --argjson i "$i" '.statements[$i-1].sql' "$PLAN" > "$WORK/stmt.sql"
    if ! execute "$WORK/stmt.sql" "$TX_ID"; then
      fail_statement "$i"
      echo "Rolling back: nothing from $FILE was applied" >&2
      exit 1   # trap rolls back
    fi
  done
  if ! data_api "$WORK/commit.json" commit-transaction --resource-arn "$CLUSTER_ARN" \
        --secret-arn "$SECRET_ARN" --transaction-id "$TX_ID"; then
    TX_ID=""
    echo "::error::commit-transaction failed — the migration was NOT applied" >&2; cat "$WORK/err" >&2; exit 1
  fi
  TX_ID=""
  echo "Committed: $N statement(s) from $FILE"
else
  for i in $(seq 1 "$N"); do
    jq -j --argjson i "$i" '.statements[$i-1].sql' "$PLAN" > "$WORK/stmt.sql"
    if ! execute "$WORK/stmt.sql"; then
      fail_statement "$i"
      echo "Stopped: statements 1..$((i-1)) of $FILE were applied and are NOT rolled back" >&2
      exit 1
    fi
  done
  echo "Applied without a transaction: $N statement(s) from $FILE"
fi

printf '%s' "NOTIFY pgrst, 'reload schema'" > "$WORK/notify.sql"
if ! execute "$WORK/notify.sql"; then
  echo "::error::the migration is applied, but NOTIFY pgrst, 'reload schema' failed:" >&2; cat "$WORK/err" >&2
  exit 1
fi
echo "Schema cache reload signal sent"
