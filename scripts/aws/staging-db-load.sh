#!/usr/bin/env bash
# VTID-05782 (plan autonomous-to-staging-r2 §3.3, lane staging-db-provision; design.md §5.3): load the STAGING-DB-SCHEMA
# bundle into the isolated staging cluster through the RDS Data API, then compare the cluster's schema hash with the
# bundle's. Synthetic data only; never a copy of production.
#
# Usage:
#   staging-db-load.sh --cluster vitana-aurora-staging --bundle <dir> [--dry-run | --verify-only]
#
#   <dir> holds bundle.sql and manifest.json from scripts/ci/staging-db/build-schema.mjs.
#   --dry-run      checks the bundle and prints the plan; NO AWS call.
#   --verify-only  makes no change: compares the cluster's schema hash with manifest.schema_hash.
#   (default)      needs STAGING_DB_COST_APPROVED=yes and an EMPTY public schema (a bundle is loaded once); applies every
#                  bundle part in order — one Data API transaction per part, rolled back whole on failure (a part with
#                  statements Postgres refuses in a transaction runs statement by statement) — then checks the hash.
# Before any AWS call: the cluster name (staging only), the bundle sha256s and its production references against
# infra/staging-db/bundle-prod-ref-allow.json (build-schema.mjs --verify), and the production-reference guard in
# --enforce mode over this script and its helpers.
# Exit: 0 ok; 1 refused, failed or hash mismatch; 2 usage.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
# shellcheck source=staging-db-common.sh
. "$HERE/staging-db-common.sh"
HASH_SQL="$REPO/infra/staging-db/schema-hash.sql"
DB=vitana
MAX_SQL_BYTES=65536

CLUSTER=""; BUNDLE=""; MODE=load
while [ $# -gt 0 ]; do
  case "$1" in
    --cluster) CLUSTER="${2:-}"; shift 2 ;;
    --bundle) BUNDLE="${2:-}"; shift 2 ;;
    --dry-run) MODE=dry-run; shift ;;
    --verify-only) MODE=verify-only; shift ;;
    *) sdb_usage "unknown argument: $1" ;;
  esac
done
sdb_check_cluster "$CLUSTER"
[ -n "$BUNDLE" ] || sdb_usage "usage: $0 --cluster vitana-aurora-staging --bundle <dir> [--dry-run|--verify-only]"
[ -f "$BUNDLE/bundle.sql" ] && [ -f "$BUNDLE/manifest.json" ] || sdb_die "bundle dir $BUNDLE needs bundle.sql and manifest.json"

node "$REPO/scripts/ci/staging-db/build-schema.mjs" --verify "$BUNDLE" || sdb_die "bundle check failed (build-schema.mjs --verify)"
node "$REPO/scripts/ci/staging-prod-ref-guard.mjs" --enforce --files "$HERE/staging-db-load.sh" "$HERE/staging-db-common.sh" "$HASH_SQL" \
  || sdb_die "the load script names production (staging-prod-ref-guard --enforce)"
WANT=$(jq -r .schema_hash "$BUNDLE/manifest.json")

