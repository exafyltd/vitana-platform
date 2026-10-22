---
change_class: standard
---
# plan(ci-ecr-public-auth): authenticate public.ecr.aws pulls in stage/prod image builds
<!-- plan:begin -->
## Problem
Since VTID-05017 (2026-10-09) every image we build from our own Dockerfiles takes its base image from
`public.ecr.aws/docker/library/*`, and it pulls **anonymously**. VTID-05017 deferred authenticated pulls on purpose
(`docs/validation/VTID-05017/plan-sparring.md:29-30`: "needs IAM changes on the OIDC role"). Anonymous ECR Public
pulls have a 500 GB/month data cap and 1 pull/s. GitHub-hosted runners share source IPs, so the cap now trips
the same way Docker Hub's did. Read from the run logs (`gh run view --attempt 1 --log-failed`):
- `exafyltd/vitana-platform` run 39421081117 (AWS Stage Deploy Gateway, `3063c9543`, 2026-10-20), attempt 1, at
  `docker build`: `GET https://public.ecr.aws/v2/docker/library/node/manifests/sha256:fb4cd12c…: 429 Too Many
  Requests` / `toomanyrequests: Data limit exceeded`. Attempt 2 (re-run) succeeded.
- `exafyltd/vitana-v1` run 39681916225 (AWS Stage Deploy Community App, `aa3fb55f2`, 2026-10-21), attempt 1,
  at `Build and push image`: the same 429 `Data limit exceeded` twice, once for `node` (`sha256:fb4cd12c…`) and once
  for `nginx` (`sha256:516475cc…`). Attempt 2 got past the build and failed later at `Trigger STAGING-VERIFY`
  (`PLATFORM_DISPATCH_TOKEN not set`), which is a separate issue and out of scope.

The AWS ECR Public docs (registry authentication, service quotas) say an authenticated pull uses a token from
`aws ecr-public get-login-password --region us-east-1` (ECR Public auth exists only in `us-east-1`). Authenticated
pulls are not subject to the unauthenticated data cap, and they get 10 pulls/s per account instead of 1 per IP.
Beyond the free tier, their data transfer bills to the account. No new infrastructure is needed: every affected
job already has AWS credentials.

## Premises (checked read-only against `origin/main`: vitana-platform `5f76b3ab2`, vitana-v1 `7dfee6877`)
1. **Dockerfiles that pull `public.ecr.aws`** (`git grep public.ecr.aws -- '*Dockerfile*'`):
   - platform `services/gateway/Dockerfile:1,12` (`node:20-alpine`)
   - platform `services/gateway/Dockerfile.job:22,33` (`node:20-alpine`)
   - platform `services/gateway/Dockerfile.auto-logger:1,15` (`node:20-alpine`; no workflow builds it)
   - platform `services/kiro-runner/Dockerfile:10,18,29` (`node:20-bookworm-slim`)
   - v1 `Dockerfile:7` (`node:20-alpine`), `Dockerfile:20` (`nginx:1.25-alpine`)
   Every other platform Dockerfile (oasis-operator, oasis-projector, orb-agent, vitana-orchestrator, erp-bridge,
   postgrest-aurora-proxy, realtime-aurora, mcp-gateway, vaea, openclaw-bridge, memory-indexer, root `Dockerfile`)
   still pulls Docker Hub. Out of scope here (see below).
