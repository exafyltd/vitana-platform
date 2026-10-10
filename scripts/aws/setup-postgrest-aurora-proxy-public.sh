#!/usr/bin/env bash
# Public HTTPS endpoint for the PostgREST-Aurora proxy (VTID-05023).
#
# The browser app talks to Supabase directly, so at the Aurora cutover it must
# be pointed at this proxy (VITE_SUPABASE_URL). Until now the proxy was only
# reachable inside the VPC (Cloud Map). This puts it behind the existing
# vitana-alb-prod ALB at https://$HOST, following the same pattern as
# dr-gateway (docs/AWS-PRODUCTION-BUILD-LOG.md):
#
#   1. check PGRST_JWT_SECRET == the production Supabase JWT secret (else every
#      logged-in request through the proxy fails) -- compared by hash only
#   2. target group vitana-tg-pgproxy-prod (ip, 8080, health /alive)
#   3. host-header rule on the 443 listener, priority 8 (< 10, see CLAUDE.md §1b)
#   4. attach the target group to ECS service vitana-postgrest-aurora-proxy and
#      run 2 tasks (it becomes member-facing; Cloud Map registration is kept)
#   5. Cloudflare CNAME $HOST -> ALB, proxied (needs CLOUDFLARE_API_TOKEN;
#      otherwise prints the record to create by hand)
#   6. verify /alive and /rest/v1/ through the public URL
#
# Idempotent: re-running skips what exists. Changes nothing for current
# traffic: no member client points at this host until the frontend repoint.
# Usage: bash setup-postgrest-aurora-proxy-public.sh        (HOST overridable)
set -euo pipefail
export AWS_PAGER=""
R=eu-central-1
HOST=${HOST:-data.vitanaland.com}
CLUSTER=Vitana-ECS-Cluster
SERVICE=vitana-postgrest-aurora-proxy
TG_NAME=vitana-tg-pgproxy-prod
VPC=vpc-05958f035e596fe64
LISTENER=arn:aws:elasticloadbalancing:eu-central-1:472838866351:listener/app/vitana-alb-prod/3d60b7c377e63d95/48eba68d49c39439
ALB_DNS=vitana-alb-prod-1579322953.eu-central-1.elb.amazonaws.com
CF_ZONE=859c786db63e634e0ee36065e8a06e20
PRIORITY=8

echo "== 1/6 JWT secret check"
TD=$(aws ecs describe-services --region $R --cluster $CLUSTER --services $SERVICE --query 'services[0].taskDefinition' --output text)
JWT_ARN=$(aws ecs describe-task-definition --region $R --task-definition "$TD" \
  --query "taskDefinition.containerDefinitions[?name=='postgrest'].secrets[] | [?name=='PGRST_JWT_SECRET'].valueFrom | [0]" --output text)
h() { aws secretsmanager get-secret-value --region $R --secret-id "$1" --query SecretString --output text | tr -d '\n' | sha256sum | cut -c1-16; }
if [ "$(h "$JWT_ARN")" = "$(h vitana/supabase/prod/jwt-secret)" ]; then
  echo "  PGRST_JWT_SECRET matches vitana/supabase/prod/jwt-secret"
else
  echo "  STOP: PGRST_JWT_SECRET ($JWT_ARN) differs from vitana/supabase/prod/jwt-secret." >&2
  echo "  Logged-in requests through the proxy would be rejected. Send this to Claude." >&2
  exit 1
fi

echo "== 2/6 target group"
TG=$(aws elbv2 describe-target-groups --region $R --names $TG_NAME --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true)
if [ -z "$TG" ] || [ "$TG" = None ]; then
  TG=$(aws elbv2 create-target-group --region $R --name $TG_NAME --protocol HTTP --port 8080 \
    --vpc-id $VPC --target-type ip --health-check-path /alive --health-check-interval-seconds 15 \
    --healthy-threshold-count 2 --unhealthy-threshold-count 3 --matcher HttpCode=200 \
    --query 'TargetGroups[0].TargetGroupArn' --output text)
  # give in-flight requests time on deploys (realtime clients heartbeat every
  # ~30s, so the ALB's default 60s idle timeout is enough; it is shared, left as is)
  aws elbv2 modify-target-group-attributes --region $R --target-group-arn "$TG" \
    --attributes Key=deregistration_delay.timeout_seconds,Value=60 >/dev/null
  echo "  created $TG"
