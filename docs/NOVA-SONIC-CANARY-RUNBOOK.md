# Nova 2 Sonic — AWS Staging Canary Runbook (BOOTSTRAP-NOVA-SONIC-VOICE)

Operator-side steps to activate, verify, and roll back the Nova 2 Sonic
voice canary on the AWS ECS staging gateway (`vitana-gateway`,
`eu-central-1`, `https://preview-aws-gateway.vitanaland.com`). The code
side (client, selection, rotation, telemetry, workflow env upsert, smoke
script) ships with this change set; nothing below runs automatically.

Target model: `amazon.nova-2-sonic-v1:0` in `eu-north-1` (in-region only;
no geo/global inference profile). Credentials: ECS task role via the AWS
SDK default chain — never static keys, never Bedrock API keys.

## 1. One-time: least-privilege task-role policy (IAM admin required)

```bash
aws sts get-caller-identity   # expect account 472838866351
aws ecs describe-services --cluster Vitana-ECS-Cluster --services vitana-gateway \
  --region eu-central-1 \
  --query 'services[0].{status:status,taskDefinition:taskDefinition,desired:desiredCount,running:runningCount}'
aws bedrock get-foundation-model --model-identifier amazon.nova-2-sonic-v1:0 --region eu-north-1

MODEL_ARN='arn:aws:bedrock:eu-north-1::foundation-model/amazon.nova-2-sonic-v1:0'
TASK_ROLE_ARN="$(aws ecs describe-task-definition --task-definition vitana-gateway \
  --region eu-central-1 --query 'taskDefinition.taskRoleArn' --output text)"
TASK_ROLE_NAME="${TASK_ROLE_ARN##*/}"   # confirm: vitana-ecs-task-role

POLICY="$(jq -nc --arg resource "$MODEL_ARN" '{
  Version:"2012-10-17",
  Statement:[{Sid:"InvokeNova2SonicEuNorth1",Effect:"Allow",
    Action:["bedrock:InvokeModel"],Resource:$resource}]}')"
aws iam put-role-policy --role-name "$TASK_ROLE_NAME" \
  --policy-name VitanaNova2SonicInvoke --policy-document "$POLICY"

aws iam simulate-principal-policy --policy-source-arn "$TASK_ROLE_ARN" \
  --action-names bedrock:InvokeModel --resource-arns "$MODEL_ARN" \
  --query 'EvaluationResults[0].EvalDecision' --output text   # expect: allowed
```

## 2. GitHub repository variables (environment-scoped)

`AWS-STAGE-DEPLOY-GATEWAY.yml` upserts these onto the task definition on
every deploy (model + region are fixed in the workflow, not variables):

```text
AWS_STAGE_NOVA_SONIC_ENABLED=false
AWS_STAGE_NOVA_SONIC_CANARY_USER_IDS=
AWS_STAGE_NOVA_SONIC_CANARY_TENANT_IDS=
```

## 3. Deploy with Nova disabled + verify surfaces

Dispatch `AWS-STAGE-DEPLOY-GATEWAY.yml` (defaults target staging), then:

```bash
curl -fsS https://preview-aws-gateway.vitanaland.com/api/v1/admin/health | jq '.env'   # "staging"
curl -fsS https://preview-aws-gateway.vitanaland.com/api/v1/orb/nova-sonic/health | jq
# expect: region eu-north-1, model amazon.nova-2-sonic-v1:0, enabled false, issues []
```

(The workflow's own smoke step now asserts the Nova health surface too.)

## 4. Runtime credential smoke (one-off Fargate task)

Run the compiled smoke script with the STAGING task definition, subnets,
security groups, and task role — this proves the runtime credential path,
not the GitHub deploy user's keys. Requires container exit code 0:

```bash
CLUSTER=Vitana-ECS-Cluster; REGION=eu-central-1
TD=$(aws ecs describe-services --cluster $CLUSTER --services vitana-gateway \
  --region $REGION --query 'services[0].taskDefinition' --output text)
NETCFG=$(aws ecs describe-services --cluster $CLUSTER --services vitana-gateway \
  --region $REGION --query 'services[0].networkConfiguration')
TASK_ARN=$(aws ecs run-task --cluster $CLUSTER --launch-type FARGATE --region $REGION \
  --task-definition "$TD" --network-configuration "$NETCFG" \
  --overrides '{"containerOverrides":[{"name":"'"$(aws ecs describe-task-definition --task-definition "$TD" --region $REGION --query 'taskDefinition.containerDefinitions[0].name' --output text)"'","command":["node","dist/scripts/nova-sonic-smoke.js"],"environment":[{"name":"NOVA_SONIC_REGION","value":"eu-north-1"}]}]}' \
  --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --cluster $CLUSTER --tasks "$TASK_ARN" --region $REGION
aws ecs describe-tasks --cluster $CLUSTER --tasks "$TASK_ARN" --region $REGION \
  --query 'tasks[0].containers[0].exitCode'   # expect: 0
```

## 5. Enable the one-user canary

```text
AWS_STAGE_NOVA_SONIC_ENABLED=true
AWS_STAGE_NOVA_SONIC_CANARY_USER_IDS=a27552a3-0257-4305-8ed0-351a80fd3701
AWS_STAGE_NOVA_SONIC_CANARY_TENANT_IDS=
```

Dispatch the workflow. Confirm a non-allowlisted user still selects Vertex
(OASIS `orb.upstream.provider.selected` shows `reason=system_config_vertex`
or `default`; the canary user shows `reason=nova_canary_allowlisted`).

Functional matrix (EN + DE): wake/greeting, two turns, barge-in while
speaking, one read-only tool, one staging-safe state-changing tool,
navigation directive, persona swap + return, stop/reopen without duplicate
greeting, a session held past 7m15s (transparent rotation — watch for
`orb.upstream.nova.rotation_succeeded`, no browser disconnect, no
re-greeting), and an anonymous/non-allowlisted session (Vertex fallback).

Acceptance gates (≥20 Nova sessions): 100% provider/model/region
attribution; ≥95% connect success; zero access-denied/model-not-found/
protocol-validation/duplicate-tool-result failures; first-audio p95 < 5 s
and ≤ 1.2× the AWS-staging Vertex baseline; 100% tool-result completion;
playback queue clears on every interruption; usage telemetry
(`orb.live.upstream.usage`) on every completed session; no raw
audio/transcripts/credentials/SigV4 in CloudWatch/OASIS.

## 6. Expand (AWS staging only)

One internal tenant → observe one working day → intended test cohort.
Never flip the shared `system_config['voice.active_provider']` row for the
canary (AWS/GCP staging share data); never enable Nova on GCP or prod.
Emergency rollback for a single runtime: `ORB_LIVE_PROVIDER=vertex`.

## 7. Rollback drill

```text
AWS_STAGE_NOVA_SONIC_ENABLED=false
AWS_STAGE_NOVA_SONIC_CANARY_USER_IDS=
AWS_STAGE_NOVA_SONIC_CANARY_TENANT_IDS=
```

Dispatch, then verify the former canary user selects Vertex and completes
a live turn.

## 8. Record the staging decision

Attach to the VTID record: deployed commit SHA, ECS task-definition
revision, model+region, IAM simulation output, Nova health response,
connect/latency/usage aggregates, functional-matrix results, rotation
evidence, rollback proof. **Production activation needs a separate plan** —
GCP Cloud Run cannot carry Nova's HTTP/2 stream; prod must choose AWS
gateway routing for Nova voice traffic or a dedicated AWS voice proxy.
