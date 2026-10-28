# Requirements — ci-ecr-public-auth
Authoritative plan: `plan.md` (between the plan markers). This file adds acceptance criteria only.

## R1 — authenticated base-image pulls
WHEN a deploy job builds a Dockerfile with a `FROM public.ecr.aws/...` line (plan premise 2 table),
THEN a step runs `aws ecr-public get-login-password --region us-east-1 | docker login --username AWS
--password-stdin public.ecr.aws` before the first `docker build` of that job, after its
`configure-aws-credentials` step.

## R2 — fail-soft, loud
WHEN that login fails for any reason (missing IAM permission, us-east-1 outage, no credentials),
THEN the step still succeeds and emits a `::warning` annotation plus a `$GITHUB_STEP_SUMMARY` line, and the
build pulls anonymously as it does today. WHEN it succeeds, THEN the log has the line
`ecr-public-login: authenticated`. The password is never printed.

## R3 — no secrets on PR builds
The kiro-runner `build` job runs on `pull_request`. It gets AWS credentials and the login step only when
`github.event_name != 'pull_request'`.

## R4 — guard
A test in each repo fails when any `AWS-*-DEPLOY-*.yml` job that builds a `public.ecr.aws` Dockerfile lacks the
login step, has it after the first `docker build`, or lacks the fail-soft branch. It is red on `origin/main` and
green on the lane head.

## R5 — IAM as a reviewed file, never a live edit
`scripts/aws/iam/ci-ecr-public-pull-policy.json` grants exactly `ecr-public:GetAuthorizationToken` and
`sts:GetServiceBearerToken` (conditioned on `sts:AWSServiceName = ecr-public.amazonaws.com`).
`scripts/aws/iam/ci-ecr-public-pull-iam-check.sh` only reads (`sts get-caller-identity`,
`iam simulate-principal-policy`) and prints the apply commands. No session applies them.

## R6 — staging proof
After merge, the next `AWS-STAGE-DEPLOY-GATEWAY.yml` (platform) and `AWS-STAGE-DEPLOY-FRONTEND.yml` (v1) run for the
merge commit succeeds, and STAGING-VERIFY passes each lane's read-only `docs/validation/<VTID>/staging-tests.json`.
