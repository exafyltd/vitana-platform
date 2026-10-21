#!/usr/bin/env bash
# Run a one-statement-per-line SQL file against Aurora via the RDS Data API,
# stopping at the first real failure (VTID-04755). Comment lines are skipped.
# Retries a statement while the Data API is still being enabled.
# Usage: aurora-run-sql.sh <file.sql>
set -uo pipefail
R=eu-central-1
CLUSTER_ARN=arn:aws:rds:eu-central-1:472838866351:cluster:vitana-aurora-prod
SECRET_ARN=$(aws rds describe-db-clusters --region $R --db-cluster-identifier vitana-aurora-prod \
  --query 'DBClusters[0].MasterUserSecret.SecretArn' --output text)
n=0
while IFS= read -r sql; do
  [[ -z "$sql" || "$sql" == --* ]] && continue
  n=$((n+1)); tries=0
  until err=$(aws rds-data execute-statement --region $R --resource-arn "$CLUSTER_ARN" \
        --secret-arn "$SECRET_ARN" --database vitana --sql "$sql" 2>&1 >/dev/null); do
    if [[ "$err" == *HttpEndpointNotEnabled* && $tries -lt 40 ]]; then
      tries=$((tries+1)); echo "Data API not ready yet, retrying in 15s ($tries/40)..."; sleep 15
    else
      echo "FAILED at statement $n: ${sql:0:200}" >&2; echo "$err" >&2; exit 1
    fi
  done
done < "$1"
echo "OK: $n statements from $1"
