# VTID-04474 — Orchestrator enabled on staging + live staging verification

The support specialist, the commerce specialist and delegation persistence
(`agent_runs`) were documented as staging-pinned, but the live staging task
definition (`vitana-gateway:557`, read 2026-09-24) carried none of them, so
they had never run anywhere. This pins them on the staging deploy workflow
only. Production is untouched. Run leases stay off (their migration is not
applied).

## Acceptance criteria

AC-1: the three flags are stripped and re-added as exact "true" on the staging workflow.
TEST: services/gateway/test/vtid-04474-staging-orchestrator-flags.test.ts
AC-2: the prod gateway workflow declares none of them.
TEST: services/gateway/test/vtid-04474-staging-orchestrator-flags.test.ts
AC-3: run leases are not enabled on staging.
TEST: services/gateway/test/vtid-04474-staging-orchestrator-flags.test.ts
AC-4: the staging deploy workflow still passes the bash-syntax and run-block size guards.
TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts

Live staging verification (voice sessions as the test user, rows deleted
afterwards on the owner's instruction) is recorded in `outputs/` after deploy.
