#!/usr/bin/env bash
# proxy-jwt-staging.sh — owner/admin-run. Registers the next revision of vitana-postgrest-aurora-staging
# that is byte-identical to revision 20 except ONE secret binding:
#   PGRST_JWT_SECRET  vitana/gateway/staging/supabase-jwt-secret  (documented as identical to the production
#                     Supabase JWT secret, scripts/aws/setup-postgrest-aurora-proxy-staging.sh:98)
#                 ->  vitana/gateway/staging/postgrest-jwt-secret (staging-only, VTID-05803)
# so the proxy stops accepting production-signed tokens and accepts the staging-only service-role key.
#
#   plan (default) | apply | rollback        rollback = service back on revision 20.
set -euo pipefail
ACCOUNT=472838866351; REGION=eu-central-1; CLUSTER=Vitana-ECS-Cluster
SERVICE=vitana-postgrest-aurora-proxy; BASE=vitana-postgrest-aurora-staging:20
OLD=vitana/gateway/staging/supabase-jwt-secret; NEW=vitana/gateway/staging/postgrest-jwt-secret
export AWS_REGION=$REGION AWS_DEFAULT_REGION=$REGION
[ "$(aws sts get-caller-identity --query Account --output text)" = "$ACCOUNT" ] || { echo "wrong account" >&2; exit 1; }
CMD="${1:-plan}"
NEW_ARN=$(aws secretsmanager describe-secret --secret-id "$NEW" --query ARN --output text)
TD=$(aws ecs describe-task-definition --task-definition "$BASE" --query taskDefinition \
  | jq --arg old "$OLD" --arg new "$NEW_ARN" '
      .containerDefinitions |= map(if .secrets then .secrets |= map(
          if .name=="PGRST_JWT_SECRET" then (if (.valueFrom|contains($old)) then .valueFrom=$new else error("PGRST_JWT_SECRET is not \($old)") end) else . end) else . end)
      | del(.taskDefinitionArn,.revision,.status,.requiresAttributes,.compatibilities,.registeredAt,.registeredBy,.deregisteredAt)')
case "$CMD" in
  plan)
    diff <(aws ecs describe-task-definition --task-definition "$BASE" --query 'taskDefinition.containerDefinitions' | jq -S .) \
         <(jq -S .containerDefinitions <<<"$TD") | sed -E 's/secret:([^"]+)-[A-Za-z0-9]{6}"/secret:\1"/' || true
    echo "plan OK — nothing written";;
  apply)
    ARN=$(aws ecs register-task-definition --cli-input-json "$TD" --query taskDefinition.taskDefinitionArn --output text)
    aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --task-definition "$ARN" --desired-count 1 >/dev/null
    aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
    echo "proxy on $ARN (rollback: $0 rollback)";;
  rollback)
    aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --task-definition "$BASE" --desired-count 1 >/dev/null
    aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
    echo "proxy back on $BASE";;
  *) echo "usage: $0 <plan|apply|rollback>" >&2; exit 2;;
esac
