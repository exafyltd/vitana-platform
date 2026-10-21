# AWS Production (DR) — Gateway: Build Log

**VTID:** VTID-03398 · **Built:** 2026-07-23 · **Branch:** `claude/aws-production-build`

Supersedes `docs/AWS-PRODUCTION-HANDOVER.md` as the current-state reference
for the AWS DR gateway. That doc's "what's not built yet" list undercounted
what already existed in this AWS account (see "Pre-existing state found"
below) — this log records what's real as of this build.

No IaC exists in this repo (same as staging) — everything below was
provisioned by hand via `aws-cli`. Commands are captured verbatim so this is
reproducible/auditable even without Terraform/CDK.

---

## Scope confirmed with the user

Parallel/DR production for the `gateway` service only, alongside GCP prod
(canonical) and the existing AWS staging (`vitana-gateway`, unaffected by
this build). AWS prod shares GCP prod's Supabase project
(`inmkhvwdcuyhnxkgfvsb`) — confirmed via the pre-existing
`vitana/supabase/prod/*` Secrets Manager entries. The AWS production Aurora
database (in sync with Supabase) was already provisioned by the user ahead
of this session.

## Pre-existing state found (important — read before assuming "not built yet")

Before provisioning anything, read-only investigation (`aws elbv2
describe-target-groups` / `describe-load-balancers` / `describe-listeners`,
`aws ecs list-services`) found:

- `vitana-alb-prod` — a fully-built internet-facing ALB (created
  2026-07-10) with a real ACM cert for `vitanaland.com` / `*.vitanaland.com`,
  serving `preview-aws-gateway.vitanaland.com` / `preview-aws.vitanaland.com`
  via Cloudflare CNAME. Its `vitana-tg-gateway-prod` / `vitana-tg-community-prod`
  target groups are misleadingly named — they actually carry **staging**
  traffic (`vitana-gateway` / `vitana-community-app` ECS services). This is
  a naming leftover, not a hidden second prod build — confirmed by checking
  `env` in `/api/v1/admin/health` responses through that ALB (`staging`).
- **29 ECS services** in `Vitana-ECS-Cluster`, all created within the same
  3-second window (2026-07-09T13:25:05 UTC) — a single scripted
  bulk-provisioning event predating this session. Includes
  `vitana-community-app`, `vitana-oasis-operator`, `vitana-oasis-projector`,
  `vitana-worker-runner`, `vitana-vitana-verification-engine`, plus ~17
  services with no counterpart in CLAUDE.md or GCP. **None of these were
  touched by this build** — gateway-only scope was strictly honored. Their
  origin/purpose is outside this VTID's scope; flagged to the user, who
  confirmed the AWS prod DB layer (Aurora, in sync with Supabase) is
  intentional and authorized proceeding.
- Data layer already provisioned for prod: RDS Aurora PostgreSQL cluster
  `vitana-aurora-prod` (writer + reader endpoints), ElastiCache Redis
  `vitana-redis-prod`, and Secrets Manager entries
  `vitana/supabase/prod/{url,anon-key,service-role-key,jwt-secret}` and
  `vitana/aurora/prod/{master-password,database-url}`.

## What this build added (all new, additively named `*-awsdr` / `dr-*`)

