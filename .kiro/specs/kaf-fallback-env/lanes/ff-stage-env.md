---
lane: ff-stage-env
state: executing
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml
  - services/gateway/test/kaf-staging-claude-available-wiring.test.ts
  - docs/validation/VTID-*/**
updated: 2026-10-20T23:58Z
branch: kiro/kaf-fallback-env/ff-stage-env
vtid: VTID-05282
claimed_by: kiro-202610202258-2232
---
# ff-stage-env — `CLAUDE_AVAILABLE` from the repo variable into the staging task definition
Plan: `.kiro/specs/kaf-fallback-env/plan.md` §3 and §5 A, and the `ff-stage-env` section of `tasks.md`, are
authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here. Repo
vitana-platform. **Deploys** (staging task definition): ships `docs/validation/<VTID>/staging-tests.json`; done when
STAGING-VERIFY passed on its merge commit. Governance path (`.github/**`), not a protected gate file: merges on the
reviewer agent's accept on the current head + every check green; the PM refuses workflow files, so the land step merges
it (owner instruction 2026-10-20, plan §7). Never touches an `AWS-PROD-*` file. Merges before `ff-pm-flag`.
Shared files: none.
## Log
### 2026-10-20T23:20Z · kiro-exafyltd-202610202314-cfd9 · created → ready
Lane created with the plan (fix-forward of kiro-autonomy-fallback / VTID-05277). Next: PLAN-SPAR; once `vtid:` is set,
seat exafyltd claims it.

### 2026-10-20T23:41Z · ci-plan-spar · ready (VTID allocated)
VTID-05282 allocated after policy approval (converged-auto-v1).
### 2026-10-20T23:58Z · kiro-202610202258-2232 · ready → executing
Claimed by seat exafyltd (pipeline run wf_f16f7c2bcc131c71, slot 1). Changed: step `taskdef` of
`AWS-STAGE-DEPLOY-GATEWAY.yml` (env `CLAUDE_AVAILABLE_VALUE` from `vars.CLAUDE_AVAILABLE || 'true'`, jq `--arg CLAUDE_AVAILABLE`
before `--arg TASK_ROLE`, strip + single upsert next to `PM_MODE`), new wiring test (red on base 4/5 failed, green 5/5),
evidence in `docs/validation/VTID-05282/`. Next: reviewer agent on the PR head.
