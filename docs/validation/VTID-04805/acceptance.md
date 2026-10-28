# VTID-04805 — Jev P2 C3: cause of a stalled voice session, shadow mode

Plan: `docs/JEV-INTEGRATION-PLAN.md` §10.4 C3 (P2).

`orb.live.stall_detected` says that a voice session went silent (greeting_timeout, forwarding_no_ack,
audio_stall, response_timeout, text_stall), not why. Production stalled 71 sessions in the 14 days to
2026-10-01; 22 of the 24 forwarding_no_ack stalls had also missed a prewarmed Nova stream, which nothing connects.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: New decision `slow_session_cause` (telemetry, `pii: 'forbid'`, planes internal + system_autopilot, engineering roles): the most likely cause (upstream connection, upstream model, context build, tool call, prompt size, client audio, unknown) and whether it is fixable, from counters and timings only.
  TEST: services/gateway/test/vtid-04805-voice-slow-session.test.ts
AC-2: The session summary is built by an explicit allow-list (stall reason, provider, language, turns, audio counters, prewarm missed, context build time and size, tool catalog bytes, tool calls/failures, upstream close reason, reconnects) — never user ids, transcripts, contact data or the session id.
  TEST: services/gateway/test/vtid-04805-voice-slow-session.test.ts
AC-3: Gate `voice_slow_session` (`JEV_VOICE_SLOW_SESSION_MODE`, exact values; anything else off). Off reads, asks and writes nothing, and the scheduler does not start.
  TEST: services/gateway/test/vtid-04805-voice-slow-session.test.ts
AC-4: Once per UTC day, each of the previous day's stalled sessions of this environment (max 20) gets one `jev_shadow_decisions` row (`subject_type = voice_session`, `system_action = rule:<cause>|rule:none`) with Jev's cause next to the rules' cause and `agreed` where the rules name one; a session already judged is skipped; Jev unavailable → a fallback row; read errors → nothing; never throws.
  TEST: services/gateway/test/vtid-04805-voice-slow-session.test.ts
AC-5: The scheduler starts from `index.ts` in a guarded, non-fatal block; both gateways pin `JEV_VOICE_SLOW_SESSION_MODE=shadow`, never enforce; generated pins agree; the prod task-definition step stays under GitHub's per-step limit.
  TEST: services/gateway/test/vtid-04805-voice-slow-session.test.ts
  TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/services/jev/jev-decisions.ts (one decision)
- services/gateway/src/services/jev/jev-repository.ts (two reads)
- services/gateway/src/services/jev/gates/slow-session-gate.ts (new)
- services/gateway/src/index.ts (scheduler start, guarded)
- .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml, .github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml (shadow pin)
- services/gateway/src/services/conversation/conversation-flag-pins.generated.ts
- services/gateway/test/vtid-04805-voice-slow-session.test.ts
- docs/JEV-INTEGRATION-PLAN.md, docs/validation/VTID-04805/**

## OASIS

OASIS_IMPACT: none new. Each judged session emits the existing `jev.decision.*` event (source `jev:gate:voice_slow_session`), at most 20 per day per environment.

## MERGE_PAYLOAD_PREVIEW

Squash merge to `main` → staging deploy with `JEV_VOICE_SLOW_SESSION_MODE=shadow`. Voice sessions behave exactly as before.

## Not in this PR

Enforce (a Dev Autopilot finding for a fixable cause that repeats) comes after the data.