2. **Build jobs that `docker build` one of those Dockerfiles.** Each already runs
   `aws-actions/configure-aws-credentials@v4` and `aws-actions/amazon-ecr-login@v2` (private ECR, eu-central-1)
   before the build, except the kiro-runner `build` job:

   | Repo | Workflow : job | configure-aws-credentials | private ECR login | build step / `docker build` | Identity |
   |---|---|---|---|---|---|
   | platform | `AWS-STAGE-DEPLOY-GATEWAY.yml` : `build-push-deploy` | `:202-207` | `:209-211` | `:228` / `:235` | static keys `AWS_STAGING_ACCESS_KEY_ID` |
   | platform | `AWS-PROD-DEPLOY-GATEWAY.yml` : `build-push-deploy` | `:329-333` | `:335-337` | `:450` (rebuild-main only, `if:` `:452`) / `:458` | OIDC `AWS_PROD_ROLE_ARN` |
   | platform | `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml` : `build-push-register` | `:118-122` | `:124-126` | `:141` / `:152` (`Dockerfile.job`) | OIDC `AWS_PROD_ROLE_ARN` |
   | platform | `AWS-STAGE-DEPLOY-KIRO-RUNNER.yml` : `build` | none | none | `:78` / `:79` | none (runs on `pull_request` too, `:29`) |
   | platform | `AWS-STAGE-DEPLOY-KIRO-RUNNER.yml` : `build-push-deploy` | `:103-108` | `:110-112` | `:132` / `:139` | static keys `AWS_STAGING_ACCESS_KEY_ID` |
   | v1 | `AWS-STAGE-DEPLOY-FRONTEND.yml` : `build-push-deploy` | `:147-152` | `:154-156` | `:176` / `:184` | static keys `AWS_STAGING_ACCESS_KEY_ID` |
   | v1 | `AWS-PROD-DEPLOY-FRONTEND.yml` : `build-push-deploy` | `:169-174` | `:176-178` | `:218` / `:244` | static keys `AWS_STAGING_ACCESS_KEY_ID` |

   No other workflow in either repo runs `docker build` or `docker/build-push-action` on these Dockerfiles. The
   other `docker build` calls (`AWS-PROD-DEPLOY-OASIS-OPERATOR.yml:148`, `-OASIS-PROJECTOR.yml:142`,
   `-ORB-AGENT.yml:144`, `-POSTGREST-AURORA-PROXY.yml:210`, `-REALTIME-AURORA.yml:391`,
   `-VERIFICATION-ENGINE.yml:140`, `AWS-STAGE-DEPLOY-ERP-BRIDGE.yml:130`, `AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml:127`)
   build Docker Hub-based Dockerfiles.
3. **Identities.**
   - `AWS_STAGING_ACCESS_KEY_ID` is the IAM user `claude-staging-validation` (`docs/AWS-PRODUCTION-HANDOVER.md:94-96`,
     `docs/AWS-PRODUCTION-BUILD-LOG.md:163-166,323-325`). Its documented policies are `AmazonECS_FullAccess`,
     `AmazonEC2ContainerRegistryFullAccess`, `ElasticLoadBalancingFullAccess` and `ReadOnlyAccess`.
     AWS's `ReadOnlyAccess` contains `ecr-public:GetAuthorizationToken`, but not `sts:GetServiceBearerToken`.
     `AmazonEC2ContainerRegistryFullAccess` covers `ecr:*` (private ECR only). So the user most likely **lacks
     `sts:GetServiceBearerToken`**.
   - `AWS_PROD_ROLE_ARN` is the role `vitana-gateway-awsdr-deploy-role` (`docs/AWS-PRODUCTION-BUILD-LOG.md:203,229`,
     `scripts/aws/setup-code-index-bucket.sh:41`). Its documented inline policies
     (`docs/AWS-PRODUCTION-BUILD-LOG.md:208-221`, `scripts/aws/iam/vtid-05023-deploy-role-policy.json:115-120`
     `EcrAuth`) grant only private `ecr:GetAuthorizationToken`. So the role most likely **lacks both
     `ecr-public:GetAuthorizationToken` and `sts:GetServiceBearerToken`**.
   - `aws ecr-public get-login-password` needs both actions (AWS managed policy
     `AmazonElasticContainerRegistryPublicReadOnly` grants exactly these two for login).
   - Not verified live: this session has no AWS credentials, so no `simulate-principal-policy` was run. Lane
     `platform-ecr-public-login` ships a read-only check script that answers it (item 3).
