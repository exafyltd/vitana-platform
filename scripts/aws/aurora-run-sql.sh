#!/usr/bin/env bash
# Run a one-statement-per-line SQL file against Aurora via the RDS Data API,
# stopping at the first failure (VTID-04755). Comment lines are skipped.
# Usage: scripts/aws/aurora-run-sql.sh <file.sql>
set -euo pipefail
R=eu-central-1
CLUSTER_ARN=arn:aws:rds:eu-central-1:472838866351:cluster:vitana-aurora-prod
SECRET_ARN=$(aws rds describe-db-clusters --region $R --db-cluster-identifier vitana-aurora-prod \
  --query 'DBClusters[0].MasterUserSecret.SecretArn' --output text)
n=0
while IFS= read -r sql; do
  [[ -z "$sql" || "$sql" == --* ]] && continue
  n=$((n+1))
  if ! aws rds-data execute-statement --region $R --resource-arn "$CLUSTER_ARN" \
       --secret-arn "$SECRET_ARN" --database vitana --sql "$sql" >/dev/null; then
    echo "FAILED at statement $n: ${sql:0:200}" >&2; exit 1
  fi
done < "$1"
echo "OK: $n statements from $1"
