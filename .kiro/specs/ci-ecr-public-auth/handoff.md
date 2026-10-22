---
slug: ci-ecr-public-auth
author: kiro
author_seat: hotmail
executor: claude
next_actor: kiro
state: approved
updated: 2026-10-22T08:07Z
sparring_record: .kiro/specs/ci-ecr-public-auth/sparring/verdict.md
vtids: [VTID-05328, VTID-05329]
---
# Handoff — ci-ecr-public-auth
Planner: Kiro seat `hotmail` (session kiro-hotmail-202610220740-e0de). Plan: `plan.md` (between the plan
markers), sparred by PLAN-SPAR. `requirements.md`, `design.md` and `tasks.md` carry the detail.

Lanes (held at `ready` until PLAN-SPAR allocates each lane's VTID). Both are `executor: claude` because they
change `.github/**`, and they go to the exceptions seat `exafyltd` while Claude is unavailable (collaboration §7):
- `platform-ecr-public-login` (vitana-platform): ECR Public login step in `AWS-STAGE-DEPLOY-GATEWAY.yml`,
  `AWS-PROD-DEPLOY-GATEWAY.yml`, `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml` and `AWS-STAGE-DEPLOY-KIRO-RUNNER.yml`.
  Adds a Jest workflow guard, the IAM policy file and a read-only IAM check script.
- `v1-ecr-public-login` (vitana-v1): the same step in `AWS-STAGE-DEPLOY-FRONTEND.yml` and
  `AWS-PROD-DEPLOY-FRONTEND.yml`, plus a Vitest workflow guard.

## Log
### 2026-10-22T08:00Z · kiro-hotmail-202610220740-e0de · created → drafted
Plan drafted from a read-only investigation of the `public.ecr.aws` 429 failures: platform run 39421081117
(gateway staging deploy, `node:20-alpine`, 2026-10-20) and v1 run 39681916225 (frontend staging deploy, attempt 1: `node` and `nginx`). All of them show
`toomanyrequests: Data limit exceeded`, the 500 GB/month unauthenticated cap.
Premises are checked against vitana-platform `origin/main` @ `5f76b3ab2` and vitana-v1 `origin/main` @ `7dfee6877`
(file:line in `plan.md`). IAM: the deploy identities most likely lack `sts:GetServiceBearerToken` (staging user) and
both `ecr-public:GetAuthorizationToken` + `sts:GetServiceBearerToken` (prod OIDC role). This comes from the
documented policies, not a live check, because the session had no AWS credentials. The login step is fail-soft, so
the workflow lanes can merge before the IAM change is applied.

**For the owner / an IAM admin, after the platform lane merges:** run
`bash scripts/aws/iam/ci-ecr-public-pull-iam-check.sh` in CloudShell (read-only), then the `put-user-policy` /
`put-role-policy` commands it prints. That is a live IAM write. No Kiro or CI session does it (§7a).
Protected gate files in scope: `.github/workflows/AWS-PROD-*.yml` in both repos (§3a). Those hunks need a legacy
Claude review or the owner's instruction before merge.

### 2026-10-22T08:07Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 2 lane(s) got a VTID and are handed to Kiro.