4. **Service containers are a separate problem.** `PR-GATE.yml:36` and `SQL-CALENDAR-ENTRY-SHARE.yml:28`,
   `SQL-EVENT-SHARE-POSTS.yml:27`, `SQL-GROUP-PARTICIPANTS.yml:26`, `SQL-THREAD-JOIN-HARDENING.yml:27` use
   `public.ecr.aws/docker/library/postgres:16` as a job `services:` image. The runner pulls it before any step
   runs, so a login step cannot reach it. Out of scope.

## Change
### 1. One login step before every affected `docker build` (both lanes)
Insert the same step in each job of the premise-2 table: after `Login to Amazon ECR` and before the build step.

```yaml
      - name: Login to Amazon ECR Public (authenticated base-image pulls)
        # ci-ecr-public-auth: anonymous public.ecr.aws pulls from shared runner IPs hit 429.
        # Fail-soft by design: on any error warn loudly and fall back to the anonymous pull we had before.
        run: |
          if PW="$(aws ecr-public get-login-password --region us-east-1 2>/tmp/ecr-public.err)" \
             && printf '%s' "$PW" | docker login --username AWS --password-stdin public.ecr.aws >/dev/null 2>>/tmp/ecr-public.err; then
            echo "ecr-public-login: authenticated"
          else
            echo "::warning title=ECR Public login failed::anonymous public.ecr.aws pulls (429 risk): $(head -c 300 /tmp/ecr-public.err | tr '\n' ' ')"
            echo "### ECR Public login failed: anonymous base-image pulls (429 risk)" >> "$GITHUB_STEP_SUMMARY"
          fi
          unset PW
```

Placement (insert after the line given, i.e. between private ECR login and the build step):
- platform `AWS-STAGE-DEPLOY-GATEWAY.yml`: after `:211`, before `:213` (Preflight) — the build is `:228`.
- platform `AWS-PROD-DEPLOY-GATEWAY.yml`: directly before `:450`, with the same `if:` as `:452`
  (`(inputs.deploy_mode || 'promote-staging') == 'rebuild-main'`). promote-staging and env-only do not build.
- platform `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml`: after `:126`, before `:128`.
- platform `AWS-STAGE-DEPLOY-KIRO-RUNNER.yml` `build-push-deploy`: after `:112`, before `:114`.
- platform `AWS-STAGE-DEPLOY-KIRO-RUNNER.yml` `build`: before `:78`, add `Configure AWS credentials` (the same
  static-key block as `:103-108`) and then the login step, **both with `if: github.event_name != 'pull_request'`**.
  PR builds keep pulling anonymously, so no AWS secret reaches a job that builds unmerged PR code.
- v1 `AWS-STAGE-DEPLOY-FRONTEND.yml`: after `:156`, before `:158`.
- v1 `AWS-PROD-DEPLOY-FRONTEND.yml`: after `:178`, before `:180`.

`--region us-east-1` is hard-coded on purpose: ECR Public auth exists only in us-east-1. The job's
`TARGET_AWS_REGION` (eu-central-1) stays as is for everything else. IAM user keys and OIDC session credentials
are valid in every region, so no second credentials step is needed.

**Why fail-soft.** With the step in place, the worst case equals today (an anonymous pull). Failing hard would
turn a missing IAM permission, or a us-east-1 ECR Public/STS outage, into a guaranteed red deploy. That includes
a production rebuild or rollback, which the base-image switch was meant to protect (VTID-05015/05017). The
workflow edits can therefore merge before the IAM change is applied, and the IAM change can land in any order.
"Loud" means a `::warning` annotation plus a step-summary line on every run that fell back. The lane acceptance
also requires the first staging run after the IAM change to log `ecr-public-login: authenticated`. The password
never goes to a log: it is piped on stdin and unset, and only the CLI's stderr (an error text) is echoed.

### 2. A CI guard that every affected build job has the step (both lanes)
- platform: `services/gateway/test/ci-ecr-public-auth-workflows.test.ts` (Jest, `js-yaml` is already a gateway
  dependency; same source-check style as `services/gateway/test/vtid-05017-base-images-ecr-public.test.ts`).
