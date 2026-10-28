# VTID-04715 — STAGING-VERIFY checks the commit a staging deploy actually deployed

Two defects found on 2026-09-28 while shipping VTID-04709's first pinned deploy.

1. **A pinned deploy could not be verified automatically.** STAGING-VERIFY
   (workflow_run) took the commit from the deploy run's `head_sha`, which is
   main HEAD (`16ec35e`) even when a `commit_sha` pin deployed an older commit
   (`a4adbbe`). The automatic run expected the wrong commit and recorded a
   meaningless `staging.verify.failed`.
2. **Production ahead of the verified commit read as "histories diverged".**
   Production already ran `72e8e2f`, which contains `a4adbbe`. The runner said
   the histories had diverged and listed `a4adbbe` as "what would ship".

## Change

- `AWS-STAGE-DEPLOY-GATEWAY.yml` uploads a `deployed-commit` artifact holding
  the checked-out commit (`steps.commit.outputs.sha`) after a successful deploy.
- `STAGING-VERIFY.yml` downloads that artifact from the triggering run and
  verifies that commit; a deploy run without it (older runs) falls back to
  `head_sha` as before; a malformed value fails the run. `SHA` is set once, via
  `GITHUB_ENV`; the job-level event commit is now `EVENT_SHA`.
- `lib.describeBaseline()` names where production stands: `same`, `behind`,
  `ahead`, `diverged`, `missing`, `unknown`. `ahead` fails as "production is
  behind the verified commit" with nothing listed to ship, because promoting
  it would roll production back.

## Acceptance criteria

AC-1 The staging deploy uploads the commit it checked out as `deployed-commit`, after the live-commit smoke check.
  TEST: services/gateway/test/vtid-04715-staging-verify-deployed-commit.test.ts
AC-2 STAGING-VERIFY verifies the recorded commit, falls back to head_sha without an artifact, rejects a malformed one.
  TEST: services/gateway/test/vtid-04715-staging-verify-deployed-commit.test.ts
AC-3 Production already containing the verified commit fails with that reason and lists nothing to ship.
  TEST: scripts/ci/staging-verify/lib.test.cjs
AC-4 The other baseline states keep their meaning (same, behind, diverged, missing, unknown).
  TEST: scripts/ci/staging-verify/lib.test.cjs
AC-5 Every existing test that reads either workflow still passes (incl. the VTID-03788 bash-syntax/size guard).
  TEST: services/gateway/test (53 suites that read AWS-STAGE-DEPLOY-GATEWAY.yml or STAGING-VERIFY)
AC-6 (after merge) The automatic STAGING-VERIFY after this merge's staging deploy verifies the commit the deploy recorded.
  CURL: https://preview-aws-gateway.vitanaland.com/api/v1/admin/build-info

OASIS_IMPACT: no new topic — `staging.verify.*` keeps its shape; its `commit` is now the deployed one.
