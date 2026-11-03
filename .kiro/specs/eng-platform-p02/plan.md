---
change_class: standard
---
# plan(eng-platform-p02): the production community-app deploy logs in with its own keyless role

Author: Kiro, seat `exafy`, session `kiro-exafy-202611021438-cff7` (Kiro Web). Premises pinned to vitana-platform
`origin/main` `2c04ec9268654c69224fd4957a231f6d674a86df` and vitana-v1 `origin/main` `02c75006d36b54af0fa4be52d4b3501ef6251d5d` (declared as `spar_refs` in `handoff.md`).

<!-- plan:begin -->
## 1. Goal
Owner, 2026-11-03, choosing between two options: *"ok 2"*. Option 2: the production frontend deploy gets its own
keyless login. Nothing switches until one repository variable is set. The old staging key is switched off only after
one real production deploy has used the new login.

Why: the production community-app deploy is the last CI workflow that logs in with the long-lived staging key of IAM
user `claude-staging-validation` (`AWS-PROD-DEPLOY-FRONTEND.yml:172-173`). The production gateway deploy already logs in
without a stored key. `docs/ENGINEERING-PLATFORM-PLAN.md` Phase 1 requires no static AWS keys in any CI.

Not in scope: when or how production deploys happen (PUBLISH, the owner's command, the cutover gate), what ships,
rollback, and every staging deploy.

## 2. Today (evidence on the premises' origin/main)
- vitana-v1 `AWS-PROD-DEPLOY-FRONTEND.yml:170-174`: the credential step passes `secrets.AWS_STAGING_ACCESS_KEY_ID` and
  `secrets.AWS_STAGING_SECRET_ACCESS_KEY`. The file has no `permissions:` block, so it inherits from its caller.
- vitana-v1 `DEPLOY.yml:42-45`: top-level `permissions: contents: read`. The comment records that VTID-04833 removed
  `id-token` when the GCP login went. `DEPLOY.yml:99-103`: the `aws_prod` job calls the reusable workflow with
  `secrets: inherit` and sets no job-level permissions.
- A reusable workflow cannot widen its caller's permissions. If `AWS-PROD-DEPLOY-FRONTEND.yml` requests
  `id-token: write`, `DEPLOY.yml` must grant it too, or the whole DEPLOY run fails at start.
- Production targets (inputs' defaults, `AWS-PROD-DEPLOY-FRONTEND.yml:77-87` and `:114-125`): ECR `vitana/community-app`,
  cluster `Vitana-ECS-Cluster`, service `vitana-community-app-awsdr`, region `eu-central-1`. The guard at `:183-186`
  refuses the staging service `vitana-community-app`.
- Its AWS calls are ECR and ECS only (`:178-282`). Its rollback step is `:364-373`. It makes no S3, CloudFront or
  Secrets Manager call.
- The Command Hub PUBLISH button can start this workflow directly: `services/gateway/src/routes/operator.ts:2339-2344`
  (vitana-platform), when `FRONTEND_DEPLOY_TOKEN` is set.
- The gateway's production deploy logs in with a role: `AWS-PROD-DEPLOY-GATEWAY.yml`, step "Configure AWS credentials
  (GitHub OIDC — no static keys)".

## 3. Interfaces (fixed here)
- Repository variable in exafyltd/vitana-v1: `AWS_PROD_FRONTEND_ROLE_ARN` (an ARN, not a secret).
- IAM role `vitana-gha-prod-frontend-deploy` in account 472838866351, created by the owner in CloudShell:
  - Trust: `StringEquals` on `token.actions.githubusercontent.com:aud` = `sts.amazonaws.com` and on
    `token.actions.githubusercontent.com:sub` = `repo:exafyltd/vitana-v1:ref:refs/heads/main` only.
  - Permissions: ECR describe and push on `vitana/community-app`. ECS `DescribeServices`, `DescribeTaskDefinition`,
    `RegisterTaskDefinition`, `DescribeClusters`, `ListTasks`, `DescribeTasks` and `UpdateService`, with `UpdateService`
    on `vitana-community-app-awsdr` only. `iam:PassRole` only to the task and execution roles that service runs with,
    read from its live task definition when the role is created. The creation block refuses if the service is not
    `vitana-community-app-awsdr`.
- Credential step in `AWS-PROD-DEPLOY-FRONTEND.yml`: `role-to-assume: ${{ vars.AWS_PROD_FRONTEND_ROLE_ARN }}`, and the keys
  `${{ !vars.AWS_PROD_FRONTEND_ROLE_ARN && secrets.AWS_STAGING_ACCESS_KEY_ID || '' }}` (and the secret likewise). With
  the variable unset, behaviour is exactly today's.
- `AWS-PROD-DEPLOY-FRONTEND.yml`: top-level `permissions: contents: read` and `id-token: write`.
- `DEPLOY.yml`, `aws_prod` job: `permissions: contents: read` and `id-token: write`, plus an updated comment. Nothing else.

## 4. Lanes
Lane `prod-frontend-oidc` (vitana-v1, executor kiro, seat exafyltd, reviewer_seat agent:vitana-lane-reviewer).
`paths`: `.github/workflows/AWS-PROD-DEPLOY-FRONTEND.yml`, `.github/workflows/DEPLOY.yml`,
`src/lib/eng-platform-prod-frontend-oidc.test.ts`, `docs/validation/**`. It implements §3 and nothing else. The owner's
command for the production-workflow change is "ok 2" (2026-11-03).

## 5. Tests (each red on base)
- `src/lib/eng-platform-prod-frontend-oidc.test.ts` (Vitest, reads workflow text). Red on base: no
  `vars.AWS_PROD_FRONTEND_ROLE_ARN`, no top-level `id-token: write`, and `aws_prod` without the id-token grant. Green
  after: the credential step has exactly the §3 shape; the staging-service guard and the `vitana-community-app-awsdr`
  default are unchanged; `secrets: inherit` stays; both YAML files parse.
- Existing tests that read `DEPLOY.yml` or `AWS-PROD-DEPLOY-FRONTEND.yml` (found by grep at lane start) stay green. Any
  test that pins `contents: read` alone is named in the lane evidence with the reason it changes.
- No gateway test and no database change.

## 6. Rollout (merging does not deploy to production)
1. The plan converges in CI PLAN-SPAR, VTIDs are assigned, the lane PR is opened and its checks are green, and the owner
   names the PR for merge (or the reviewer agent accepts it from Kiro IDE).
2. The merge deploys nothing to production. DEPLOY.yml's cutover gate freezes automatic production deploys. On the
   2026-11-03 merge, `aws_prod` was skipped.
3. The owner runs the CloudShell block. It creates the role, then simulates every action the workflow calls against the
   new policy and prints allowed or denied. The block switches nothing.
4. The owner sets `AWS_PROD_FRONTEND_ROLE_ARN` in exafyltd/vitana-v1.
5. The next production frontend deploy (PUBLISH or the owner's dispatch) proves the login. The credential step must
   print "Assuming role", not "Proceeding with IAM user credentials".
6. Only after step 5 passes, the owner deactivates the `claude-staging-validation` key.

Rollback: remove the variable, and the old key is used again. That works only while the old key is still active, which
is why step 6 comes last.

## 7. Risks
- A wrong trust subject refuses the login before any AWS change. Fix: the role's trust.
- A permission missing mid-deploy: the workflow's rollback (`:364-373`) returns the service to the previous task
  definition. The CloudShell simulation catches most gaps first.
- `DEPLOY.yml` without the grant fails the whole run at start. This lane adds the grant in the same PR, and the test
  pins it.
- Existing, not changed here: vitana-v1 `main` has no branch protection, so a trust on `main` means "anyone who can
  push to vitana-v1 main". The gateway production role has the same trust model. The gap is recorded in
  `.kiro/specs/ci-github-modernization/plan.md`.

## 8. Staging verification
Not verified on staging: this is a production workflow. The proof is rollout step 5, on the next production deploy.

## 9. Unchanged
PUBLISH, the gateway production deploy, the cutover gate, rollback, image tagging, service names, and every other
workflow.
<!-- plan:end -->
