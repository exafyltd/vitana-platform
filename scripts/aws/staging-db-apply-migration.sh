#!/usr/bin/env bash
# VTID-05784 (plan autonomous-to-staging-r2 §3.5, lane staging-migrations-auto; r1 plan §3.4): apply migration files to
# the ISOLATED staging database over the RDS Data API. The staging twin of aurora-apply-migration.sh, which stays as it
# is (production, dispatch-only after PUBLISH). This script can only reach a staging cluster:
#   - --cluster is required and has no default; staging-db-common.sh sdb_check_cluster refuses any name that contains
#     "prod" and any name other than vitana-aurora-staging[-<suffix>], before any AWS call. There is no override.
#   - the credentials must be the staging database role vitana-gha-staging-db (design.md §4) in 472838866351;
#   - the cluster must resolve to its own ARN in 472838866351 / eu-central-1, be tagged vitana-env=staging and use an
#     RDS-managed master secret.
#
# Usage:
#   staging-db-apply-migration.sh --cluster vitana-aurora-staging --file <f> [--file <f> ...] [--dry-run]
#                                 [--allow-non-transactional] [--read-only]
#
#   Several --file: every statement of every file runs in ONE Data API transaction, in the order given (the caller
#   passes timestamp order). Any failure rolls the whole batch back and exits 1 naming the file and statement: either
#   all files are applied or none is (the rollback of a failed migration, VTID-03174 guarantee).
#   A statement Postgres refuses inside a transaction (CREATE INDEX CONCURRENTLY, ...) is refused, unless exactly one
#   --file is given together with --allow-non-transactional: then its statements run one by one without a transaction
#   and the first failure stops the run (earlier statements stay applied; said so in the output).
#   --dry-run splits and prints the plan; NO AWS call.
#   --read-only runs the batch in one transaction and always ROLLS IT BACK (no NOTIFY): the compatibility probe of
#   staging-db-migrate.sh (a statement that fails there fails the probe; nothing is ever kept).
# Env: MIGRATION_FREEZE=true refuses. STAGING_DB_DATAAPI_RETRY_SLEEP (default 15) / _TRIES (default 40): wait while the
#      Data API endpoint is being enabled or the auto-paused cluster resumes (design.md §2 option A).
# Exit: 0 applied (or planned); 1 refused or failed (rolled back); 2 usage.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
# shellcheck source=staging-db-common.sh
. "$HERE/staging-db-common.sh"
DB=vitana
STAGING_ROLE_NAME=vitana-gha-staging-db
MAX_SQL_BYTES=65536
RETRY_SLEEP="${STAGING_DB_DATAAPI_RETRY_SLEEP:-15}"
RETRY_TRIES="${STAGING_DB_DATAAPI_RETRY_TRIES:-40}"

CLUSTER=""; FILES=(); DRY_RUN=0; ALLOW_NONTX=0; READ_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --cluster) CLUSTER="${2:-}"; shift 2 ;;
    --file) FILES+=("${2:-}"); shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --allow-non-transactional) ALLOW_NONTX=1; shift ;;
    --read-only) READ_ONLY=1; shift ;;
    *) sdb_usage "unknown argument: $1" ;;
  esac
done
sdb_check_cluster "$CLUSTER"
[ "${#FILES[@]}" -gt 0 ] || sdb_usage "usage: $0 --cluster vitana-aurora-staging --file <f> [--file <f> ...] [--dry-run] [--allow-non-transactional]"
for f in "${FILES[@]}"; do [ -n "$f" ] && [ -f "$f" ] || sdb_die "SQL file not found: '$f'"; done
[ "${MIGRATION_FREEZE:-}" != "true" ] || sdb_die "MIGRATION_FREEZE=true: schema freeze, no migration is applied"
if [ "$ALLOW_NONTX" = 1 ] && [ "${#FILES[@]}" -ne 1 ]; then
  sdb_die "--allow-non-transactional takes exactly one --file (a batch is all or nothing)"
fi
[ "$READ_ONLY" = 0 ] || [ "$ALLOW_NONTX" = 0 ] || sdb_die "--read-only and --allow-non-transactional exclude each other"

node "$REPO/scripts/ci/staging-prod-ref-guard.mjs" --enforce --files "$HERE/staging-db-apply-migration.sh" "$HERE/staging-db-common.sh" > /dev/null \
  || sdb_die "this script names production (staging-prod-ref-guard --enforce)"

