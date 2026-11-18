# VTID-05803: staging gateway deploy carries no production credentials

Owner instruction 2026-11-18: staging services receive staging credentials, never production service-role credentials.

AC-1. Staging resolves only staging-named auth secrets: `vitana/supabase/staging/jwt-secret`, `vitana/supabase/staging/anon-key`,
`vitana/gateway/staging/service-token` (was `vitana/supabase/prod/*`). A missing secret stops the deploy before registration.
TEST: `services/gateway/test/vtid-05803-stage-deploy-no-prod-secrets.test.ts` (resolves only staging-named auth secrets);
`scripts/ci/staging-db/stage-deploy-no-prod-secrets.test.mjs` test 1.

AC-2. A task definition that names `vitana/(supabase|aurora)/prod/*`, `vitana-aurora-prod` or the production master secret in
any secret or environment value is refused before register + roll (own step, after render).
TEST: `scripts/ci/staging-db/stage-deploy-no-prod-secrets.test.mjs` test 2 runs the exact jq on staging and production cases;
the jest test checks the pattern and the step order.

AC-3. `data_backend=aurora` and the VTID-05781/VTID-05023 roll step are unchanged (shared path byte-identical to the pinned step).
TEST: `scripts/ci/staging-db/cutover-workflows.test.mjs` 41/41.

AC-4. Production deploy unchanged. TEST: both new tests, "production deploy keeps its production secrets".

AC-5. The run-step size limit holds. TEST: `test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts`.

Contract change on purpose: `test/vtid-04225-no-dead-gcp-urls-in-workflows.test.ts` asserted the staging service token is the
production service-role key; it now asserts the staging secret and the absence of the production one.
Effect: callers of the staging gateway must present the staging service token.