- v1: `src/lib/deploy-workflow.ecr-public-auth.test.ts` (Vitest). Reference files, both checked on v1
  `origin/main` `f2233d9bc`: `src/lib/deploy-workflow.vtid-04908.test.ts:10-17` (exists: `readFileSync` of the
  workflow from `ROOT = join(__dirname, '..', '..')`, then `indexOf`/`slice` between step names) and the platform
  `services/gateway/test/vtid-05017-base-images-ecr-public.test.ts` (Dockerfile `FROM` scan). v1 has no `yaml` /
  `js-yaml` dependency in `package.json`, so the v1 test adds none: it splits each workflow into jobs by the
  two-space `^  <job-id>:$` keys under `jobs:` and into steps by `^      - name:`, in file order, and applies the
  same assertions as below on that text. Its structure, inline:
  1. `ROOT = join(__dirname, '..', '..')`; list `.github/workflows/AWS-*-DEPLOY-*.yml` with `readdirSync`.
  2. For each job, find the steps whose text contains `docker build`; the build context is the last argument
     (`.` for v1), the Dockerfile is `-f <file>` or `<context>/Dockerfile`.
  3. Read that Dockerfile; skip the job unless a `FROM` line names `public.ecr.aws/`.
  4. Assert: a login step (contains `aws ecr-public get-login-password --region us-east-1`, `docker login` and
     `public.ecr.aws`) exists, its index is after `configure-aws-credentials` and before the first build step, and
     its text has the `else` branch with `::warning`.
  5. A sanity test asserts at least one job was checked per repo (v1: both `AWS-STAGE-DEPLOY-FRONTEND.yml` and
     `AWS-PROD-DEPLOY-FRONTEND.yml` `build-push-deploy`), so an empty glob or a broken splitter cannot pass silently.
  The platform test does the same with `js-yaml` (`jobs.<id>.steps[]`), plus the same sanity test (its four jobs).
