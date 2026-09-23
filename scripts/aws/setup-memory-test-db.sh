#!/usr/bin/env bash
#
# VTID-04323 — provision the isolated memory test database
# (docs/MEMORY-SYSTEM-PLAN.md §7 decision 4: "set up something in AWS").
#
# WHY THIS EXISTS
#
# Memory cannot be verified without writes, and every existing host
# (production, staging, PR previews) writes the ONE production Supabase
# project — see vitana-v1 CLAUDE.md "no host is exempt". The golden recall
# eval (docs/MEMORY-SYSTEM-PLAN.md §5 item 3) needs a Postgres + pgvector
# database that holds synthetic users only and is never reachable by the app.
#
# This creates a small, private RDS PostgreSQL instance for exactly that:
#   - db.t4g.micro, 20 GB gp3, Postgres 17 (pgvector is available on RDS)
#   - private (no public IP), same VPC/subnets/SG as vitana-postgres-staging,
#     so an ECS task in Vitana-ECS-Cluster can reach it and nothing outside can
#   - storage encrypted, 7-day backups, deletion protection ON
#   - master password generated and stored by RDS in Secrets Manager
#     (--manage-master-user-password) — never printed, never in this repo
#   - tagged Env=memory-test, Purpose="synthetic data only"
#
# Claude Code sessions cannot run this: claude-code-aws-agent has no
# rds:CreateDBInstance (denied 2026-09-23). Run it from an admin session.
# Approximate cost: ~15 USD/month.
#
# WHAT IT DOES NOT DO
#   - It does not create the schema. The eval harness applies the memory
#     migrations (memory_items, memory_facts, write_fact, the search RPCs)
#     itself on every run, from supabase/migrations, into a fresh database.
#   - It never touches vitana-postgres-staging, Aurora, or Supabase.
#
# USAGE
#   scripts/aws/setup-memory-test-db.sh            # dry run: print the plan
#   scripts/aws/setup-memory-test-db.sh --apply    # create it
#   scripts/aws/setup-memory-test-db.sh status     # show state + endpoint

set -euo pipefail

REGION="eu-central-1"
ACCOUNT_EXPECTED="472838866351"
DB_ID="vitana-memory-test"
DB_NAME="vitana_memory_test"
MASTER_USER="memtest_admin"
# Reuse the network placement of the existing private staging Postgres.
REFERENCE_DB="vitana-postgres-staging"

MODE="dry-run"
case "${1:-}" in
  --apply) MODE="apply" ;;
  status)  MODE="status" ;;
  ""|--dry-run) MODE="dry-run" ;;
  *) echo "usage: $0 [--apply|status]" >&2; exit 2 ;;
esac

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
if [ "$ACCOUNT" != "$ACCOUNT_EXPECTED" ]; then
  echo "Refusing: AWS account is $ACCOUNT, expected $ACCOUNT_EXPECTED (CLAUDE.md IF-THEN 11)." >&2
  exit 1
fi

if [ "$MODE" = "status" ]; then
  aws rds describe-db-instances --region "$REGION" --db-instance-identifier "$DB_ID" \
    --query 'DBInstances[0].{status:DBInstanceStatus,endpoint:Endpoint.Address,port:Endpoint.Port,public:PubliclyAccessible,secret:MasterUserSecret.SecretArn}' \
    --output table
  exit 0
fi

if aws rds describe-db-instances --region "$REGION" --db-instance-identifier "$DB_ID" >/dev/null 2>&1; then
  echo "$DB_ID already exists — nothing to do. Run '$0 status' for its endpoint."
  exit 0
fi

SUBNET_GROUP=$(aws rds describe-db-instances --region "$REGION" --db-instance-identifier "$REFERENCE_DB" \
  --query 'DBInstances[0].DBSubnetGroup.DBSubnetGroupName' --output text)
SG=$(aws rds describe-db-instances --region "$REGION" --db-instance-identifier "$REFERENCE_DB" \
  --query 'DBInstances[0].VpcSecurityGroups[0].VpcSecurityGroupId' --output text)

echo "Plan:"
echo "  create RDS instance $DB_ID (postgres 17, db.t4g.micro, 20GB gp3, private)"
echo "  subnet group: $SUBNET_GROUP   security group: $SG   (copied from $REFERENCE_DB)"
echo "  database: $DB_NAME   master user: $MASTER_USER (password managed by RDS/Secrets Manager)"

if [ "$MODE" != "apply" ]; then
  echo "Dry run only. Re-run with --apply to create it."
  exit 0
fi

aws rds create-db-instance --region "$REGION" \
  --db-instance-identifier "$DB_ID" \
  --db-instance-class db.t4g.micro \
  --engine postgres --engine-version 17.9 \
  --allocated-storage 20 --storage-type gp3 \
  --db-name "$DB_NAME" \
  --master-username "$MASTER_USER" --manage-master-user-password \
  --db-subnet-group-name "$SUBNET_GROUP" \
  --vpc-security-group-ids "$SG" \
  --no-publicly-accessible --storage-encrypted \
  --backup-retention-period 7 --no-multi-az --deletion-protection \
  --tags Key=Project,Value=vitana Key=Env,Value=memory-test \
         "Key=Purpose,Value=isolated memory eval DB - synthetic data only" \
         Key=VTID,Value=VTID-04323 \
  --query 'DBInstance.{id:DBInstanceIdentifier,status:DBInstanceStatus}' --output table

echo "Creating (takes ~5-10 min). Check with: $0 status"
