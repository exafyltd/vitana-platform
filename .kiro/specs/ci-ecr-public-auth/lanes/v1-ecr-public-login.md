---
lane: v1-ecr-public-login
state: ready
next_actor: kiro
depends_on: []
executor: claude
seat: exafyltd
repos: [exafyltd/vitana-v1]
paths:
  - .github/workflows/AWS-STAGE-DEPLOY-FRONTEND.yml
  - .github/workflows/AWS-PROD-DEPLOY-FRONTEND.yml
  - src/lib/deploy-workflow.ecr-public-auth.test.ts
  - docs/validation/**
updated: 2026-10-22T08:07Z
vtid: VTID-05329
---
# v1-ecr-public-login — authenticated public.ecr.aws pulls in the frontend deploy builds (repo vitana-v1)
Plan: `.kiro/specs/ci-ecr-public-auth/plan.md` (in vitana-platform) and the `v1-ecr-public-login` section of
`tasks.md` (V1–V3, allowed paths, acceptance). Design: `design.md`.
**Held until PLAN-SPAR allocates this lane's VTID.** `executor: claude` because it changes `.github/**`. While
Claude is unavailable it goes to the exceptions seat `exafyltd` (collaboration §7). `AWS-PROD-DEPLOY-FRONTEND.yml`
matches the protected gate glob `.github/workflows/AWS-PROD-*.yml` (§3a): it needs a legacy Claude review on the
current head or the owner's instruction before merge.
Executor rules (§7a): no VTID allocation, no workflow dispatch, no deploy, no AWS write. The IAM change these
steps rely on for the authenticated path is in lane `platform-ecr-public-login`. Until it is applied, the step
falls back to anonymous pulls with a warning. Branch `<claude|kiro>/ci-ecr-public-auth/v1-ecr-public-login`; PR title
`VTID-xxxxx (ci-ecr-public-auth/v1-ecr-public-login): …`; trailers `Collab-Session`/`Collab-Lane`.
## Log
### 2026-10-22T08:00Z · kiro-hotmail-202610220740-e0de · created → ready
Created and held. Premise: both frontend deploy jobs build the root `Dockerfile` (`public.ecr.aws` node + nginx)
with anonymous pulls. Run 39681916225 hit 429 twice.

### 2026-10-22T08:07Z · ci-plan-spar · ready (VTID allocated)
VTID-05329 allocated after policy approval (converged-auto-v1).