Each test parses every `.github/workflows/AWS-*-DEPLOY-*.yml` in its repo. For every job with a `run:` step
containing `docker build`, it resolves the Dockerfile that step builds (`-f <file>` or `<context>/Dockerfile`,
relative to the step's `cd`/context). If any `FROM` line in it names `public.ecr.aws/`, the job must have a step
whose `run` contains `aws ecr-public get-login-password --region us-east-1` and `docker login` with
`public.ecr.aws`. That step must come before the first `docker build` step, after any `configure-aws-credentials`
step, and have the fail-soft `else` branch with `::warning`. A job that builds no `public.ecr.aws` Dockerfile is not
checked, so the guard grows automatically when another Dockerfile moves to the mirror. Red→green proof: run the
test on `origin/main` (red: it names each job) and on the lane head (green).

### 3. IAM permissions as a reviewed change (lane `platform-ecr-public-login`)
- New `scripts/aws/iam/ci-ecr-public-pull-policy.json`: one statement `EcrPublicPull`, actions
  `ecr-public:GetAuthorizationToken` and `sts:GetServiceBearerToken`, `Resource: "*"`. The STS action is
  conditioned on `sts:AWSServiceName = ecr-public.amazonaws.com`. Least privilege: it is the login part of
  `AmazonElasticContainerRegistryPublicReadOnly` only.
- New `scripts/aws/iam/ci-ecr-public-pull-iam-check.sh`: read-only, modelled on
  `scripts/aws/iam/vtid-05023-iam-check.sh`. It runs an account guard (`472838866351`), then
  `iam simulate-principal-policy` for both actions against the user `claude-staging-validation` and the role
  `vitana-gateway-awsdr-deploy-role`. It prints the missing ones and the exact apply command for each:
  `aws iam put-user-policy --user-name claude-staging-validation --policy-name ci-ecr-public-pull --policy-document file://…`
  and `aws iam put-role-policy --role-name vitana-gateway-awsdr-deploy-role --policy-name ci-ecr-public-pull --policy-document file://…`.
  The script never applies anything itself.
- Applying it is a live IAM write. No Kiro or CI session does it (collaboration §7a). The owner, or an operator
  with IAM admin rights, runs the check and the printed commands in CloudShell once the lane is merged. Until
  then the login step falls back to anonymous pulls with the warning, exactly as today. The lane log and Gate 2
  "Decisions taken" record whether it has been applied (from the next staging run's log line).

## Lanes (both `executor: claude`, they touch `.github/**`)
- `platform-ecr-public-login` (vitana-platform): change 1 in the four platform workflows, change 2
  (platform test), change 3 (policy + check script), `docs/validation/<VTID>/**`.
- `v1-ecr-public-login` (vitana-v1): change 1 in the two v1 workflows, change 2 (v1 test),
  `docs/validation/<VTID>/**`.
- `depends_on: []` for both. They share no file and no interface beyond the identical step text above.
- Governance: `.github/**` is a governance path (collaboration §3a), so both lanes are `executor: claude`. While
  Claude is unavailable they go to the exceptions seat `exafyltd`. `AWS-PROD-DEPLOY-GATEWAY.yml`,
  `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml` (platform) and `AWS-PROD-DEPLOY-FRONTEND.yml` (v1) match the
  protected gate glob `.github/workflows/AWS-PROD-*.yml` (`scripts/collab/protected-gate-files.json`). Those
  PRs merge only with a legacy Claude review on the current head or the owner's instruction, never on a
  reviewer-agent accept alone. The staging workflows are in the same PR. If that review is slow, the builder may
  split the prod-workflow hunks into a follow-up PR on the same lane, so the staging fix is not held back.
- Neither lane dispatches a workflow or deploys production. A prod workflow edit takes effect at the next
  owner-approved PUBLISH.

## Out of scope
- Docker Hub-based Dockerfiles and their builds (premise 2, last paragraph). Same pattern later, if wanted.
- CI `services:` containers on `public.ecr.aws/.../postgres:16` (premise 4). These need `services.<id>.credentials`
  with a token minted in an earlier job.
- A pull-through cache rule or mirroring base images into private ECR `472838866351`/`eu-central-1`. Both are
  new infrastructure (a cache rule, repository lifecycle, a Dockerfile `FROM` rewrite and ECR pull permissions
  on every role). The login step reaches the authenticated limit with none of that. If 429s persist after the
  IAM change is applied and the step logs `authenticated`, a pull-through cache is the follow-up plan.
- A retry loop around `docker build`.

## Test plan
- platform lane: `cd services/gateway; npx jest test/ci-ecr-public-auth-workflows.test.ts test/vtid-05017-base-images-ecr-public.test.ts`
  passes on the lane head and fails on `origin/main` (red→green recorded in `docs/validation/<VTID>/commands.log`).
  `bash -n scripts/aws/iam/ci-ecr-public-pull-iam-check.sh` and `python3 -m json.tool scripts/aws/iam/ci-ecr-public-pull-policy.json` pass.
- v1 lane: `npx vitest run src/lib/deploy-workflow.ecr-public-auth.test.ts` passes on the lane head and fails on
  `origin/main`. `npm test` stays green.
- Both lanes: `actionlint` (if available in CI) or the existing workflow YAML parse in PR-GATE stays green.
- Staging (rule 47, read-only), one `docs/validation/<VTID>/staging-tests.json` per lane:
  - platform: the next `AWS-STAGE-DEPLOY-GATEWAY.yml` run for the merge commit succeeds. GET
    `https://preview-aws-gateway.vitanaland.com/alive` returns 200, and GET `/api/v1/admin/build-info` reports a
    commit containing the merge commit.
  - v1: the next `AWS-STAGE-DEPLOY-FRONTEND.yml` run for the merge commit succeeds, and GET
    `https://preview-aws.vitanaland.com/` returns 200 and serves the new bundle.
  - Evidence in the lane log: the build log line `ecr-public-login: authenticated`, or the `::warning`
    fallback while the IAM change is not yet applied.
- No suite targets production. The prod workflows are proven by the same test and by the next owner PUBLISH.
<!-- plan:end -->