WORK="$(mktemp -d)"
TX_ID=""; CLUSTER_ARN=""; SECRET_ARN=""
cleanup() {
  if [ -n "$TX_ID" ]; then
    aws rds-data rollback-transaction --region "$SDB_REGION" --resource-arn "$CLUSTER_ARN" --secret-arn "$SECRET_ARN" --transaction-id "$TX_ID" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# Split bundle.sql at its `-- @@file NNNN <name> sha256=<hex>` markers into $WORK/parts/NNNN.sql (+ .name).
mkdir -p "$WORK/parts"
awk -v d="$WORK/parts" '
  /^-- @@file [0-9]{4} [^ ]+ sha256=[0-9a-f]{64}$/ { if (out) close(out); out = d "/" $3 ".sql"; print $4 > (d "/" $3 ".name"); next }
  out { print > out }
' "$BUNDLE/bundle.sql"
N_PARTS=$(find "$WORK/parts" -name '*.sql' | wc -l | tr -d ' ')
[ "$N_PARTS" = "$(jq '.files | length' "$BUNDLE/manifest.json")" ] || sdb_die "bundle split into $N_PARTS part(s), manifest lists $(jq '.files | length' "$BUNDLE/manifest.json")"
echo "Bundle $BUNDLE: $N_PARTS part(s), expected schema hash $WANT"

if [ "$MODE" = "dry-run" ]; then
  for f in "$WORK"/parts/*.sql; do python3 "$HERE/aurora_sql_split.py" "$f" --out "$f.plan.json" > /dev/null; done
  echo "Dry run: $N_PARTS part(s) split into $(cat "$WORK"/parts/*.plan.json | jq -s 'map(.counts.statements) | add') statement(s); no AWS call made"
  exit 0
fi

[ "$MODE" = "verify-only" ] || [ "${STAGING_DB_COST_APPROVED:-}" = "yes" ] || sdb_die "refused: STAGING_DB_COST_APPROVED is not 'yes' (owner cost approval, design.md §6.1)"
sdb_check_account
aws rds describe-db-clusters --region "$SDB_REGION" --db-cluster-identifier "$CLUSTER" --output json > "$WORK/cluster.json" \
  || sdb_die "cluster $CLUSTER not found (run AWS-STAGE-PROVISION-DB.yml mode=apply first)"
CLUSTER_ARN=$(jq -r '.DBClusters[0].DBClusterArn' "$WORK/cluster.json")
[ "$CLUSTER_ARN" = "$(sdb_cluster_arn "$CLUSTER")" ] || sdb_die "unexpected cluster ARN '$CLUSTER_ARN'"
[ "$(jq -r '[.DBClusters[0].TagList[]? | select(.Key == "vitana-env") | .Value][0] // ""' "$WORK/cluster.json")" = "staging" ] \
  || sdb_die "cluster $CLUSTER is not tagged vitana-env=staging"
SECRET_ARN=$(jq -r '.DBClusters[0].MasterUserSecret.SecretArn // ""' "$WORK/cluster.json")
case "$SECRET_ARN" in "arn:aws:secretsmanager:$SDB_REGION:$SDB_ACCOUNT:secret:"*) ;; *) sdb_die "cluster $CLUSTER has no RDS-managed master secret" ;; esac

# execute <sql-file> [transaction-id] -> $WORK/out.json
execute() {
  jq -n --rawfile sql "$1" --arg c "$CLUSTER_ARN" --arg s "$SECRET_ARN" --arg d "$DB" --arg t "${2:-}" \
    '{resourceArn: $c, secretArn: $s, database: $d, sql: $sql} + (if $t == "" then {} else {transactionId: $t} end)' > "$WORK/req.json"
  aws rds-data execute-statement --region "$SDB_REGION" --cli-input-json "file://$WORK/req.json" > "$WORK/out.json"
}
cluster_hash() {
  execute "$HASH_SQL"
  jq -r '.records[0][0].stringValue // ""' "$WORK/out.json"
}

if [ "$MODE" = "load" ]; then
  printf '%s' "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'" > "$WORK/empty.sql"
  execute "$WORK/empty.sql"
  EXISTING=$(jq -r '.records[0][0].longValue // 0' "$WORK/out.json")
  [ "$EXISTING" = "0" ] || sdb_die "refused: public schema of $CLUSTER is not empty ($EXISTING relation(s)); a bundle is loaded once (use --verify-only)"
  i=0
  for f in "$WORK"/parts/*.sql; do
    i=$((i+1)); name=$(cat "${f%.sql}.name")
    python3 "$HERE/aurora_sql_split.py" "$f" --out "$WORK/plan.json" > /dev/null || sdb_die "cannot split part $i ($name)"
    n=$(jq '.counts.statements' "$WORK/plan.json")
    [ "$n" -gt 0 ] || { echo "  $i/$N_PARTS $name: no statement"; continue; }
    big=$(jq -r --argjson max "$MAX_SQL_BYTES" '[.statements[] | select((.sql | utf8bytelength) > $max) | .n] | join(",")' "$WORK/plan.json")
    [ -z "$big" ] || sdb_die "part $i ($name): statement(s) $big exceed the Data API ${MAX_SQL_BYTES}-byte limit"
    nontx=$(jq '[.statements[] | select(.transactional == false)] | length' "$WORK/plan.json")
    if [ "$nontx" = "0" ]; then
      aws rds-data begin-transaction --region "$SDB_REGION" --resource-arn "$CLUSTER_ARN" --secret-arn "$SECRET_ARN" --database "$DB" > "$WORK/tx.json"
      TX_ID=$(jq -r .transactionId "$WORK/tx.json")
      for k in $(seq 1 "$n"); do
        jq -j --argjson k "$k" '.statements[$k-1].sql' "$WORK/plan.json" > "$WORK/stmt.sql"
        execute "$WORK/stmt.sql" "$TX_ID" || sdb_die "part $i ($name), statement $k of $n failed; the part was rolled back"
      done
      aws rds-data commit-transaction --region "$SDB_REGION" --resource-arn "$CLUSTER_ARN" --secret-arn "$SECRET_ARN" --transaction-id "$TX_ID" > /dev/null
      TX_ID=""
    else
      for k in $(seq 1 "$n"); do
        jq -j --argjson k "$k" '.statements[$k-1].sql' "$WORK/plan.json" > "$WORK/stmt.sql"
        execute "$WORK/stmt.sql" || sdb_die "part $i ($name), statement $k of $n failed (no transaction: statements 1..$((k-1)) stay applied)"
      done
    fi
    echo "  $i/$N_PARTS $name: $n statement(s)"
  done
fi

GOT=$(cluster_hash)
if [ "$GOT" != "$WANT" ]; then
  echo "::error::schema hash mismatch on $CLUSTER: cluster $GOT, bundle $WANT" >&2
  exit 1
fi
echo "Schema hash matches the bundle: $GOT"
