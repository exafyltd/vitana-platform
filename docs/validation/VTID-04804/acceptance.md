# VTID-04804 — Jev P2 C2: voice backstop clusters judged as defect candidates, shadow mode

Plan: `docs/JEV-INTEGRATION-PLAN.md` §10.4 C2 (P2).

Every voice backstop firing is the gateway doing something the model should have done itself (a remember the
model claimed without calling the tool, a recall it refused, a held reply it dropped). Production recorded
hundreds in 14 days (remember_hold_dropped/remember_request 116, recall_backstop/denied 49,
remember_backstop/stored_value_echoed 31, …/claimed_without_call 23). Nothing turns those counts into work.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: New decision `backstop_cluster_defect` (telemetry, `pii: 'forbid'`, planes internal + system_autopilot, engineering roles): "is this cluster a recurring defect" and "which kind" (prompt instruction, tool contract, model limitation, expected safety net, detection false positive), from stage, sub-cause, firings, sessions, window and average turns — never transcripts or session ids.
  TEST: services/gateway/test/vtid-04804-voice-backstop-clusters.test.ts
AC-2: Gate `voice_backstop_clusters` (`JEV_VOICE_BACKSTOP_CLUSTERS_MODE`, exact values; anything else off). Off reads, asks and writes nothing, and the scheduler does not start.
  TEST: services/gateway/test/vtid-04804-voice-backstop-clusters.test.ts
AC-3: One UTC day of this environment's backstop diag events is grouped by stage + sub-cause; clusters with at least 3 firings (max 12) are judged; one `jev_shadow_decisions` row per cluster per day (`subject_type = voice_backstop_cluster`, `system_action = no_finding`); a cluster already judged that day is skipped; Jev unavailable → a fallback row; read errors → nothing; never throws.
  TEST: services/gateway/test/vtid-04804-voice-backstop-clusters.test.ts
AC-4: The scheduler starts from `index.ts` in a guarded, non-fatal block; nothing else in the voice path changes (operator pipeline suite and full suite green).
  TEST: services/gateway/test/vtid-04804-voice-backstop-clusters.test.ts
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
AC-5: Both gateways pin `JEV_VOICE_BACKSTOP_CLUSTERS_MODE=shadow`, never enforce; generated pins agree; the prod task-definition step stays under GitHub's per-step size limit.
  TEST: services/gateway/test/vtid-04804-voice-backstop-clusters.test.ts
  TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/services/jev/jev-decisions.ts (one decision)
- services/gateway/src/services/jev/jev-repository.ts (one read)
- services/gateway/src/services/jev/gates/backstop-cluster-gate.ts (new)
- services/gateway/src/index.ts (scheduler start, guarded)
- .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml, .github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml (shadow pin)
- services/gateway/src/services/conversation/conversation-flag-pins.generated.ts
- services/gateway/test/vtid-04804-voice-backstop-clusters.test.ts
- docs/JEV-INTEGRATION-PLAN.md, docs/validation/VTID-04804/**

## OASIS

OASIS_IMPACT: none new. Each judged cluster emits the existing `jev.decision.*` event (source `jev:gate:voice_backstop_clusters`), at most 12 per day per environment.

## MERGE_PAYLOAD_PREVIEW

Squash merge to `main` → staging deploy with `JEV_VOICE_BACKSTOP_CLUSTERS_MODE=shadow`; the first tick judges yesterday's staging backstop clusters (often none on staging). Voice sessions behave exactly as before.

## Not in this PR

Enforce (opening a Dev Autopilot finding for a cluster Jev calls a defect) comes after the data.