WORK="$(mktemp -d)"
TX_ID=""; CLUSTER_ARN=""; SECRET_ARN=""
cleanup() {
  if [ -n "$TX_ID" ]; then
    echo "Rolling back the open transaction" >&2
    aws rds-data rollback-transaction --region "$SDB_REGION" --resource-arn "$CLUSTER_ARN" --secret-arn "$SECRET_ARN" \
      --transaction-id "$TX_ID" > /dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# ---- plan (no AWS call) ---------------------------------------------------------------------------------------------
TOTAL=0; NONTX_TOTAL=0
: > "$WORK/index.tsv"   # <file no> <statement no> <file>
i=0
for f in "${FILES[@]}"; do
  i=$((i+1))
  python3 "$HERE/aurora_sql_split.py" "$f" --out "$WORK/plan-$i.json" > /dev/null || sdb_die "cannot split $f"
  n=$(jq '.counts.statements' "$WORK/plan-$i.json")
  nontx=$(jq '.counts.non_transactional' "$WORK/plan-$i.json")
  [ "$n" -gt 0 ] || sdb_die "$f contains no SQL statement"
  big=$(jq -r --argjson max "$MAX_SQL_BYTES" '[.statements[] | select((.sql | utf8bytelength) > $max) | .n] | join(",")' "$WORK/plan-$i.json")
  [ -z "$big" ] || sdb_die "$f: statement(s) $big exceed the Data API ${MAX_SQL_BYTES}-byte limit"
  echo "Plan $i/${#FILES[@]} $f: $n statement(s), $nontx non-transactional"
  jq -r '.statements[] | "  \(.n). line \(.line)\(if .transactional then "" else " [NON-TRANSACTIONAL]" end): \(.sql | gsub("\\s+"; " ") | .[0:100])"' "$WORK/plan-$i.json"
  for k in $(seq 1 "$n"); do printf '%s\t%s\t%s\n' "$i" "$k" "$f" >> "$WORK/index.tsv"; done
  TOTAL=$((TOTAL+n)); NONTX_TOTAL=$((NONTX_TOTAL+nontx))
done

MODE=transaction
if [ "$NONTX_TOTAL" -gt 0 ]; then
  if [ "$ALLOW_NONTX" = 1 ]; then
    MODE=autocommit
  else
    sdb_die "$NONTX_TOTAL statement(s) cannot run inside a transaction (e.g. CREATE INDEX CONCURRENTLY); a batch is all or nothing. Apply that one file alone with --allow-non-transactional (RUN-MIGRATION target staging)."
  fi
fi
if [ "$MODE" = transaction ]; then
  echo "Mode: one Data API transaction for $TOTAL statement(s) of ${#FILES[@]} file(s) (all or nothing)"
else
  echo "Mode: NO transaction; $TOTAL statement(s) run one by one; a failure stops the run but does NOT undo earlier statements"
fi
echo "Target: cluster $CLUSTER, database $DB"
if [ "$DRY_RUN" = 1 ]; then
  echo "Dry run: no AWS call made"
  exit 0
fi

# ---- guards (AWS, read-only) ----------------------------------------------------------------------------------------
if [ -n "${AWS_REGION:-}" ] && [ "$AWS_REGION" != "$SDB_REGION" ]; then sdb_die "AWS_REGION=$AWS_REGION, expected $SDB_REGION"; fi
aws sts get-caller-identity --output json > "$WORK/id.json" || sdb_die "aws sts get-caller-identity failed"
[ "$(jq -r .Account "$WORK/id.json")" = "$SDB_ACCOUNT" ] || sdb_die "credentials are for account $(jq -r .Account "$WORK/id.json"), expected $SDB_ACCOUNT"
CALLER=$(jq -r .Arn "$WORK/id.json")
case "$CALLER" in
  "arn:aws:sts::$SDB_ACCOUNT:assumed-role/$STAGING_ROLE_NAME/"*) ;;
  *) sdb_die "refused: credentials are '$CALLER', not the staging database role $STAGING_ROLE_NAME (vars.AWS_STAGING_DB_ROLE_ARN)" ;;
esac
aws rds describe-db-clusters --region "$SDB_REGION" --db-cluster-identifier "$CLUSTER" --output json > "$WORK/cluster.json" \
  || sdb_die "cluster $CLUSTER not found"
CLUSTER_ARN=$(jq -r '.DBClusters[0].DBClusterArn // ""' "$WORK/cluster.json")
[ "$CLUSTER_ARN" = "$(sdb_cluster_arn "$CLUSTER")" ] || sdb_die "unexpected cluster ARN '$CLUSTER_ARN'"
[ "$(jq -r '[.DBClusters[0].TagList[]? | select(.Key == "vitana-env") | .Value][0] // ""' "$WORK/cluster.json")" = "staging" ] \
  || sdb_die "cluster $CLUSTER is not tagged vitana-env=staging"
SECRET_ARN=$(jq -r '.DBClusters[0].MasterUserSecret.SecretArn // ""' "$WORK/cluster.json")
case "$SECRET_ARN" in "arn:aws:secretsmanager:$SDB_REGION:$SDB_ACCOUNT:secret:"*) ;; *) sdb_die "cluster $CLUSTER has no RDS-managed master secret" ;; esac

