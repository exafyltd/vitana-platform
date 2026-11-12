#!/usr/bin/env bash
# VTID-05023 rehearsal parity: row count and checksum per table, Supabase vs the
# Aurora rehearsal clone. Read-only.
#
#   SUPABASE_RO_URL=<read-only postgres URL> \
#     rehearsal-parity-counts.sh <cluster-identifier> <tables-file>
#
# cluster-identifier  must be exactly vitana-aurora-rehearsal. Any other value is
#                     refused before any connection is made.
# tables-file         one table per line, optionally schema-qualified
#                     (public.users). Blank lines and lines starting with # are skipped.
#
# Each side reads every table inside ONE transaction at REPEATABLE READ, READ ONLY,
# so the counts and checksums of all tables come from one fixed snapshot per side.
# A table's checksum is md5 over its rows, each row rendered as text and sorted.
#
# Supabase side: psql (required) with SUPABASE_RO_URL.
# Aurora side:   aws rds-data execute-statement against the cluster identifier
#                (database vitana, region eu-central-1, master secret of the clone).
#
# Exit codes: 0 every table matches; 1 at least one table mismatches;
#             2 refused, bad input or a query failed.
# Secret values (the URL, the secret ARN) are never printed.
# Usage: SUPABASE_RO_URL=... bash scripts/aws/rehearsal-parity-counts.sh vitana-aurora-rehearsal tables.txt
set -euo pipefail

REQUIRED_CLUSTER=vitana-aurora-rehearsal
REGION=eu-central-1
DATA_API_DB=vitana

CLUSTER="${1:-}"
TABLES_FILE="${2:-}"

die() { echo "ERROR: $*" >&2; exit 2; }

[ "$CLUSTER" = "$REQUIRED_CLUSTER" ] \
  || die "refusing cluster '$CLUSTER': the only allowed cluster is $REQUIRED_CLUSTER"
[ -n "${SUPABASE_RO_URL:-}" ] || die "SUPABASE_RO_URL is not set"
[ -f "$TABLES_FILE" ] || die "tables file not found: $TABLES_FILE"
command -v psql >/dev/null 2>&1 || die "psql is required for the Supabase side and was not found on PATH"

TABLES=()
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  [[ -z "$line" || "$line" == \#* ]] && continue
  [[ "$line" =~ ^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$ ]] \
    || die "invalid table name in $TABLES_FILE: $line"
  TABLES+=("$line")
done < "$TABLES_FILE"
[ "${#TABLES[@]}" -gt 0 ] || die "no tables listed in $TABLES_FILE"

# One SELECT per table: "<row count>|<md5 of sorted rows>". No trailing semicolon,
# so the same text runs through psql and through the Data API.
count_sql() {
  echo "SELECT count(*)::text || '|' || coalesce(md5(string_agg(r::text, E'\\n' ORDER BY r::text)), '') FROM $1 r"
}

# Supabase side. The whole run is one psql session, so one snapshot.
run_supabase() {
  {
    echo "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;"
    for t in "${TABLES[@]}"; do
      count_sql "$t"; echo ";"
    done
    echo "COMMIT;"
  } | psql "$SUPABASE_RO_URL" -X -q -A -t -v ON_ERROR_STOP=1 -f -
}

# Aurora side. One Data API transaction, read-only, REPEATABLE READ.
run_aurora() {
  local arn secret tx t
  arn=$(aws rds describe-db-clusters --region "$REGION" --db-cluster-identifier "$CLUSTER" \
    --query 'DBClusters[0].DBClusterArn' --output text)
  secret=$(aws rds describe-db-clusters --region "$REGION" --db-cluster-identifier "$CLUSTER" \
    --query 'DBClusters[0].MasterUserSecret.SecretArn' --output text)
  tx=$(aws rds-data begin-transaction --region "$REGION" --resource-arn "$arn" \
    --secret-arn "$secret" --database "$DATA_API_DB" --query transactionId --output text)
  aws rds-data execute-statement --region "$REGION" --resource-arn "$arn" \
    --secret-arn "$secret" --database "$DATA_API_DB" --transaction-id "$tx" \
    --sql "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY" >/dev/null
  for t in "${TABLES[@]}"; do
    aws rds-data execute-statement --region "$REGION" --resource-arn "$arn" \
      --secret-arn "$secret" --database "$DATA_API_DB" --transaction-id "$tx" \
      --sql "$(count_sql "$t")" --query 'records[0][0].stringValue' --output text
  done
  aws rds-data commit-transaction --region "$REGION" --resource-arn "$arn" \
    --transaction-id "$tx" >/dev/null
}

SUP_OUT=$(run_supabase) || die "query failed on the Supabase side"
AUR_OUT=$(run_aurora) || die "query failed on the Aurora rehearsal side"

SUP_LINES=(); while IFS= read -r l; do SUP_LINES+=("$l"); done <<< "$SUP_OUT"
AUR_LINES=(); while IFS= read -r l; do AUR_LINES+=("$l"); done <<< "$AUR_OUT"
[ "${#SUP_LINES[@]}" -eq "${#TABLES[@]}" ] || die "Supabase side returned ${#SUP_LINES[@]} results for ${#TABLES[@]} tables"
[ "${#AUR_LINES[@]}" -eq "${#TABLES[@]}" ] || die "Aurora side returned ${#AUR_LINES[@]} results for ${#TABLES[@]} tables"

echo "Rehearsal parity: cluster=$CLUSTER, ${#TABLES[@]} tables, one REPEATABLE READ read-only snapshot per side"
printf "%-32s %-10s %-34s %-10s %-34s %s\n" TABLE SUP_ROWS SUP_MD5 AUR_ROWS AUR_MD5 RESULT
mismatches=0
for i in "${!TABLES[@]}"; do
  IFS='|' read -r s_rows s_sum <<< "${SUP_LINES[$i]}"
  IFS='|' read -r a_rows a_sum <<< "${AUR_LINES[$i]}"
  if [ "$s_rows" = "$a_rows" ] && [ "$s_sum" = "$a_sum" ]; then
    result=MATCH
  else
    result=MISMATCH; mismatches=$((mismatches+1))
  fi
  printf "%-32s %-10s %-34s %-10s %-34s %s\n" "${TABLES[$i]}" "$s_rows" "$s_sum" "$a_rows" "$a_sum" "$result"
done

if [ "$mismatches" -gt 0 ]; then
  echo "RESULT: $mismatches of ${#TABLES[@]} tables mismatched"
  exit 1
fi
echo "RESULT: all ${#TABLES[@]} tables match"