| Resource | Name / value |
|---|---|
| CloudWatch log group | `/vitana/gateway-awsdr` |
| ECS task definition family | `vitana-gateway-awsdr` (revision 1, cloned from `vitana-gateway`'s live staging task def, prod values swapped in) |
| ECS service | `vitana-gateway-awsdr` in `Vitana-ECS-Cluster`, Fargate, desiredCount=1 (autoscaling 1–4, see below) |
| ELBv2 target group | `vitana-tg-gateway-awsdr` (port 8080, health check `/alive`) |
| ALB listener rule | Host-header `dr-gateway.vitanaland.com` → `vitana-tg-gateway-awsdr`, **priority 5** on `vitana-alb-prod`'s existing HTTPS listener (443) |
| DNS | Cloudflare CNAME `dr-gateway.vitanaland.com` → `vitana-alb-prod-1579322953.eu-central-1.elb.amazonaws.com` (proxied, same pattern as staging's `preview-aws-gateway`) |
| TLS | Reused the ALB's existing `*.vitanaland.com` ACM cert — no new certificate needed |
| Autoscaling | Target-tracking, `ECSServiceAverageCPUUtilization` @ 65%, min 1 / max 4 |
| CloudWatch alarms | `vitana-gateway-awsdr-target-5xx`, `-unhealthy-hosts`, `-cpu-high`, `-memory-high` |
| Deploy workflow | `.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml` — `workflow_dispatch`-only, required `reason`, never on push |

No new Secrets Manager entries were needed — the task definition's
`secrets` block reuses the pre-existing prod-scoped secrets above, plus the
existing RDS-managed master credential
(`rds!cluster-eba8a4f2-3caa-4f11-88f0-c3102c3c176a`) for `DB_PASSWORD`. One
security improvement made over the staging task def: `SUPABASE_JWT_SECRET`,
`SUPABASE_ANON_KEY`, and `GATEWAY_SERVICE_TOKEN` are wired as Secrets
Manager references in the prod task def (staging has them as plaintext env
vars, and `GATEWAY_SERVICE_TOKEN` in staging is literally a placeholder
string, not a working token — not fixed here since it's out of this VTID's
gateway-DR scope, but worth a follow-up VTID against staging).

### ALB listener-rule priority — read this before adding another host-header rule

`vitana-alb-prod` has **path-based** rules at priority 10 (`/api/*`,
`/ws/*` → the staging gateway TG) and 20 (`/community*` → staging
community TG), evaluated before any higher-numbered rule regardless of
`Host` header. The DR rule was created at priority 15 first — API calls to
`dr-gateway.vitanaland.com/api/*` were silently served by the **staging**
gateway (path-based rule 10 matched before the host-based rule 15 was
evaluated). Caught by `/api/v1/admin/health` returning `env: staging`
against `dr-gateway.vitanaland.com`. Fixed by moving the rule to
**priority 5**. Any future host-header rule added to this ALB must sit
below (numerically lower priority than) 10, or it will silently lose to
the path-based staging rules.

## Commands run (chronological, redacted of secret values)

```bash
# Log group
aws logs create-log-group --log-group-name /vitana/gateway-awsdr --region eu-central-1

# Task definition — registered from a JSON built by cloning
# `aws ecs describe-task-definition --task-definition vitana-gateway` (rev 38)
# and swapping: VITANA_ENV/ENVIRONMENT/ENV -> production, GATEWAY_URL ->
# https://dr-gateway.vitanaland.com, DB_HOST/DB_READER_HOST -> Aurora prod
# writer/reader endpoints, REDIS_HOST -> vitana-redis-prod, log group ->
# /vitana/gateway-awsdr, and secrets -> the vitana/supabase/prod/* +
# rds!cluster-eba8a4f2... ARNs.
aws ecs register-task-definition --cli-input-json file://gateway-awsdr-taskdef-register.json --region eu-central-1

# Target group
aws elbv2 create-target-group --name vitana-tg-gateway-awsdr --protocol HTTP --port 8080 \
  --vpc-id vpc-05958f035e596fe64 --target-type ip --health-check-protocol HTTP \
  --health-check-path /alive --health-check-interval-seconds 15 --health-check-timeout-seconds 5 \
  --healthy-threshold-count 2 --unhealthy-threshold-count 3 --matcher HttpCode=200 --region eu-central-1

# Listener rule (host-header, dr-gateway.vitanaland.com)
aws elbv2 create-rule \
  --listener-arn arn:aws:elasticloadbalancing:eu-central-1:472838866351:listener/app/vitana-alb-prod/3d60b7c377e63d95/48eba68d49c39439 \
  --priority 15 \
  --conditions Field=host-header,HostHeaderConfig={Values=[dr-gateway.vitanaland.com]} \
  --actions Type=forward,TargetGroupArn=arn:aws:elasticloadbalancing:eu-central-1:472838866351:targetgroup/vitana-tg-gateway-awsdr/a2b0e810877c12e7 \
  --region eu-central-1
# ... then fixed the priority (see "ALB listener-rule priority" above):
aws elbv2 set-rule-priorities \
  --rule-priorities RuleArn=<rule-arn>,Priority=5 --region eu-central-1

# ECS service
aws ecs create-service --cluster Vitana-ECS-Cluster --service-name vitana-gateway-awsdr \
  --task-definition vitana-gateway-awsdr --desired-count 1 --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-0ff45a2051c5e5482,subnet-0c786864a28a5a821],securityGroups=[sg-0fbcf7b59b1f0d685],assignPublicIp=DISABLED}" \
  --load-balancers "targetGroupArn=arn:...targetgroup/vitana-tg-gateway-awsdr/...,containerName=gateway,containerPort=8080" \
  --region eu-central-1

# DNS (Cloudflare API, zone 859c786db63e634e0ee36065e8a06e20)
curl -X POST "https://api.cloudflare.com/client/v4/zones/859c786db63e634e0ee36065e8a06e20/dns_records" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"CNAME","name":"dr-gateway.vitanaland.com","content":"vitana-alb-prod-1579322953.eu-central-1.elb.amazonaws.com","proxied":true,"ttl":1}'

# Autoscaling
aws application-autoscaling register-scalable-target --service-namespace ecs \
  --resource-id service/Vitana-ECS-Cluster/vitana-gateway-awsdr --scalable-dimension ecs:service:DesiredCount \
  --min-capacity 1 --max-capacity 4 --region eu-central-1
aws application-autoscaling put-scaling-policy --service-namespace ecs \
  --resource-id service/Vitana-ECS-Cluster/vitana-gateway-awsdr --scalable-dimension ecs:service:DesiredCount \
  --policy-name vitana-gateway-awsdr-cpu-target-tracking --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration '{"TargetValue":65.0,"PredefinedMetricSpecification":{"PredefinedMetricType":"ECSServiceAverageCPUUtilization"},"ScaleInCooldown":120,"ScaleOutCooldown":60}' \
  --region eu-central-1

# Alarms (repeat put-metric-alarm for target-5xx, unhealthy-hosts, cpu-high, memory-high — see workflow/task list for exact params)
```

## Verification performed

- `GET /alive` → `200 {"status":"ok","service":"gateway",...}`
- `GET /api/v1/admin/health` → `200 {"ok":true,"env":"production","supabase_host":"inmkhvwdcuyhnxkgfvsb.supabase.co",...}`
- `GET /api/v1/admin/build-info` → commit matches the running task's image (`bf1f1add2398...`, same proven commit as AWS staging)
- Live ORB voice session: `POST /api/v1/orb/live/session/start` (test user `a27552a3-0257-4305-8ed0-351a80fd3701`) then `GET /api/v1/orb/live/stream`. First attempt closed with `code=1011 Internal error encountered` after a ~14s stall between transcript fragments (not the previously-fixed `1007` payload-size bug); second attempt completed cleanly — 404 audio chunks, 37 `output_transcript` fragments, ending in `turn_complete`, no error close. Treated as a one-off upstream Gemini Live hiccup, not a deployment defect — logs confirm correct transport (`api_key`/AI Studio), correct budget-trim behavior (no repeat of the fixed 30KB overflow bug), and matching `env=production`/Supabase project.
- Regression check: AWS staging (`preview-aws-gateway.vitanaland.com`) still reports `env: staging` with its original (unchanged) boot time — confirmed untouched by this build.

## Not completed — requires IAM-admin AWS credentials this session does not have

The session's AWS IAM user (`claude-staging-validation`) has
`AmazonECS_FullAccess`, `AmazonEC2ContainerRegistryFullAccess`,
`ElasticLoadBalancingFullAccess`, and `ReadOnlyAccess` — **no IAM write
permissions at all**. Confirmed directly: both
`iam:CreateOpenIDConnectProvider` and `iam:CreateRole` returned
`AccessDenied`. `AWS-PROD-DEPLOY-GATEWAY.yml` is written and ready, but it
references `secrets.AWS_PROD_ROLE_ARN`, which does not exist yet — the
workflow cannot be dispatched until an operator with IAM admin rights runs
the one-time setup below (mirrors `scripts/aws/README.md`'s existing OIDC
pattern for the S3-mirror role).

### One-time setup (run once, by a human/session with IAM admin rights)

```bash
# 1. Create the GitHub OIDC provider for this AWS account (skip if
#    scripts/aws/README.md's provider already exists — check first with
#    `aws iam list-open-id-connect-providers`).
aws iam create-open-id-connect-provider \
  --url "https://token.actions.githubusercontent.com" \
  --client-id-list "sts.amazonaws.com" \
  --thumbprint-list "1c58a3a8518e8759bf075b76b750d4f2df264fcd"

# 2. Create the deploy role, trust-scoped to this repo's main branch only
#    (tighter than the mirror role's `repo:exafyltd/vitana-platform:*` —
#    this role can deploy production, so it's restricted to workflow runs
#    triggered against `main`).
cat > /tmp/trust-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::472838866351:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike": { "token.actions.githubusercontent.com:sub": "repo:exafyltd/vitana-platform:ref:refs/heads/main" }
    }
  }]
}
EOF
aws iam create-role --role-name vitana-gateway-awsdr-deploy-role \
  --assume-role-policy-document file:///tmp/trust-policy.json

# 3. Attach a policy scoped to exactly what the deploy workflow needs:
#    ECR push/pull on vitana/gateway, and ECS register/describe/update on
#    the awsdr service + its task definition family, plus PassRole for the
#    two roles the task definition already uses.
cat > /tmp/deploy-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["ecr:GetAuthorizationToken"], "Resource": "*" },
    { "Effect": "Allow", "Action": ["ecr:BatchCheckLayerAvailability","ecr:GetDownloadUrlForLayer","ecr:BatchGetImage","ecr:PutImage","ecr:InitiateLayerUpload","ecr:UploadLayerPart","ecr:CompleteLayerUpload","ecr:DescribeRepositories"],
      "Resource": "arn:aws:ecr:eu-central-1:472838866351:repository/vitana/gateway" },
    { "Effect": "Allow", "Action": ["ecs:DescribeServices","ecs:UpdateService","ecs:DescribeTaskDefinition","ecs:RegisterTaskDefinition","ecs:ListServices"],
      "Resource": "*" },
    { "Effect": "Allow", "Action": "iam:PassRole",
      "Resource": ["arn:aws:iam::472838866351:role/vitana-ecs-task-execution-role", "arn:aws:iam::472838866351:role/vitana-ecs-task-role"] }
  ]
}
EOF
aws iam put-role-policy --role-name vitana-gateway-awsdr-deploy-role \
  --policy-name deploy-permissions --policy-document file:///tmp/deploy-policy.json

# 4. Wire the role ARN into the repo secret.
gh secret set AWS_PROD_ROLE_ARN --repo exafyltd/vitana-platform \
  --body "arn:aws:iam::472838866351:role/vitana-gateway-awsdr-deploy-role"

# 5. Prove it: dispatch the workflow once.
gh workflow run AWS-PROD-DEPLOY-GATEWAY.yml --ref main -f reason="initial OIDC wiring smoke test"
```

## Natural next steps (not built — out of scope for this VTID)

- Extend the same DR pattern to `oasis-operator`, `oasis-projector`,
  `worker-runner`, `vitana-verification-engine`, and the frontend
  (`community-app`) — explicitly deferred per the agreed gateway-only
  first slice.
- Fix the `GATEWAY_SERVICE_TOKEN` placeholder-string bug on **AWS
  staging** (`vitana-gateway` task def) — discovered as a side effect of
  building this prod task def correctly; not fixed on staging since it's
  outside this VTID's scope.
- Investigate/document the other ~27 pre-existing ECS services found
  during this build (see "Pre-existing state found" above) — separate
  from gateway DR, flagged for the user's awareness, not investigated
  further here.
- CloudWatch dashboard (alarms exist; a consolidated dashboard view does
  not yet).

---

## Addendum (2026-07-23): VTID-03407 dual-publish + VTID-03408 backend repairs

Two follow-ups after the initial build, in the context of assessing
whether a full GCP→AWS cutover is achievable by Mon 27 Jul 2026.

### VTID-03407 — Command Hub PUBLISH dual-publish (gateway only)

`services/gateway/src/routes/operator.ts` `POST /publish` gained a
best-effort step that also dispatches `AWS-PROD-DEPLOY-GATEWAY.yml` with
the same commit already resolved for the GCP publish, gated behind
`AWS_DUAL_PUBLISH_ENABLED` (default off). See PR #2925 (merged). GCP
remains canonical; this is additive redundancy only, gateway-scoped.

### VTID-03408 — mystery-service viability assessment + 3 real fixes

Investigated the 5 named services from the 2026-07-09 `migration-arman`
bulk-provisioning batch flagged in the original build. Verdicts:

| Service | Verdict | Root cause found |
|---|---|---|
| `oasis-operator` | **Dead** | Running an abandoned `main.py.backup-*` stub from Oct/Nov 2025 — that source no longer exists in the repo, no Dockerfile, no AWS deploy pipeline. Not a config fix; needs real application work. |
| `oasis-projector` | **Fixed** | RDS Proxy (`vitana-rds-proxy-prod`) and Aurora (`vitana-aurora-prod`) share security group `sg-0838b2f2dabe87971` (`vitana-sg-aurora`), which had no self-referencing rule — the proxy could not reach its own backend (`DBProxy Target unavailable due to an internal error` on both reader/writer targets). Fixed by adding an inbound self-reference rule (TCP 5432, `sg-0838b2f2dabe87971` → itself). Confirmed: proxy targets now `AVAILABLE`, `oasis-projector` logs `Database connected` on redeploy. |
| `worker-runner` | **Fixed** | Task definition's `GATEWAY_URL` was `http://gateway.vitanaland.com` (scheme typo — should be `https://`), causing every orchestrator-registration call to fail with `socket hang up`. Fixed via a new task definition revision (`vitana-worker-runner:6`) with the corrected URL; service was at `desiredCount=0`, restored to 1. Confirmed: `Worker registered successfully`, polling every 5s. |
| `vitana-verification-engine` | **Fixed** | Same `GATEWAY_URL` scheme typo, causing every heartbeat to fail with `Server disconnected without sending a response`. Fixed via `vitana-vitana-verification-engine:6`. Confirmed: `[agents-registry] Registered vitana-orchestrator`, heartbeats now `200 OK` every 60s. |
| `community-app` | **Real, staging-only** | Genuinely healthy, actively CI/CD-built (`AWS-STAGE-DEPLOY-FRONTEND.yml` in `exafyltd/vitana-v1`), but bakes `preview-aws-gateway.vitanaland.com` and has no production hostname/workflow. Needs a real AWS-prod frontend deploy pipeline + DNS decision — not built here. |

None of these fixes extend VTID-03398-grade governance (dedicated ALB
rule, autoscaling, alarms, dispatch-only CI, OIDC) to these services —
they only repair what was already there so the platform's actual AWS
readiness could be honestly assessed. **Verdict: a full GCP→AWS cutover
by Monday remains unrealistic** — `oasis-operator` needs real
application work from scratch, and `community-app` needs a full
production deploy pipeline; neither is a same-day fix. `oasis-projector`,
`worker-runner`, and `verification-engine` are now at least functionally
correct, which is real progress toward that goal on a longer timeline.

### Commands run

```bash
# RDS proxy fix
aws ec2 authorize-security-group-ingress \
  --group-id sg-0838b2f2dabe87971 --protocol tcp --port 5432 \
  --source-group sg-0838b2f2dabe87971 --region eu-central-1

# worker-runner / verification-engine: patch GATEWAY_URL http -> https in a
# cloned task definition (same pattern as the original build), then:
aws ecs register-task-definition --cli-input-json file://<patched>.json --region eu-central-1
aws ecs update-service --cluster Vitana-ECS-Cluster --service <service> \
  --task-definition <family>:<new-revision> --region eu-central-1
```

---

## Addendum (2026-07-23 cont'd): VTID-03409 community-app + VTID-03410 oasis-operator

Extending AWS-DR to a second and third service, per explicit user
request, continuing the assessment of full-cutover feasibility.

### VTID-03409 — AWS Production for community-app (frontend)

New ECS service `vitana-community-app-awsdr`, target group
`vitana-tg-community-awsdr`, ALB host rule `dr-app.vitanaland.com`
(priority 6 — below the path-based rules at 10/20, per the priority
lesson from the gateway build). New workflow
`AWS-PROD-DEPLOY-FRONTEND.yml` in `exafyltd/vitana-v1`
(`workflow_dispatch`-only, required `reason`), bakes the CANONICAL GCP
prod gateway URL (`gateway.vitanaland.com`) into the Vite build via
`.env.production` at build time — this is a static SPA, there is no
runtime env var to flip after the fact. Reuses the existing
`AWS_STAGING_ACCESS_KEY_ID`/`SECRET` repo secrets (static keys, same
shortcut already present for AWS staging — a dedicated OIDC role is a
follow-up, not built here to avoid a second IAM-elevation round-trip).

### VTID-03410 — Rebuild oasis-operator for AWS Production (DR)

Real source never existed in git for this service (see the VTID-03408
addendum above) — restored `services/oasis-operator/main.py` verbatim
from the last known-good snapshot (`main.py.backup-20251101-111126`,
Nov 2025), added `requirements.txt` + `Dockerfile` (neither existed
before), and deleted the now-superseded `.backup*` files. **One
deliberate change from the backup:** the CORS allowlist previously only
covered legacy Lovable preview origins; added the current Vitana gateway
hosts (`gateway.vitanaland.com`, `preview-gateway.vitanaland.com`,
`preview-aws-gateway.vitanaland.com`, `dr-gateway.vitanaland.com`) since
that's how the Command Hub is actually served today — without this the
restored service would silently reject every real request via CORS.

New ECS service `vitana-oasis-operator-awsdr` (256 CPU / 512 MB — this
is a lightweight, stateless, in-memory-only service with zero database
dependency), target group `vitana-tg-oasis-op-awsdr`, ALB host rule
`dr-oasis-operator.vitanaland.com` (priority 7). New workflow
`AWS-PROD-DEPLOY-OASIS-OPERATOR.yml` — the first governed CI/CD path
this service has ever had on any platform — reuses the GitHub-OIDC
deploy role from VTID-03398 (`vitana-gateway-awsdr-deploy-role`), whose
inline policy was extended (via the still-active temporary IAM grant on
this session's user, see the VTID-03398 section above) to add the
`vitana/oasis-operator` ECR repository alongside `vitana/gateway`.

Initial task definition uses the ECR repo's pre-existing `:latest` tag
(the same image the old broken `vitana-oasis-operator` service runs) as
a placeholder so `create-service` doesn't fail on a missing image; the
first real dispatch of `AWS-PROD-DEPLOY-OASIS-OPERATOR.yml` builds and
ships the actual restored code under an `awsdr-<sha>` tag.

### Verdict at this point

Gateway (VTID-03398), the 3 backend bug-fixes (VTID-03408), the frontend
(VTID-03409), and oasis-operator (VTID-03410) now all have real AWS-DR
infrastructure and deploy pipelines. `oasis-projector`, `worker-runner`,
and `verification-engine` are functionally correct but still lack
VTID-03398-grade rigor (dedicated ALB rule, autoscaling, alarms,
dispatch-only CI, OIDC) of their own — they're bug-fixed, not yet built
out to the same standard as gateway. A full GCP→AWS cutover is closer
than it was, but still not a same-day undertaking.

---

## Addendum (2026-07-23 cont'd again): VTID-03411 harden the 3 backend services

Extends `oasis-projector`, `worker-runner`, and `verification-engine`
(fixed but not yet governed under VTID-03408) toward gateway-grade
rigor — **without** autoscaling or public ALB/DNS, both deliberately
excluded after review.

### Why no autoscaling

Read `services/oasis-projector/src/ledger-writer.ts`: the VTID Ledger
Writer has no cross-instance locking (no advisory lock, no `SKIP
LOCKED`, no leader election) — running N>1 replicas risks duplicate
event processing. CLAUDE.md's own hard governance rule, "Never run
parallel VTID executions," backs this up directly. `worker-runner`'s
claim-based design (`claimed_by`/`claim_expires_at`, atomic claims via
the gateway) is plausibly safe for N>1 but wasn't reviewed carefully
enough to act on that assumption here — kept at fixed `desiredCount`
alongside the other two rather than guessed into autoscaling.

### Why no public ALB/DNS

None of the three have any evidence of external HTTP callers (unlike
gateway/frontend/oasis-operator, which are all directly called by
browsers or each other over the public internet) — `worker-runner`
polls outward to the gateway, `oasis-projector` reconciles the DB in a
loop, `verification-engine` self-registers a heartbeat outward. Adding
public endpoints for services that don't need them would be
unjustified new attack surface.

### What was actually added

- **ECS-level container `healthCheck`** on all 3 task definitions.
  Before this, `aws ecs describe-tasks` reported `healthStatus: UNKNOWN`
  for all three — ECS Fargate does **not** automatically honor a Docker
  image's own `HEALTHCHECK` instruction (confirmed directly:
  `worker-runner`'s Dockerfile already has one, and it was still
  reporting `UNKNOWN`); an explicit `healthCheck` field on the task
  definition container is required regardless. Commands used per
  container's available tooling: `wget --spider` for the two
  node:20-alpine services (`oasis-projector` → `/ready`, which itself
  verifies the Aurora connection that VTID-03408 fixed; `worker-runner`
  → `/alive`), and a `python3 -c "import urllib.request; ..."`
  one-liner for `verification-engine` (`/health`) since its
  `python:3.11-slim` base has no curl/wget. All three now report
  `healthStatus: HEALTHY` after a forced redeploy.
- **3 new deploy workflows** — `AWS-PROD-DEPLOY-OASIS-PROJECTOR.yml`,
  `AWS-PROD-DEPLOY-WORKER-RUNNER.yml`,
  `AWS-PROD-DEPLOY-VERIFICATION-ENGINE.yml` —
  `workflow_dispatch`-only, required `reason`, never on push, reusing
  the VTID-03398 GitHub-OIDC deploy role (policy extended again to cover
  these 3 ECR repos + `ecs:ListTasks`/`ecs:DescribeTasks`, needed since
  there's no public URL to curl — verification reads the task's
  `healthStatus` directly via the AWS API instead).
- **9 CloudWatch alarms** (running-task-count-low, CPU-high,
  memory-high × 3 services).
- **Container Insights enabled on `Vitana-ECS-Cluster`** (cluster-wide)
  — it was off, which would have left the running-task-count alarms
  permanently starved of data (`ECS/ContainerInsights` namespace metrics
  don't exist without it). This benefits every service on the shared
  cluster, not just these three.

### Commands run

```bash
# Add ECS-level health check (per service, tool varies by base image):
# node:20-alpine -> wget --spider; python:3.11-slim -> python3 urllib
# (patch task def JSON, then:)
aws ecs register-task-definition --cli-input-json file://<patched>.json --region eu-central-1
aws ecs update-service --cluster Vitana-ECS-Cluster --service <service> \
  --task-definition <family>:<new-revision> --region eu-central-1

# Enable Container Insights
aws ecs update-cluster-settings --cluster Vitana-ECS-Cluster \
  --settings name=containerInsights,value=enabled --region eu-central-1

# Alarms (repeated per service, 3 alarms each)
aws cloudwatch put-metric-alarm --alarm-name <service>-running-count-low \
  --namespace ECS/ContainerInsights --metric-name RunningTaskCount \
  --dimensions Name=ClusterName,Value=Vitana-ECS-Cluster Name=ServiceName,Value=<service> \
  --statistic Minimum --period 300 --evaluation-periods 2 --threshold 1 \
  --comparison-operator LessThanThreshold --treat-missing-data breaching --region eu-central-1
```

## Addendum (2026-07-24): VTID-03412 cutover runbook + go/no-go checklist progress

`docs/AWS-CUTOVER-RUNBOOK.md` was added under VTID-03412 (see that doc for
the full go/no-go checklist, DNS repoint sequence, rollback plan, and open
decisions). While the DMS write-permission grant was pending (blocked on
`dms:StartReplicationTask` — the `claude-staging-validation` IAM user only
has DMS read access), the following checklist items were closed out with
permissions already available (`AmazonECS_FullAccess`,
`ElasticLoadBalancingFullAccess`, plus incidental CloudWatch/EventBridge
write access — see below):

### CloudWatch alarms for `community-app-awsdr` / `oasis-operator-awsdr`

Mirrored the existing `gateway-awsdr` 4-alarm set (cpu-high, memory-high,
target-5xx, unhealthy-hosts) exactly — same thresholds (CPU/memory >90%
for 3×5min periods, target 5xx >10 in 5×1min periods, any unhealthy host).
8 new alarms total, all confirmed created via `describe-alarms`.

```bash
# cpu-high / memory-high (per service)
aws cloudwatch put-metric-alarm --alarm-name vitana-<service>-cpu-high \
  --namespace AWS/ECS --metric-name CPUUtilization --statistic Average \
  --period 300 --evaluation-periods 3 --threshold 90 \
  --comparison-operator GreaterThanThreshold --treat-missing-data notBreaching \
  --dimensions Name=ClusterName,Value=Vitana-ECS-Cluster Name=ServiceName,Value=vitana-<service> \
  --region eu-central-1
# (memory-high identical, MetricName=MemoryUtilization)

# target-5xx / unhealthy-hosts (per service, needs the service's target group ARN)
aws cloudwatch put-metric-alarm --alarm-name vitana-<service>-target-5xx \
  --namespace AWS/ApplicationELB --metric-name HTTPCode_Target_5XX_Count --statistic Sum \
  --period 60 --evaluation-periods 5 --threshold 10 \
  --comparison-operator GreaterThanThreshold --treat-missing-data notBreaching \
  --dimensions Name=TargetGroup,Value=targetgroup/<tg-name>/<id> Name=LoadBalancer,Value=app/vitana-alb-prod/3d60b7c377e63d95 \
  --region eu-central-1
# (unhealthy-hosts identical, MetricName=UnHealthyHostCount, Statistic=Maximum, threshold=0)
```

### DMS failure alerting (`vitana-dms-task-failure` EventBridge rule)

`dms:CreateEventSubscription` (the DMS-native notification mechanism) was
tested and confirmed blocked by IAM — same wall as `StartReplicationTask`.
`events:PutRule`/`events:PutTargets` were **not** blocked, so alerting was
built via EventBridge instead: AWS DMS emits events to the default event
bus under `source: "aws.dms"` without needing any DMS-side subscription
API call. Rule pattern deliberately left broad (source-only, no
`detail-type` filter) since the exact DMS EventBridge detail-type schema
wasn't confirmed against a live event — better to over-notify than miss a
future failure the way `vitana-autopilot-cdc`'s ~26h silent gap happened.

```bash
aws events put-rule --name vitana-dms-task-failure \
  --event-pattern '{"source":["aws.dms"]}' --state ENABLED --region eu-central-1
aws events put-targets --rule vitana-dms-task-failure \
  --targets '[{"Id":"vitana-alarms-sns","Arn":"arn:aws:sns:eu-central-1:472838866351:vitana-alarms-prod"}]' \
  --region eu-central-1
```

**Important caveat found while wiring this up, not yet resolved:** the
`vitana-alarms-prod` SNS topic — the one target for all 47 CloudWatch
alarms in the account plus this new rule — has **zero subscribers**
(confirmed via `aws sns list-subscriptions-by-topic`). `sns:Subscribe`/
`sns:AddPermission` are also blocked for this IAM user. Every alarm in
the account is currently inert: they'll transition state correctly but
nothing receives a notification. This needs an explicit decision from
the user on where alerts should actually go (email/Slack/PagerDuty) —
not something to invent or guess an endpoint for. Tracked as its own
go/no-go checklist item in `docs/AWS-CUTOVER-RUNBOOK.md` §2.

### `worker-runner` N>1 safety review

Reviewed the actual claim mechanism end-to-end (not just the service's
own code): `services/worker-runner/src/services/runner-service.ts`
`doPoll()` never processes more than one VTID per instance; the claim
itself goes through the gateway's `POST /api/v1/worker/orchestrator/
tasks/:vtid/claim` → `claim_vtid_task` RPC (`supabase/migrations/
20260413000000_fix_claim_accepts_scheduled.sql`), which does
`SELECT ... FOR UPDATE` + a conditional `UPDATE`, all inside one Postgres
transaction — a genuine server-side compare-and-swap, not a client-side
read-then-write race. **Verdict: CONDITIONALLY SAFE for N>1.** The one
real risk unique to N>1: an idle sibling instance will legitimately
re-claim a VTID whose 60-minute claim lease expired because the active
instance's heartbeats failed for that long, causing double execution —
acceptable if heartbeats reliably survive transient network hiccups.

**Autoscaling was NOT enabled based on this finding** — reviewing safety
and acting on it are kept as separate decisions; enabling autoscaling
changes live production behavior and wasn't asked for.

### Still blocked, unchanged

`vitana-autopilot-cdc`'s `FATAL_ERROR` state itself is untouched — root
cause diagnosed (full load completed cleanly, 17/18 CDC updates applied,
one record's UPDATE apply kept failing until the task exhausted 9 recovery
attempts) but the actual fix (`dms:StartReplicationTask` with
`resume-processing`, falling back to a clean restart if that hits the
same record again) is still blocked on the same IAM grant.

### ALB target-group tagging (same day, follow-up)

Tagged (not renamed) `vitana-tg-gateway-prod` and `vitana-tg-community-prod`
to reduce the confusion risk flagged in the pre-existing-state section
above:

```bash
aws elbv2 add-tags --resource-arns <tg-arn> \
  --tags Key=ActualEnvironment,Value=staging \
         Key=NamingWarning,Value="tag-added-2026-07-24-name-says-prod-but-currently-serves-AWS-staging-traffic-verify-via-admin-health-env-field" \
         Key=Vtid,Value=VTID-03412 \
  --region eu-central-1
```

Renaming was deliberately not attempted — target group names are
immutable in AWS; a real rename means creating a new target group,
registering the same targets, and swapping the ALB listener rule to
point at it, which risks a brief traffic blip on a resource actively
serving staging traffic. Not worth the risk for a naming-only fix
without asking first.

**New finding while doing this:** `describe-tags` on both target groups
showed pre-existing tags `ManagedBy=terraform`, `Environment=prod`,
`Phase=5-compute` — this is not an ad-hoc leftover, it's part of some
Terraform-managed stack. `find . -iname "*.tf"` across `vitana-platform`
only turns up `infra/livekit/*.tf` — nothing matching this ALB/target-group
setup. Whatever Terraform project actually owns this infrastructure is
not in this repo. A real fix (rename, or understanding why a
`Environment=prod`-tagged, Terraform-managed target group serves staging
traffic) should go through that IaC, not further hand-edits via aws-cli.

### `vitana-autopilot-cdc` DMS task fixed (same day, after IAM grant)

The user attached a scoped temporary inline policy
(`vitana-dms-autopilot-fix-temp`, `dms:StartReplicationTask`/
`StopReplicationTask` on the specific task ARN only) to
`claude-staging-validation`, unblocking the fix diagnosed earlier the
same day (§ above, "Root cause diagnosed").

```bash
aws dms start-replication-task \
  --replication-task-arn arn:aws:dms:eu-central-1:472838866351:task:PASTVC7U6BBWJPD4YFTFDRLNCU \
  --start-replication-task-type resume-processing --region eu-central-1
```

`resume-processing` reached `running` briefly (~60s) then failed again —
**a different error than before**: `An internal WAL conversational
protocol error has occurred`, not the original "Postgres apply or data
error." Given the task's `RecoveryCheckpoint` dated back to 2026-07-22
(the task had been dead ~2 days) and this same task had a prior "Slot
does not exist" failure in its history (see the original diagnosis
above), the working theory is the checkpoint's LSN position was no
longer valid against the source's current replication slot state.

Fell back to the documented plan: a clean restart, accepting loss of the
one specific historical row update in exchange for restored currency.

```bash
aws dms start-replication-task \
  --replication-task-arn arn:aws:dms:eu-central-1:472838866351:task:PASTVC7U6BBWJPD4YFTFDRLNCU \
  --start-replication-task-type start-replication --region eu-central-1
```

Confirmed stable: `status=running`, zero new failure events, for 5+
minutes post-restart (`aws dms describe-events --start-time
<restart-timestamp>` returning only the "started" state-change event, no
"failed" events). `aws dms describe-table-statistics` showed a fresh
full-load pass completing cleanly (`TableState: Table completed`) as
part of the restart. Both `vitana-autopilot-cdc` and
`vitana-supabase-to-aurora` confirmed `running` with `LastFailureMessage:
null`.

**Residual gap, accepted not fixed:** the specific UPDATE that was stuck
at the time of the original 2026-07-22 failure never replicated — CDC
capture restarted from "now," not from the old position. This is a
one-row historical drift on a DR replica, not an ongoing sync gap.

Attempted to self-remove `vitana-dms-autopilot-fix-temp` after the fix
(`iam:DeleteUserPolicy`) — blocked, same as the earlier
`vitana-awsdr-oidc-setup-temp` self-revoke attempt. Both temporary
policies are still attached to `claude-staging-validation` pending
manual removal by an operator with IAM write access.

## Addendum (2026-07-26): VTID-03413 AWS alerting → Google Chat

The user directed that AWS alerts should reuse the Google Chat channel
already working for health checks, rather than a new channel.
Investigating that surfaced the alerting chain was inert in **two**
independent places, not one.

### Finding 1: 21 of 47 alarms had no `AlarmActions` at all

The SNS-topic-has-no-subscriber gap recorded in the previous addendum
was only half the problem. `describe-alarms` showed 26/47 alarms wired
to `vitana-alarms-prod` and **21 wired to nothing** — including every
alarm created earlier this same session (all 4 `gateway-awsdr` alarms
from VTID-03398, all 8 added for `community-app-awsdr`/
`oasis-operator-awsdr`, and all 9 from the VTID-03411 hardening pass).
They would evaluate and transition state correctly while notifying
nobody, forever. This was my own omission across three prior VTIDs:
`put-metric-alarm` silently accepts an alarm with no actions.

Fixed by re-issuing each alarm's definition with `AlarmActions` +
`OKActions` → `vitana-alarms-prod` (read each alarm, re-`put` it with
actions added, preserving all thresholds/dimensions). Verified:

```bash
aws cloudwatch describe-alarms --alarm-name-prefix vitana- \
  --query "MetricAlarms[?length(AlarmActions)==\`0\`].AlarmName" \
  --region eu-central-1
# → []   (was 21 names)
```

### Finding 2: the Google Chat webhook secrets are empty shells

`vitana/google-chat/webhook-url` and `vitana/google-chat/webhook-url-2`
both exist as secret **names** with `list-secret-version-ids` returning
`"Versions": []` — no value was ever stored in either. Almost certainly
placeholders from the same 2026-07-09 bulk-provisioning event that
created the ~22 unexplained ECS services.

**This caused a real (contained) incident.** Wiring
`GCHAT_COMMANDHUB_WEBHOOK` → that secret and rolling
`vitana-gateway-awsdr` to the new task-def revision `:3` made every new
task fail to start:

```
ResourceInitializationError: unable to pull secrets or registry auth:
  … failed to fetch secret …vitana/google-chat/webhook-url-rYPXY8 …
  ResourceNotFoundException: Secrets Manager can't find the specified
  secret value for staging label: AWSCURRENT.
```

ECS retried placement in a loop for ~4 minutes. **No request-path
impact** — ECS correctly kept the healthy `:2` task serving the whole
time, and `dr-gateway.vitanaland.com/alive` never stopped returning
200. Rolled back with `update-service --task-definition
vitana-gateway-awsdr:2`; confirmed `runningCount=1` on `:2` and the
`:3` deployment `DRAINING`.

**Lesson, worth generalizing:** referencing a Secrets Manager secret
that exists-by-name but has no version is indistinguishable from a
correct reference at `register-task-definition` time — it only fails at
task placement. Before adding any `secrets` entry to a task definition,
check `list-secret-version-ids`, not just `describe-secret`.

Task-def revision `:3` remains registered but unused. **Do not deploy
it** until the secret holds a real value.

### What shipped vs. what's still blocked

Shipped (this VTID): the `POST /api/v1/aws-alerts/sns` route
(SNS-signature-verified, host-allowlisted cert fetch, handles
CloudWatch-alarm and EventBridge payload shapes), its `express.text()`
body-parser exception, and the 21 alarm-action fixes. The route
degrades to a logged no-op when `GCHAT_COMMANDHUB_WEBHOOK` is unset
(existing `notifyGChat()` behavior), so shipping it while the secret is
still empty is safe.

Still blocked on an operator, both recorded as go/no-go checklist items:

1. **The actual Chat webhook URL** — needs storing as a version on
   `vitana/google-chat/webhook-url`, then re-applying the task-def
   change that was rolled back.
2. **The SNS subscription itself** — `sns:Subscribe` is denied for this
   session's IAM user, so nothing is subscribed to `vitana-alarms-prod`
   yet. Until both are done the alerting chain is still end-to-end
   inert, regardless of this VTID's code being live.

### Finding 3: `vitana-orb-agent` is ECS-`HEALTHY` and functionally inert

Scoping the "build orb-agent parity" instruction turned up that an ECS
service **already exists** — `vitana-orb-agent`, task def rev 10,
`ACTIVE`, `runningCount=1`, `healthStatus: HEALTHY`. It is one of the
~22 never-investigated services from the 2026-07-09 bulk-provisioning
event, and it is a **false-green**: the logs show it never starts its
actual worker.

```
{"event": "orb_agent.boot", "livekit_url": "wss://maxina-...livekit.cloud"}
INFO:src.orb_agent.registry_client:registry_heartbeat.disabled
  — GATEWAY_SERVICE_TOKEN not set
{"event": "orb_agent.ready_health_only"}
```

`orb_agent.ready_health_only` is the tell — `AGENT_ENABLE_WORKER` is
absent from the AWS task definition, so the LiveKit worker subprocess
never launches; only the FastAPI health endpoint runs. ECS health
checks `/alive`, gets a 200, and reports the service healthy.

Config gap vs. `DEPLOY-ORB-AGENT.yml`: missing `AGENT_ENABLE_WORKER`,
`GATEWAY_SERVICE_TOKEN`, `GOOGLE_CLOUD_PROJECT`, `VERTEX_AI_LOCATION`,
`ORB_AGENT_TEXT_ONLY`, `AGENT_LOG_LEVEL`; carries an
`http://gateway.vitanaland.com` scheme bug (same class as VTID-03408's
worker-runner/verification-engine fixes); and additionally carries
`DB_HOST`/`DB_READER_HOST`/`REDIS_HOST`/`SUPABASE_*` that GCP's
deployment doesn't pass at all. The LiveKit secrets *are* real
(`list-secret-version-ids` shows versions on all three, unlike the
Google Chat secrets in Finding 2).

**Not fixed in this VTID** — deliberately. Completing it needs a
decision this session can't make: orb-agent's LLM path is Vertex AI,
and there is no provision in the task definition for GCP credentials
from AWS Fargate. Setting `AGENT_ENABLE_WORKER=1` without solving that
would turn a quietly-inert service into a loudly-failing one, which is
worse during a cutover window. Recorded in
`docs/AWS-CUTOVER-RUNBOOK.md` §4.2 with the open question.

**The transferable lesson** (now a go/no-go checklist item): ECS
`healthStatus: HEALTHY` means the container's health command exited 0
— nothing more. Every service needs a probe that proves it is doing
its job before "AWS is healthy" can be claimed at cutover.

## Addendum (2026-07-26): functional-probe script + what it immediately found

Added `scripts/aws/verify-aws-production.sh` — asserts on *behaviour*
rather than liveness, because ECS `healthStatus: HEALTHY` had already
proven misleading (the orb-agent false-green above). It probes each
service for evidence it is doing its job, checks both DMS tasks, and
checks that no alarm is firing *and* that none is action-less.

Running it immediately produced three results worth recording.

### It found a real, currently-broken service: oasis-projector

`oasis-projector` connects to Aurora fine (`Database connected` is
present) but its ledger-writer loop is failing repeatedly — **40
occurrences** of:

```
PostgresError { code: "42P10", message: "there is no unique or exclusion
constraint matching the ON CONFLICT specification" }
  on prisma.projectionOffset.upsert()
```

`prisma/schema.prisma:92` declares `projectorName String @unique @map("projector_name")`
on `@@map("projection_offsets")`, so the upsert emits
`ON CONFLICT (projector_name)` — **and Aurora's copy of that table has
no such unique constraint.**

Likely root cause: the DMS task runs with `TargetTablePrepMode:
DO_NOTHING` (visible in the task settings), so DMS never created or
prepared the target schema — it replicates rows into pre-existing
tables. Whatever created the Aurora schema did not carry over all
unique constraints. **DMS replicating data is not the same as Aurora
being schema-equivalent**, and nothing in the earlier "495/495 tables
under live CDC" check would have caught this: row counts can be
perfect while constraints are absent.

Scope note, to avoid over-stating it: Supabase is an independent SaaS
and is **not** affected by turning GCP off, so it remains the primary
datastore through a cutover. Today the main Aurora writer is
`oasis-projector`. But a schema-parity audit (constraints/indexes, not
just tables and row counts) should be run before anything else is
pointed at Aurora — the codebase has ~126 Prisma `.upsert()` calls,
every one of which needs its matching unique constraint to exist.

### It found the DMS fix from earlier today did not hold

`vitana-autopilot-cdc` is `failed` again. It was restarted earlier
today and verified `running` with zero failure events across 5+
minutes — that verification was accurate at the time but too short to
call the underlying problem solved. Treat the earlier "fixed" as
"restarted", not "root-caused": the failure recurs.

### It had a bug of its own, worth writing down

The first run reported three false failures (`oasis-projector` DB
connection, `worker-runner` registration, `verification-engine`
heartbeat). All three services were in fact working — the probe helper
called `aws logs get-log-events` without `--start-from-head`, which
reads backward from the tail and reliably returns an empty first page.
Fixed. The lesson generalises: a verification script that has never
been run against a known-good system cannot distinguish its own bugs
from real failures, which is why this one was run before being
committed rather than after.

## Addendum (2026-07-26, later): Aurora constraint drift FIXED

Both failures in the previous addendum are resolved, and the underlying
drift turned out to be far larger than the two constraints they exposed.

### Reaching Aurora at all

Aurora is not publicly accessible (`PubliclyAccessible: false` on both
instances). Routes tried and rejected:

- **RDS Data API** — `HttpEndpoint: true` on the cluster, but
  `claude-staging-validation` lacks `rds-data:ExecuteStatement`.
- **ECS Exec** — enabled on `vitana-worker-runner`, but its running task
  predates the setting so it has no SSM sidecar
  (`TargetNotConnectedException`). Restarting a healthy service purely to
  obtain a shell wasn't justified.

Route used: a **one-off Fargate task** running
`public.ecr.aws/docker/library/postgres:17-alpine`, in the same
subnets/SG as `oasis-projector` (proven to reach Aurora), with
`DATABASE_URL` injected from `vitana/aurora/prod/database-url` by the
**execution role** — which sidesteps this session's own
`GetSecretValue` denial, since ECS resolves the secret, not the caller.
Task defs `vitana-schema-parity-*`, logs in `/vitana/schema-parity`.

### What the first run found

```
BEFORE:  primary_keys | unique_constraints
              495     |         0
```

**Aurora had ZERO unique constraints** — not a few missing, none at all,
against Supabase's 162. And `autopilot_recommendations` had **no primary
key**, which is precisely why DMS could not apply UPDATEs to it: DMS
matches rows by the *target's* PK. The INSERT-only full load succeeded
and every subsequent update failed, exactly the observed
17/18-then-dead pattern.

Duplicate-row pre-checks returned zero for both target columns, so
nothing was coerced to make the constraints fit.

### The sweep

660 statements (498 PK + 162 UNIQUE, 69 KB) generated from Supabase —
too large for one task definition (64 KiB limit), so split into four
batches, PKs first since CDC needs the target PK before uniques matter.
Run with `ON_ERROR_STOP=0`: "already exists" / "multiple primary keys
not allowed" is the *expected* outcome for the ~496 Aurora already had,
and must not abort the rest.

```
AFTER:   primary_keys | unique_constraints
              496     |        162          <- matches Supabase exactly
```

Remaining tables with no PK are only DMS's own control tables
(`awsdms_apply_exceptions`, `awsdms_status`, `awsdms_suspended_tables`),
which legitimately have none. **No application table is missing a
primary key.** Aurora reports 499 base tables vs Supabase's 498
PK-bearing tables — a small table-level delta worth a separate look, but
not a constraint gap.

### Outcome

- `vitana-autopilot-cdc`: restarted with `start-replication` once the PK
  existed, and has stayed `running` with zero failure events since.
  The same restart method died after 90 seconds earlier the same day
  against a PK-less table — that contrast is the evidence the root cause
  was correct, not just that a restart happened to stick.
- `oasis-projector`: its `42P10` is now fixable, but the service stays at
  `desiredCount=0` **on purpose**. `projection_offsets` is inside the
  DMS replication set, so restarting the projector makes it a second
  writer to a table CDC also writes from Supabase. That is an ownership
  decision (projector uses Supabase, or the table leaves the DMS set),
  not something a constraint fixes.

### Caveat on scope

This reconciled PRIMARY KEY and UNIQUE constraints only. Foreign keys,
check constraints, non-unique indexes, defaults, column types and RLS
were **not** compared and may also have drifted — the same
`TargetTablePrepMode: DO_NOTHING` that dropped uniques would have
dropped those too. Do not read "162/162 uniques" as full schema
equivalence.

## Addendum (2026-07-27 ~15:30 UTC): concurrent DMS surgery by the migration team — observed state

While the VTID-03419 post-cutover watch ran, a second operator (the
migration team, evidently acting on the status report) performed DMS
surgery. Observed read-only, deliberately not touched from this session
— two operators on one replication stack is how a third incident gets
made. State as found:

- `vitana-supabase-to-aurora` **stopped** deliberately at 15:02:53Z
  (`Stop Reason NORMAL`) and **not yet resumed** → all-tables CDC is
  currently OFF; Aurora drifts from 15:02 onward until someone runs
  `resume-processing` (checkpoint is fresh; a resume is clean).
- New one-off task `vitana-reload-39-tables` (full-load, 15:03→15:05):
  **38/39 tables reloaded successfully** — this is the fix for the
  ~154k-dropped-applies divergence. 
- The 1 errored table is — fittingly — `autopilot_recommendations`:
  the reload TRUNCATEd it then failed to load, leaving it **EMPTY on
  Aurora (0 rows vs 3,933 in Supabase)**. Schema survived intact
  (PK + all 162 zone uniques verified post-reload).
- `vitana-autopilot-cdc` was **deleted**. Combined with the main task's
  mapping still EXCLUDING this table and the failed reload, the table
  now has **no sync path at all**.

Needed from whoever owns the surgery (this session's IAM was scoped to
the now-deleted task's ARN, so it cannot act):
1. `resume-processing` on `vitana-supabase-to-aurora`.
2. For `autopilot_recommendations`: remove the exclude rule from the
   main task's table mapping (the PK that motivated the split now
   exists) and reload that one table — or re-run the one-off reload
   for it. Until then it sits empty on Aurora.

---

## Addendum (2026-07-28): VTID-03420 activation — missing GITHUB_SAFE_MERGE_TOKEN on AWS gateway

After merging VTID-03420 (AWS staging→prod publish parity) and setting
`PUBLISH_TARGET_CLOUD=aws` on `vitana-gateway-awsdr`, the first live
PUBLISH click from the Command Hub failed:

```
Failed: GITHUB_SAFE_MERGE_TOKEN environment variable is not set
```

Root cause: `triggerWorkflow()` (`github-service.ts`) reads
`process.env.GITHUB_SAFE_MERGE_TOKEN` when no per-call token override is
given, and the new `publishAwsFlow()` path dispatches
`AWS-PROD-DEPLOY-GATEWAY.yml` without one. This is not a regression in
the new code — it's the **first** code path where the AWS-hosted gateway
container itself calls the GitHub API (every prior AWS workflow dispatch
in this build was done manually via the session's own PAT, or from the
GCP gateway, which has this var set). The AWS gateway task definition
had never needed a GitHub token before.

Found an existing, already-populated secret —
`vitana/github/token` (created 2026-07-16, `LastAccessedDate` present —
confirmed non-empty via `list-secret-version-ids` per the diagnostic
this document already established after the earlier empty-Google-Chat-
secret incident, since `claude-staging-validation` cannot
`GetSecretValue` on `vitana/*` directly) — and bound it:

- `vitana-gateway-awsdr:9` — added `GITHUB_SAFE_MERGE_TOKEN` as a
  `secrets` entry (`valueFrom` the full secret ARN), preserving all 6
  existing secrets and all 29 env vars. Rolled the service; watched the
  deployment via `describe-services` events end-to-end (new task started
  → registered in target group → old task drained/stopped → single
  deployment COMPLETED, zero `failedTasks`, no
  `ResourceInitializationError`). Post-rollout `/alive` (200),
  `/api/v1/admin/health` (`env=production`), and `/api/v1/admin/build-info`
  (still `b1ce82c`) all re-verified.

**Full VTID-03420 activation sequence, end to end:**
1. Waited for AWS staging (`vitana-gateway`) to auto-deploy the merged
   PR and converge (staging briefly served two commits mid-rollout —
   normal ECS rolling-deploy behavior, confirmed by polling until 6/6
   consecutive reads agreed).
2. Dispatched `AWS-PROD-DEPLOY-GATEWAY.yml` with
   `deploy_mode=promote-staging`, `expected_commit` pinned to the merge
   commit — succeeded, simultaneously closing the pre-existing
   staging/prod drift (`0c72cfc`/`53cfb71`) and shipping the new publish
   code itself to prod.
3. Registered `vitana-gateway-awsdr:8` adding `PUBLISH_TARGET_CLOUD=aws`
   (one env var, verified 28→29, all secrets preserved) — rolled clean.
4. First live PUBLISH click surfaced the missing-token gap above;
   registered `:9` adding the token secret — rolled clean, verified.

**Confirmed durable** (2026-07-29 safety-net check-in): by the next day
`vitana-gateway-awsdr` had progressed to task-def revision **14** — i.e.
at least one successful PUBLISH click landed after `:9` shipped, and the
promotion path has been used routinely since without falling back to
manual dispatch. Revision 14 carries forward both `PUBLISH_TARGET_CLOUD=aws`
and the `GITHUB_SAFE_MERGE_TOKEN` secret binding, service stable
(rollout `COMPLETED`, 1/1, zero failed tasks). Prod (`a8e770c…`, itself
already 2 merges past the `b1ce82c` this addendum started from) trails
staging (`0b9191c…`) by 3 further merges — the expected shape of
staging-ahead-of-prod, not drift.