# data_api <out> <args...>: one rds-data call; retried only while the Data API is being enabled or the cluster resumes.
data_api() {
  local out="$1"; shift
  local tries=0
  until aws rds-data "$@" --region "$SDB_REGION" > "$out" 2> "$WORK/err"; do
    if grep -Eq 'HttpEndpointNotEnabled|DatabaseResumingException' "$WORK/err" && [ "$tries" -lt "$RETRY_TRIES" ]; then
      tries=$((tries+1)); echo "Data API not ready (endpoint or resume), retrying in ${RETRY_SLEEP}s ($tries/$RETRY_TRIES)..."
      sleep "$RETRY_SLEEP"
    else
      return 1
    fi
  done
}
# execute <sql-file> [transaction-id]: the SQL goes through --cli-input-json, never re-parsed by the shell.
execute() {
  jq -n --rawfile sql "$1" --arg c "$CLUSTER_ARN" --arg s "$SECRET_ARN" --arg d "$DB" --arg t "${2:-}" \
    '{resourceArn: $c, secretArn: $s, database: $d, sql: $sql} + (if $t == "" then {} else {transactionId: $t} end)' > "$WORK/req.json"
  data_api "$WORK/out.json" execute-statement --cli-input-json "file://$WORK/req.json"
}
fail_at() { # <file no> <statement no>
  local plan="$WORK/plan-$1.json"
  echo "::error::FAILED at statement $2 of ${FILES[$(( $1 - 1 ))]} (line $(jq -r --argjson k "$2" '.statements[$k-1].line' "$plan")):" >&2
  jq -r --argjson k "$2" '.statements[$k-1].sql | .[0:300]' "$plan" >&2
  sed 's/^/  /' "$WORK/err" >&2
}

# ---- apply ----------------------------------------------------------------------------------------------------------
if [ "$MODE" = transaction ]; then
  data_api "$WORK/begin.json" begin-transaction --resource-arn "$CLUSTER_ARN" --secret-arn "$SECRET_ARN" --database "$DB" \
    || { cat "$WORK/err" >&2; sdb_die "begin-transaction failed"; }
  TX_ID=$(jq -r '.transactionId // empty' "$WORK/begin.json")
  [ -n "$TX_ID" ] || sdb_die "begin-transaction returned no transactionId"
  while IFS=$'\t' read -r fi_ k _f; do
    jq -j --argjson k "$k" '.statements[$k-1].sql' "$WORK/plan-$fi_.json" > "$WORK/stmt.sql"
    if ! execute "$WORK/stmt.sql" "$TX_ID"; then
      fail_at "$fi_" "$k"
      echo "Rolling back: nothing of the ${#FILES[@]} file(s) was applied" >&2
      exit 1   # the trap rolls back
    fi
  done < "$WORK/index.tsv"
  if [ "$READ_ONLY" = 1 ]; then
    data_api "$WORK/rollback.json" rollback-transaction --resource-arn "$CLUSTER_ARN" --secret-arn "$SECRET_ARN" --transaction-id "$TX_ID" \
      || { cat "$WORK/err" >&2; TX_ID=""; sdb_die "rollback-transaction of the read-only probe failed"; }
    TX_ID=""
    echo "Read-only: $TOTAL statement(s) of ${#FILES[@]} file(s) ran on $CLUSTER and were rolled back"
    exit 0
  fi
  if ! data_api "$WORK/commit.json" commit-transaction --resource-arn "$CLUSTER_ARN" --secret-arn "$SECRET_ARN" --transaction-id "$TX_ID"; then
    TX_ID=""
    cat "$WORK/err" >&2
    sdb_die "commit-transaction failed: nothing was applied"
  fi
  TX_ID=""
  echo "Committed: $TOTAL statement(s) of ${#FILES[@]} file(s) to $CLUSTER"
else
  while IFS=$'\t' read -r fi_ k _f; do
    jq -j --argjson k "$k" '.statements[$k-1].sql' "$WORK/plan-$fi_.json" > "$WORK/stmt.sql"
    if ! execute "$WORK/stmt.sql"; then
      fail_at "$fi_" "$k"
      echo "Stopped: statements 1..$((k-1)) were applied and are NOT rolled back" >&2
      exit 1
    fi
  done < "$WORK/index.tsv"
  echo "Applied without a transaction: $TOTAL statement(s) to $CLUSTER"
fi

printf '%s' "NOTIFY pgrst, 'reload schema'" > "$WORK/notify.sql"
execute "$WORK/notify.sql" || { cat "$WORK/err" >&2; sdb_die "applied, but NOTIFY pgrst, 'reload schema' failed"; }
echo "Schema cache reload signal sent"
