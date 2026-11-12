#!/usr/bin/env bash
# VTID-05023 rehearsal parity: per-table row counts of `public` on the rehearsal clone
# (Aurora, via the Data API) and on the source (Supabase, via PostgREST counts).
#
# Read-only on both sides. Never writes. Refuses any cluster other than vitana-aurora-rehearsal.
#
#   rehearsal-parity-counts.sh tables            # list public base tables on the clone
#   rehearsal-parity-counts.sh counts FILE       # write "table<TAB>count" for the clone to FILE
#
# Compare two count files with:  diff <(sort clone.tsv) <(sort source.tsv)
set -euo pipefail
export AWS_PAGER=""
REGION=eu-central-1
CLUSTER_ARN="arn:aws:rds:eu-central-1:472838866351:cluster:vitana-aurora-rehearsal"
SECRET_ARN_QUERY='DBClusters[0].MasterUserSecret.SecretArn'

[ "$(aws sts get-caller-identity --query Account --output text)" = "472838866351" ] || { echo "refusing: wrong account" >&2; exit 1; }

sql_tables="select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1"

run_sql() { # one statement, read-only, through the clone's Data API
  aws rds-data execute-statement --region "$REGION" \
    --resource-arn "$CLUSTER_ARN" \
    --secret-arn "$(aws rds describe-db-clusters --region "$REGION" --db-cluster-identifier vitana-aurora-rehearsal --query "$SECRET_ARN_QUERY" --output text)" \
    --database vitana --sql "$1" --format-records-as JSON --query 'formattedRecords' --output text
}

case "${1:-}" in
  tables)
    run_sql "$sql_tables" ;;
  counts)
    out="${2:?usage: counts FILE}"
    : > "$out"
    for t in $(run_sql "$sql_tables" | python3 -c 'import json,sys; [print(r["table_name"]) for r in json.load(sys.stdin)]'); do
      n=$(run_sql "select count(*) as n from public.\"$t\"" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["n"])')
      printf '%s\t%s\n' "$t" "$n" >> "$out"
    done
    echo "wrote $(wc -l < "$out") tables to $out" ;;
  *)
    echo "usage: $0 tables | counts FILE" >&2; exit 2 ;;
esac
