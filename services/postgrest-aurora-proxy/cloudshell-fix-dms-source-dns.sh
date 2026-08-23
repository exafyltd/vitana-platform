#!/usr/bin/env bash
# Run this in AWS CloudShell (your own console session -- never Claude's).
#
# ROOT CAUSE (found 2026-08-23, VTID-03702): DMS replication task v3 has been
# FATAL_ERROR since 2026-08-20 not because of a data or allow-list problem --
# db.inmkhvwdcuyhnxkgfvsb.supabase.co resolves to an IPv6-ONLY address
# (2a05:d016:...), no IPv4 A record at all. The DMS instance's VPC can't
# reach it: "could not translate host name ... to address: Name or service
# not known" (confirmed via CloudWatch log dms-tasks-vitana-dms-prod /
# dms-task-6HXJWOLRF5FA3DND3TLMGXHY4I). This is a well-known Supabase
# behavior: direct-connection hostnames are IPv6-only unless "Dedicated
# IPv4 Address" is purchased for the project.
#
# This script repoints the FULL LOAD path at Supabase's Session Pooler
# (aws-0-eu-central-1.pooler.supabase.com), which resolves to real IPv4
# addresses -- confirmed via DNS lookup just now.
#
# IMPORTANT CAVEAT, read before running: the Supabase pooler does NOT proxy
# the logical-replication protocol, so this fixes FULL LOAD reloads but will
# very likely NOT fix ongoing CDC (the task will complete its full load and
# then fail again trying to start replication). Two real ways to get CDC
# back:
#   (a) Enable "Dedicated IPv4 Address" for project inmkhvwdcuyhnxkgfvsb in
#       Supabase project settings -> Add-ons (this is the one action that
#       needs your account, not mine) -- then flip the endpoint back to the
#       direct hostname, which will then resolve to IPv4 too.
#   (b) Give the DMS VPC (vpc-05958f035e596fe64) real IPv6 egress. More
#       AWS-side work, not recommended unless (a) isn't available.
# Until one of those happens, treat Aurora as kept-fresh via periodic full
# reloads through this script, not continuous replication.
set -uo pipefail

REGION="eu-central-1"
SRC_ENDPOINT_ARN="arn:aws:dms:eu-central-1:472838866351:endpoint:M5KXPHGSEZHMDBXFLV5WVH3MAU"
TASK_ARN="arn:aws:dms:eu-central-1:472838866351:task:6HXJWOLRF5FA3DND3TLMGXHY4I"
POOLER_HOST="aws-0-eu-central-1.pooler.supabase.com"
POOLER_USER="migrate.inmkhvwdcuyhnxkgfvsb"

echo "=== Repointing vitana-src-supabase-v3 at the IPv4 pooler ==="
aws dms modify-endpoint --region "$REGION" \
  --endpoint-arn "$SRC_ENDPOINT_ARN" \
  --server-name "$POOLER_HOST" \
  --port 5432 \
  --username "$POOLER_USER"

echo ""
echo "=== Testing the new connection (this can take ~30s) ==="
REPL_INSTANCE_ARN=$(aws dms describe-replication-instances --region "$REGION" \
  --query 'ReplicationInstances[0].ReplicationInstanceArn' --output text)
aws dms test-connection --region "$REGION" \
  --replication-instance-arn "$REPL_INSTANCE_ARN" \
  --endpoint-arn "$SRC_ENDPOINT_ARN"

echo "Waiting 30s for the test to finish, then checking its result..."
sleep 30
aws dms describe-connections --region "$REGION" \
  --filter "Name=endpoint-arn,Values=$SRC_ENDPOINT_ARN" \
  --query 'Connections[0].{Status:Status,Error:LastFailureMessage}' --output json

echo ""
echo "=== If the connection test above shows Status=successful, resuming the task ==="
read -p "Resume task v3 now with resume-processing? [y/N] " CONFIRM
if [ "$CONFIRM" = "y" ] || [ "$CONFIRM" = "Y" ]; then
  aws dms start-replication-task --region "$REGION" \
    --replication-task-arn "$TASK_ARN" \
    --start-replication-task-type resume-processing
  echo "Started. Check status with:"
  echo "  aws dms describe-replication-tasks --region $REGION --filter Name=replication-task-arn,Values=$TASK_ARN"
else
  echo "Skipped -- run the start-replication-task command above manually when ready."
fi

echo ""
echo "=== Optional follow-up: repoint Aurora's 116 auth.users FKs at app_users ==="
echo "Once a fresh full reload has run (so app_users/other tables aren't stale),"
echo "you can also run:"
echo "  bash services/postgrest-aurora-proxy/cloudshell-apply-fk-repoint.sh"
echo "This is the identity-anchor step from docs/AURORA-EXCEPT-AUTH-ASSESSMENT.md --"
echo "safe to run any time (idempotent, skips FK violations with a NOTICE instead"
echo "of aborting), but most effective after Aurora's data is current."

echo ""
echo "=== Done. Paste the connection-test result and task status back to Claude. ==="
