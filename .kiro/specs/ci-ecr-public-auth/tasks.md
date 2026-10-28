# Tasks — ci-ecr-public-auth
Authoritative plan: `plan.md` (this folder). Lane files: `lanes/`.
VTID: allocated by PLAN-SPAR after approval (one per lane).

<!-- lane: platform-ecr-public-login -->
## platform-ecr-public-login — ECR Public login in platform deploy builds + IAM files (repo vitana-platform)
Allowed paths:
- `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml`
- `.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml` (protected gate file)
- `.github/workflows/AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml` (protected gate file)
- `.github/workflows/AWS-STAGE-DEPLOY-KIRO-RUNNER.yml`
- `services/gateway/test/ci-ecr-public-auth-workflows.test.ts`
- `scripts/aws/iam/ci-ecr-public-pull-policy.json`
- `scripts/aws/iam/ci-ecr-public-pull-iam-check.sh`
- `docs/validation/<VTID>/**` (the lane's own record and staging suite, rule 47)

- [ ] P1. Insert the login step (`design.md` "Step") in: `AWS-STAGE-DEPLOY-GATEWAY.yml` after `:211`;
  `AWS-PROD-DEPLOY-GATEWAY.yml` directly before `:450` with the `:452` `if:`; `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml`
  after `:126`; `AWS-STAGE-DEPLOY-KIRO-RUNNER.yml` `build-push-deploy` after `:112`. Line numbers are as of
  `origin/main` @ `5f76b3ab2`; re-check them on the lane's base.
- [ ] P2. `AWS-STAGE-DEPLOY-KIRO-RUNNER.yml` `build` job: before `:78`, add `Configure AWS credentials` (same block
  as `:103-108`) and the login step, both `if: github.event_name != 'pull_request'`.
- [ ] P3. `services/gateway/test/ci-ecr-public-auth-workflows.test.ts`: the guard from `design.md`, using `js-yaml`
  (already a gateway dependency). Root = `path.join(__dirname, '../../..')` as in
  `vtid-05017-base-images-ecr-public.test.ts`. Record red on `origin/main` and green on the lane head in
  `docs/validation/<VTID>/commands.log`.
- [ ] P4. `scripts/aws/iam/ci-ecr-public-pull-policy.json` (Sid `EcrPublicPull`; `ecr-public:GetAuthorizationToken`
  on `*`; `sts:GetServiceBearerToken` on `*` with `StringEquals` `sts:AWSServiceName: ecr-public.amazonaws.com`).
- [ ] P5. `scripts/aws/iam/ci-ecr-public-pull-iam-check.sh`: read-only, modelled on `vtid-05023-iam-check.sh`.
  Account guard `472838866351`. Simulate both actions for user `claude-staging-validation` and role
  `vitana-gateway-awsdr-deploy-role` (overridable by args). Print what is missing and the exact
  `put-user-policy` / `put-role-policy` commands. Never call them.
- [ ] P6. `docs/validation/<VTID>/staging-tests.json`, read-only: GET `https://preview-aws-gateway.vitanaland.com/alive`
  returns 200; GET `/api/v1/admin/build-info` returns JSON whose commit contains the merge commit. Plus
  `commands.log` and an `iam-status.md` saying whether the IAM change was applied (from the run log line).

Acceptance:
- `cd services/gateway; npx jest test/ci-ecr-public-auth-workflows.test.ts test/vtid-05017-base-images-ecr-public.test.ts`
  passes on the lane head; the new test fails on `origin/main`.
- `bash -n scripts/aws/iam/ci-ecr-public-pull-iam-check.sh` and `python3 -m json.tool scripts/aws/iam/ci-ecr-public-pull-policy.json` pass.
- The diff touches only the allowed paths. No workflow is dispatched, nothing is deployed, and no IAM call is made.
- The `AWS-PROD-*.yml` hunks have a legacy Claude review on the current head, or the owner's instruction, before
  merge (§3a). If that holds the PR back, they may move to a follow-up PR on the same lane.
<!-- lane: platform-ecr-public-login -->

<!-- lane: v1-ecr-public-login -->
## v1-ecr-public-login — ECR Public login in the frontend deploy builds (repo vitana-v1)
Allowed paths (in `exafyltd/vitana-v1`):
- `.github/workflows/AWS-STAGE-DEPLOY-FRONTEND.yml`
- `.github/workflows/AWS-PROD-DEPLOY-FRONTEND.yml` (protected gate file)
- `src/lib/deploy-workflow.ecr-public-auth.test.ts`
- `docs/validation/<VTID>/**`

- [ ] V1. Insert the login step (`design.md` "Step") in `AWS-STAGE-DEPLOY-FRONTEND.yml` after `:156` and in
  `AWS-PROD-DEPLOY-FRONTEND.yml` after `:178`. Line numbers as of `origin/main` @ `7dfee6877`; re-check them.
- [ ] V2. `src/lib/deploy-workflow.ecr-public-auth.test.ts`: the guard from `design.md`, structure inline in
  `plan.md` change 2 (Vitest; `readFileSync`/`slice` style of `src/lib/deploy-workflow.vtid-04908.test.ts:10-17`,
  Dockerfile `FROM` scan as in platform `vtid-05017-base-images-ecr-public.test.ts`; no new dependency, v1 has no
  yaml parser; root `Dockerfile`, build context `.`; sanity test that both frontend build jobs were checked).
  Record red on `origin/main` and green on the lane head.
- [ ] V3. `docs/validation/<VTID>/staging-tests.json`, read-only: GET `https://preview-aws.vitanaland.com/` returns
  200 and serves the bundle of the merge commit. Plus `commands.log`.

Acceptance:
- `npx vitest run src/lib/deploy-workflow.ecr-public-auth.test.ts` passes on the lane head and fails on
  `origin/main`. `npm test` stays green.
- The diff touches only the allowed paths. No workflow is dispatched and nothing is deployed.
- The `AWS-PROD-DEPLOY-FRONTEND.yml` hunk has a legacy Claude review on the current head, or the owner's
  instruction, before merge.
<!-- lane: v1-ecr-public-login -->
