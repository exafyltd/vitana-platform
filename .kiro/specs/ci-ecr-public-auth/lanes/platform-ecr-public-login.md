---
lane: platform-ecr-public-login
state: executing
next_actor: kiro
depends_on: []
executor: claude
seat: exafyltd
repos: [exafyltd/vitana-platform]
paths:
  - .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml
  - .github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml
  - .github/workflows/AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml
  - .github/workflows/AWS-STAGE-DEPLOY-KIRO-RUNNER.yml
  - services/gateway/test/ci-ecr-public-auth-workflows.test.ts
  - scripts/aws/iam/ci-ecr-public-pull-policy.json
  - scripts/aws/iam/ci-ecr-public-pull-iam-check.sh
  - docs/validation/**
updated: 2026-10-28T10:55Z
claimed_by: kiro-exafyltd-202610281029-dea2
branch: kiro/ci-ecr-public-auth/platform-ecr-public-login
pr: https://github.com/exafyltd/vitana-platform/pull/4518
vtid: VTID-05328
---
# platform-ecr-public-login — authenticated public.ecr.aws pulls in platform deploy builds (repo vitana-platform)
Plan: `.kiro/specs/ci-ecr-public-auth/plan.md` and the `platform-ecr-public-login` section of `tasks.md`
(P1–P6, allowed paths, acceptance). Design: `design.md`.
**Held until PLAN-SPAR allocates this lane's VTID.** `executor: claude` because it changes `.github/**`. While
Claude is unavailable it goes to the exceptions seat `exafyltd` (collaboration §7). `AWS-PROD-DEPLOY-GATEWAY.yml`
and `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml` are protected gate files (§3a): they need a legacy Claude review on
the current head or the owner's instruction before merge.
Executor rules (§7a): no VTID allocation, no workflow dispatch, no deploy, no IAM or other AWS write. The IAM
policy is a file plus a read-only check script; the owner or an IAM admin applies it. Branch
`<claude|kiro>/ci-ecr-public-auth/platform-ecr-public-login`; PR title
`VTID-xxxxx (ci-ecr-public-auth/platform-ecr-public-login): …`; trailers `Collab-Session`/`Collab-Lane`.
## Log
### 2026-10-22T08:00Z · kiro-hotmail-202610220740-e0de · created → ready
Created and held. Premise: four platform deploy jobs (plus the kiro-runner CI build job) build
`public.ecr.aws` Dockerfiles with anonymous pulls. Gateway staging run 39421081117 failed with 429 on
`node:20-alpine` (2026-10-20).

### 2026-10-22T08:07Z · ci-plan-spar · ready (VTID allocated)
VTID-05328 allocated after policy approval (converged-auto-v1).
### 2026-10-28T10:55Z · kiro-exafyltd-202610281029-dea2 · ready → executing
Claimed (exceptions seat exafyltd, Claude unavailable). P1/P2: fail-soft ECR Public login step in the four workflows (five build jobs; kiro-runner `build` gets credentials + login only off `pull_request`). P3: `services/gateway/test/ci-ecr-public-auth-workflows.test.ts` (red 5/6 on base, green 6/6). P4/P5: policy file + read-only check script. P6: `docs/validation/VTID-05328/`. IAM not applied (iam-status.md). Protected gate files changed: `AWS-PROD-DEPLOY-GATEWAY.yml`, `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml` (§3a: legacy Claude review or owner instruction before merge).
### 2026-10-28T12:10Z · kiro-exafyltd-202610281029-dea2 · ready for review (PR #4518)
PR open, waiting for CI and the reviewer agent. Sibling lane v1-ecr-public-login: exafyltd/vitana-v1#1521.
