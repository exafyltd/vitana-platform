# Plan — build the gateway and kiro-runner images from AWS's mirror, not Docker Hub

<!-- plan:begin -->
## Problem (measured 2026-10-09)
`AWS Stage Deploy Gateway (ECS)` run 37993002611 failed twice at `docker build`, before any repo code ran:
attempt 1 `node:20-alpine ... 429 Too Many Requests` from registry-1.docker.io; attempt 2
`auth.docker.io/token: 504 Gateway Timeout`. The same Docker Hub rate limit failed
`Gateway Validation (Minimal CI)` twice on PR #3980 (`postgres:16` service image). GitHub-hosted runners
pull Docker Hub anonymously; a busy shared runner IP hits the anonymous limit and the deploy cannot run.
**This plan fixes the image-build (`docker build`) failures only.** The CI service-container failure
(`postgres:16`) is not fixed here — see "Not in scope".

## Change (change class: standard — 4 Dockerfiles + 1 test; no workflow/route/auth/migration change)
Point the base images at AWS's official mirror of the Docker Hub "library" images, same image and tag:
- `services/gateway/Dockerfile` lines 1 and 12: `FROM node:20-alpine` →
  `FROM public.ecr.aws/docker/library/node:20-alpine` (both stages).
- `services/gateway/Dockerfile.job` lines 22 and 33 (built by `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml`), and
  `services/gateway/Dockerfile.auto-logger` lines 1 and 15: same change.
- `services/kiro-runner/Dockerfile` lines 10, 18, 29: `FROM node:20-bookworm-slim` →
  `FROM public.ecr.aws/docker/library/node:20-bookworm-slim`.
Verified 2026-10-09: both tags resolve on `public.ecr.aws/docker/library/node` (manifest 200 with an anonymous
ECR Public token). `public.ecr.aws/docker/library/*` is published by Docker/AWS as the same official images.
Both Dockerfiles are built by their AWS-STAGE/PROD deploy workflows (`AWS-STAGE-DEPLOY-GATEWAY.yml`,
`AWS-PROD-DEPLOY-GATEWAY.yml` rebuild-main, `AWS-STAGE-DEPLOY-KIRO-RUNNER.yml`); no workflow edit needed.

## Not in scope (deferred, listed)
- CI service containers (`postgres:16` in Gateway Validation / SQL-* workflows) — workflow changes, separate plan.
- Other services' Dockerfiles (oasis-operator, orb-agent, etc.) — same pattern, separate small change if wanted.
- Authenticated ECR Public pulls (`aws ecr-public get-login-password`) — needs IAM changes on the OIDC role;
  anonymous ECR Public limits are per-IP but far above Docker Hub's anonymous limit.

## Risk
- Same image content (official library mirror), so no runtime difference; tag stays `20-alpine` /
  `20-bookworm-slim` (floating, as today).
- If ECR Public is unreachable the build fails the same loud way it does today on Docker Hub; no fallback.

## Tests
- A source-check test (`services/gateway/test/vtid-05017-base-images-ecr-public.test.ts`): globs every
  `Dockerfile*` under `services/gateway/` and `services/kiro-runner/` (so a new one is covered too) and asserts
  each `FROM` uses `public.ecr.aws/docker/library/` or names an earlier build stage; none names a bare
  Docker Hub image.
- CI: the gateway image builds in the PR's deploy-path checks (if any) and in the staging deploy after merge.
- Staging: the staging deploy succeeding for the merge commit and STAGING-VERIFY passing is the proof.
  `docs/validation/VTID-05017/staging-tests.json`: build-info on staging reports the merge commit (read-only GET).
<!-- plan:end -->


## Planner responses — round 1
- F1 [major] Dockerfile.job / Dockerfile.auto-logger omitted — ACCEPTED (oversight). Both added; class now standard.
- F2 [minor] test scope — ACCEPTED: the test globs every Dockerfile* in both service dirs; stage references allowed.
- F3 [minor] problem statement — ACCEPTED: it now says this plan fixes image builds only; postgres:16 stays deferred.

## Partner round 2
F1–F3 closed. No new findings. Verdict: CONVERGED.

## Record
- Plan hash (sha256 of the text between the plan markers): `6613c147e981f4e0150f0333108644a79c21740d952566e4193bd489e92c8142`
- Partner: plan-sparring-partner, 2 rounds. Verdict: **CONVERGED**.
- Approval: owner "Yes, build it and ship." in the Claude Code session, 2026-10-09. VTID-05017 allocated after approval.
