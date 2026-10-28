# VTID-04648 — Testing & QA P5c: browser checks move to staging; rule 48 names the read-only production checks

## Report

- `SCREEN-LOAD-TIMING.yml` runs against staging by default (`preview-aws.vitanaland.com`), refuses a production URL before any browser starts, runs with `E2E_READONLY=1` and no longer receives the Supabase service-role key.
- `MORNING-SYSTEM-HEALTH-CHECK.yml` step 20 (screen-load spot check) runs its Playwright suite on staging with `E2E_READONLY=1` and no service-role key. The production curl health checks in the same workflow are unchanged; they are GET-only.
- The test catalog flags `ui_test_touches_production` only when a step that runs `playwright test` targets a production host. `${{ env.X }}` is resolved against the workflow's env block, and a shell glob such as `https://vitanaland.com*` (the refusal guard) counts as a matcher, not as a target. Neither workflow is flagged any more.
- Rule 48 (CLAUDE.md) and `docs/DEPLOYMENT-PIPELINE.md` now name the only production checks allowed: the read-only post-deploy verification with automatic rollback (VTID-04647) and scheduled health checks, which are unauthenticated GETs with no sign-in, no writes and no browser suite. The vitana-v1 absolute rule is unchanged; it already allows deploy verification and still forbids test suites against production.

## Acceptance

AC-1: A Playwright step that runs on staging does not flag its workflow, even when other steps in the same workflow curl production.
TEST: services/gateway/test/scripts/test-catalog-lib.test.ts

AC-2: A Playwright step whose URL resolves through `${{ env.X }}` to a production host is still flagged.
TEST: services/gateway/test/scripts/test-catalog-lib.test.ts

AC-3: A production host that only appears in a refusal glob is not a target, so the screen-load workflow is catalogued as staging only.
TEST: services/gateway/test/scripts/test-catalog-lib.test.ts

AC-4: Scanning this repository, no workflow carries `ui_test_touches_production`.
TEST: services/gateway/test/scripts/test-catalog-lib.test.ts

OASIS_IMPACT: no. The screen-load spec keeps posting its timings to the staging gateway's report route; no OASIS topic changes.
