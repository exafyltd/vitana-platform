# VTID-04849 — production gateway tasks could not start: drop the dead DB_PASSWORD secret reference

2026-10-02, AWS-PROD-DEPLOY-GATEWAY run 37010010196 (promote 32fac4d): the new revision (142) never started, and the
automatic rollback to 141 did not either — 7 failed placements, each
`ResourceInitializationError: unable to retrieve secret from asm … rds!cluster-eba8a4f2-… ResourceNotFoundException`.
Every production task definition loaded `DB_PASSWORD` from that Aurora managed secret; `vitana-aurora-prod` no longer
has a managed master secret (`MasterUserSecret: null`), so the secret is gone. The single running task booted
2026-10-01 23:49 UTC, before that, and kept serving — but no new task (deploy, rollback, restart) could start.
The gateway source never reads `DB_PASSWORD`.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: New step "Build task-definition (drop dead secret refs)" runs in every deploy mode after the Jev step and before step 2/2 (register + roll); it removes `DB_PASSWORD` from the cloned task definition's secrets and keeps every other secret.
  TEST: services/gateway/test/vtid-04849-prod-deploy-drops-dead-db-secret.test.ts
AC-2: No workflow step adds `DB_PASSWORD` back or references the deleted `rds!cluster` secret; the gateway source never reads `DB_PASSWORD`.
  TEST: services/gateway/test/vtid-04849-prod-deploy-drops-dead-db-secret.test.ts
AC-3: Every prod-workflow suite still passes; step 1/2 (19,951) and step 2/2 (17,531) unchanged in size, under the 20,000-char run limit.
  TEST: services/gateway/test/vtid-04754-jev-prod-workflow.test.ts

## Scope

SCOPE_ALLOWLIST:
- .github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml (one new step)
- services/gateway/test/vtid-04849-prod-deploy-drops-dead-db-secret.test.ts (new)
- docs/validation/VTID-04849/**

## OASIS

OASIS_IMPACT: none.

## MERGE_PAYLOAD_PREVIEW

Workflow-only. The next production deploy registers a task definition without `DB_PASSWORD`; all 12 other secrets were
checked to exist (read-only `describe-secret`). No runtime change: nothing in the gateway reads the variable.
