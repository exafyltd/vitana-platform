# VTID-04930 — the autopilot executor deploy drops the dead DB_PASSWORD secret reference

VALIDATION_PROFILE: gateway_backend

## Problem (found live on staging, 2026-10-06 22:01 UTC)

Support-pipeline test ticket FB-2026-10-000145 (VTID-04788) reached Dev
Autopilot for the first time end to end: dispatched as execution `971de3de`
under VTID-04929. ECS then stopped the executor task before the container ran:

`TaskFailedToStart / ResourceInitializationError: unable to pull secrets or registry auth … failed to fetch secret … rds!cluster-eba8a4f2-… ResourceNotFoundException: Secrets Manager can't find the specified secret.`

The live task definition `vitana-autopilot-executor:27` (registered
2026-09-26) loads five secrets. A read-only `DescribeSecret` on each found
exactly one dead: `DB_PASSWORD`, pointing at the Aurora managed secret that
was deleted when `vitana-aurora-prod` got a new one. No executor run has
started since 2026-10-01. VTID-04849 (gateway) and VTID-04858 (orb-agent,
verification-engine) made the same drop; the executor workflow was missed.
Nothing in `services/gateway` (the executor image source) reads `DB_PASSWORD`.

## Fix

- `.github/workflows/AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml`: the register
  filter gets a separate stage, in the same form as the sibling fixes,
  `.containerDefinitions[0].secrets |= [ (. // [])[] | select(.name != "DB_PASSWORD") ]`.
  The DEEPSEEK strip list pinned by vtid-03850 is untouched. The stale header
  comment ("DB_PASSWORD are live") is corrected.
- New pin test with its own extractor for the executor step (four `--arg`s).

## Acceptance

AC-1 The register filter drops DB_PASSWORD and keeps the other four secrets, with DEEPSEEK_API_KEY re-added once at the new ARN.
TEST: services/gateway/test/vtid-04930-executor-deploy-drops-dead-db-secret.test.ts — "drops DB_PASSWORD, keeps the other secrets, re-adds DEEPSEEK_API_KEY once, sets the image"

AC-2 The test finds the executor's filter, so a broken extractor cannot pass silently.
TEST: services/gateway/test/vtid-04930-executor-deploy-drops-dead-db-secret.test.ts — "finds the register filter"

AC-3 The filter works on a task definition with no secrets.
TEST: services/gateway/test/vtid-04930-executor-deploy-drops-dead-db-secret.test.ts — "works when the task definition has no secrets at all"

AC-4 Nothing in the executor image source reads DB_PASSWORD.
TEST: services/gateway/test/vtid-04930-executor-deploy-drops-dead-db-secret.test.ts — "services/gateway (outside tests) never reads DB_PASSWORD"

AC-5 The existing executor and sibling pin suites stay green (65 tests, 7 suites). Mutation check: with the workflow change reverted, AC-1 and AC-2 fail.
TEST: services/gateway/test/vtid-03850-staging-executor-dispatch-pinned.test.ts, test/vtid-04237-executor-agent-hold-pinned.test.ts, test/vtid-04223-agent-memory-context.test.ts, test/vtid-04764-agent-progress-gate.test.ts, test/vtid-04858-agent-deploys-drop-dead-db-secret.test.ts, test/vtid-04849-prod-deploy-drops-dead-db-secret.test.ts

## Post-deploy proof (read-only, after the executor workflow runs from main)

- The new `vitana-autopilot-executor` revision has no DB_PASSWORD, and every other secret exists (`DescribeSecret`).
- The next real dispatch's ECS task reaches RUNNING, not `ResourceInitializationError`. Recorded as its own result below.

## Not covered (follow-ups)

- 12 more active task families still load DB_PASSWORD from the deleted secret (read-only scan 2026-10-07): vitana-auth-proxy:5, cognee-extractor:5, conductor:6, memory-indexer:5, oasis-operator:5, oasis-projector:9, openclaw-bridge:5, planner-core:6, validator-core:6, vitana-memory-indexer:5, worker-core:6, worker-runner:7. A restart of any of them fails to start.
- Auto-dispatch never re-selects a ticket whose first attempt linked a finding.
- The lazy planner and the bridge plan the same finding concurrently (409 on plan v1).
