# VTID-05007 - Production ORB voice on recall() (memory plan §8.4 phase 2)

Owner Gate 1 "yes", 2026-10-09. Sparring: `plan-sparring.md` (converged, 2 rounds).

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: AWS-PROD-DEPLOY-GATEWAY.yml pins MEMORY_ORB_RECALL_ENABLED=true and keeps MEMORY_ORB_RECALL_SHADOW=true (strip-then-add, one jq), staging unchanged.
  TEST: services/gateway/test/vtid-04452-staging-orb-recall-pinned.test.ts
AC-2: The pin is applied before the VTID-03958 env_overrides hatch, so env-only + {"MEMORY_ORB_RECALL_ENABLED":"false"} switches recall off on a running prod.
  TEST: services/gateway/test/vtid-04452-staging-orb-recall-pinned.test.ts
  TEST: services/gateway/test/vtid-03958-env-overrides-input.test.ts
AC-3: The generated workflow-pin mirror is current (prod: "true").
  TEST: services/gateway/test/services/conversation/vtid-04525-conversation-flag-registry.test.ts
AC-4: recall()/shadow behaviour is unchanged by this change (flag semantics exact "true").
  TEST: services/gateway/test/services/memory/recall.test.ts
  TEST: services/gateway/test/services/memory/vtid-04784-recall-shadow.test.ts
AC-5: After PUBLISH (read-only): prod recall-shadow lines show served=recall and '[VTID-04452] orb recall in' lines appear (owner runs scripts/memory/recall-shadow-report.sh /vitana/gateway-awsdr 24; this session has no AWS CLI).
  CURL: GET https://gateway.vitanaland.com/api/v1/admin/build-info reports the promoted commit
