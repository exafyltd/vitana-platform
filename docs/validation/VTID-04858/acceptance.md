# VTID-04858 — orb-agent and verification-engine deploys drop the dead DB_PASSWORD secret reference

Follow-up to VTID-04849 (gateway). The live task definitions `vitana-orb-agent:10` and
`vitana-vitana-verification-engine:7` load `DB_PASSWORD` from the Aurora managed secret `rds!cluster-eba8a4f2-…`,
which no longer exists (`vitana-aurora-prod` has `MasterUserSecret: null`). ECS cannot start a task whose secret is
missing, so a redeploy or a restart of either service's single task would fail with ResourceInitializationError.
Neither service reads `DB_PASSWORD` (no reference under `services/agents/orb-agent` or
`services/agents/vitana-orchestrator`). Both workflows clone the live task definition forward, so the register step's
jq filter now drops it. (`community-app-staging` was the third service on the list; its current revision, 285, no
longer carries the reference — nothing to change.)

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: `AWS-PROD-DEPLOY-ORB-AGENT.yml` and `AWS-PROD-DEPLOY-VERIFICATION-ENGINE.yml` register step removes `DB_PASSWORD` from the cloned task definition, keeps every other secret, sets the new image and strips read-only fields; a task definition with no secrets still works.
  TEST: services/gateway/test/vtid-04858-agent-deploys-drop-dead-db-secret.test.ts
AC-2: Neither service's source reads `DB_PASSWORD`.
  TEST: services/gateway/test/vtid-04858-agent-deploys-drop-dead-db-secret.test.ts

## Scope

SCOPE_ALLOWLIST:
- .github/workflows/AWS-PROD-DEPLOY-ORB-AGENT.yml (register jq filter)
- .github/workflows/AWS-PROD-DEPLOY-VERIFICATION-ENGINE.yml (register jq filter)
- services/gateway/test/vtid-04858-agent-deploys-drop-dead-db-secret.test.ts (new)
- docs/validation/VTID-04858/**

## OASIS

OASIS_IMPACT: none.

## MERGE_PAYLOAD_PREVIEW

Workflow-only. Takes effect on each service's next manual production dispatch.