else
  echo "  exists $TG"
fi

echo "== 3/6 listener rule ($HOST, priority $PRIORITY)"
EXISTING=$(aws elbv2 describe-rules --region $R --listener-arn $LISTENER \
  --query "Rules[?Conditions[?Field=='host-header' && contains(HostHeaderConfig.Values, '$HOST')]].RuleArn | [0]" --output text)
if [ -z "$EXISTING" ] || [ "$EXISTING" = None ]; then
  aws elbv2 create-rule --region $R --listener-arn $LISTENER --priority $PRIORITY \
    --conditions "Field=host-header,HostHeaderConfig={Values=[$HOST]}" \
    --actions "Type=forward,TargetGroupArn=$TG" --query 'Rules[0].RuleArn' --output text
else
  echo "  exists $EXISTING"
fi

echo "== 4/6 attach to ECS service, 2 tasks"
ATTACHED=$(aws ecs describe-services --region $R --cluster $CLUSTER --services $SERVICE \
  --query "services[0].loadBalancers[?targetGroupArn=='$TG'] | length(@)" --output text)
if [ "$ATTACHED" = 0 ]; then
  aws ecs update-service --region $R --cluster $CLUSTER --service $SERVICE \
    --load-balancers "targetGroupArn=$TG,containerName=proxy,containerPort=8080" \
    --health-check-grace-period-seconds 60 --desired-count 2 --query 'service.serviceName' --output text >/dev/null
  echo "  attached; waiting for the service to be stable (a few minutes)"
else
  aws ecs update-service --region $R --cluster $CLUSTER --service $SERVICE --desired-count 2 >/dev/null
  echo "  already attached"
fi
aws ecs wait services-stable --region $R --cluster $CLUSTER --services $SERVICE
aws elbv2 describe-target-health --region $R --target-group-arn "$TG" \
  --query 'TargetHealthDescriptions[].[Target.Id,TargetHealth.State]' --output text | sed 's/^/  target /'

echo "== 5/6 Cloudflare CNAME $HOST -> ALB (proxied)"
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  CF=https://api.cloudflare.com/client/v4/zones/$CF_ZONE/dns_records
  N=$(curl -s "$CF?name=$HOST" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)["result"]))')
  if [ "$N" = 0 ]; then
    curl -s -X POST "$CF" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
      -d "{\"type\":\"CNAME\",\"name\":\"$HOST\",\"content\":\"$ALB_DNS\",\"proxied\":true,\"ttl\":1}" \
      | python3 -c 'import sys,json; r=json.load(sys.stdin); print("  created" if r["success"] else r["errors"])'
  else
    echo "  exists"
  fi
else
  echo "  CLOUDFLARE_API_TOKEN not set -- create this record in Cloudflare (zone vitanaland.com):"
  echo "    CNAME  $HOST  ->  $ALB_DNS   (Proxied: on)"
  echo "  then re-run this script to verify."
  exit 0
fi

echo "== 6/6 verify https://$HOST"
for i in $(seq 1 20); do curl -sf "https://$HOST/alive" >/dev/null && break; sleep 15; done
curl -s -o /dev/null -w "  /alive -> %{http_code}\n" "https://$HOST/alive"
ANON=$(aws secretsmanager get-secret-value --region $R --secret-id vitana/supabase/prod/anon-key --query SecretString --output text)
curl -s -o /dev/null -w "  /rest/v1/ (anon) -> %{http_code} %{content_type}\n" "https://$HOST/rest/v1/" -H "apikey: $ANON" -H "Authorization: Bearer $ANON"
curl -s -o /dev/null -w "  /auth/v1/health -> %{http_code}\n" "https://$HOST/auth/v1/health" -H "apikey: $ANON"
curl -s -o /dev/null -w "  /storage/v1/version -> %{http_code}\n" "https://$HOST/storage/v1/version" -H "apikey: $ANON"
echo "ALL DONE"
