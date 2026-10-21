# VTID-04817 — Jev P3 C4: voice opener / next-step outcome learning, shadow mode

Plan: `docs/JEV-INTEGRATION-PLAN.md` §10.4 C4 (P3).

Every voice session starts with an opener (`greeting_sent`: the wake opener and the next-step candidate it offers).
Nobody compares them. 14 days to 2026-10-01 (production): conv_resume + wake_brief 436 sessions, 9% engaged
(≥ 2 member turns); resume_thread + wake_brief 63%; conv_resume + next_step 21%; conv_resume + feature_discovery 9%.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: New decision `opener_effectiveness` (telemetry, `pii: 'forbid'`, planes internal + system_autopilot, engineering roles): is the opener working, and keep / reword / reposition / drop / too little data — from counts only (sessions, finalized, engaged share, average member turns and duration, overall engaged share, window).
  TEST: services/gateway/test/vtid-04817-voice-opener-outcomes.test.ts
AC-2: Openers of this environment are joined to their sessions' `conversation.session.finalized` counts, one per session, grouped by opener + candidate kind; engaged = ≥ 2 member turns; no member id or any session content leaves the join.
  TEST: services/gateway/test/vtid-04817-voice-opener-outcomes.test.ts
AC-3: Gate `voice_opener_outcomes` (`JEV_VOICE_OPENER_OUTCOMES_MODE`, exact values; anything else off). Off reads, asks and writes nothing and the scheduler does not start. Once per UTC day, the 7 days to the day's end; groups with ≥ 10 sessions (max 12) get one `jev_shadow_decisions` row per day (`subject_type = voice_opener`, `system_action = opener_unchanged`); agreement at once against the rule (under 70% of overall engagement); a group already judged that day is skipped; Jev down → fallback row; read errors → nothing; never throws.
  TEST: services/gateway/test/vtid-04817-voice-opener-outcomes.test.ts
AC-4: The scheduler starts from `index.ts` in a guarded, non-fatal block; both gateways pin `JEV_VOICE_OPENER_OUTCOMES_MODE=shadow`, never enforce; generated pins agree; the prod task-definition step stays under GitHub's per-step limit.
  TEST: services/gateway/test/vtid-04817-voice-opener-outcomes.test.ts
  TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/services/jev/jev-decisions.ts (one decision)
- services/gateway/src/services/jev/jev-repository.ts (one read)
- services/gateway/src/services/jev/gates/opener-outcome-gate.ts (new)
- services/gateway/src/index.ts (scheduler start, guarded)
- .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml, .github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml (shadow pin)
- services/gateway/src/services/conversation/conversation-flag-pins.generated.ts
- services/gateway/test/vtid-04817-voice-opener-outcomes.test.ts
- docs/JEV-INTEGRATION-PLAN.md, docs/validation/VTID-04817/**

## OASIS

OASIS_IMPACT: none new. Each judged group emits the existing `jev.decision.*` event (source `jev:gate:voice_opener_outcomes`), at most 12 per day per environment.

## MERGE_PAYLOAD_PREVIEW

Squash merge to `main` → staging deploy with `JEV_VOICE_OPENER_OUTCOMES_MODE=shadow`. Voice sessions and openers are unchanged.

## Not in this PR

Changing openers is a product decision after the data; there is no enforce behaviour.
