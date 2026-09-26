# VTID-04647 — Testing & QA P5b: read-only post-deploy verification with automatic rollback (gateway production)

## Report

`AWS-PROD-DEPLOY-GATEWAY.yml` now verifies a production gateway deploy read-only after it rolls the service, and puts the previous task definition back when that fails.

- **Capture rollback target** (new step, before the service is touched): reads the task definition production runs now and its `GIT_COMMIT_SHA`. The deploy refuses to continue without it.
- **Post-deploy verification (read-only)** (new step, after the existing smoke gate): GET-only, no auth, nothing written. `/api/v1/admin/health`, `/api/v1/admin/build-info` and `/api/v1/orb/health` must answer JSON below 500, with three attempts each. Only long-standing routes are checked, so an env-only redeploy of an older image cannot trip it.
- **Roll back to the previous task definition** (new step): runs when the service was rolled and any later step failed (stabilize, smoke or post-deploy verification). It points the service at the captured task definition, waits for it to stabilize, and waits for build-info to report the previous commit. The job still fails, because a rolled-back deploy is not a successful one. The kill switch is the repository variable `PROD_AUTO_ROLLBACK_DISABLED=true`; the dispatch form is at GitHub's 25-input ceiling.
- **OASIS**: the existing always-run event step records `prod.deploy.rolled_back` (with `rolled_back_to`) instead of `prod.deploy.failed` when a rollback happened.

## Acceptance

AC-1: The rollback target is captured before the service is rolled, and the deploy refuses to continue without one.
TEST: services/gateway/test/vtid-04647-prod-deploy-auto-rollback.test.ts

AC-2: The post-deploy verification runs after the smoke gate and only sends GET requests without credentials.
TEST: services/gateway/test/vtid-04647-prod-deploy-auto-rollback.test.ts

AC-3: A failure after the roll puts the captured task definition back, waits for stability and records `rolled_back=true`. It never builds or registers anything, and it has a kill switch.
TEST: services/gateway/test/vtid-04647-prod-deploy-auto-rollback.test.ts

AC-4: A rollback is recorded as `prod.deploy.rolled_back`. The workflow stays dispatch-only and every run: step stays under the 20,000-character limit.
TEST: services/gateway/test/vtid-04647-prod-deploy-auto-rollback.test.ts, services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts

OASIS_PROOF: the emit step's topic switch and `rolled_back`/`rolled_back_to` metadata are pinned by services/gateway/test/vtid-04647-prod-deploy-auto-rollback.test.ts ("records a rollback as prod.deploy.rolled_back").

## Not verified here

The workflow was not dispatched: a production deploy needs the owner's approval, and a real rollback needs a real failing deploy. The first production publish after this merges is the live check. It should add three steps to the run, all green on a healthy deploy.
