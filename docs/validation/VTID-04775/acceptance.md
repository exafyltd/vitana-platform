# VTID-04775 — Jev P1 C1: ORB voice session outcome class, shadow mode

Plan: `docs/JEV-INTEGRATION-PLAN.md` §10.4 C1. Builds on VTID-04754 (shadow framework).

Evidence (plan §10.4 C): 1,231 upstream closes, 72 watchdog fires, and content-filter
closes conflated with idle timeouts (VTID-04124). The rule classifier
(`voice-failure-taxonomy`) names a class for only part of the broken sessions.
C1 asks Jev for an outcome class for every session, from its telemetry only, and
records it next to the rule class.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: New decision `voice_session_outcome` (telemetry, `pii: 'forbid'`, planes internal + system_autopilot, engineering roles): completed / user_left_early / no_engagement / one_way_audio / connection_dropped / model_stalled / looping / failed_to_start plus "needs fix", from counters, the stop reason, provider, language, greeting/reconnect/watchdog/tool-streak flags and the rule class — never a transcript, memory or identity.
  TEST: services/gateway/test/vtid-04775-voice-outcome-gate.test.ts
AC-2: `buildVoiceOutcomeSignals` reads the session by an explicit allow-list (provider, lang, greetingSent, _reconnectCount, responseWatchdogReason, consecutiveToolCalls); transcript turns, identity and memory never reach the signals; a missing or odd session gives empty signals, never a throw.
  TEST: services/gateway/test/vtid-04775-voice-outcome-gate.test.ts
AC-3: Gate `voice_session_outcome` (`JEV_VOICE_SESSION_OUTCOME_MODE`, exact values; anything else off): off and synthetic sessions ask and write nothing; shadow writes one `jev_shadow_decisions` row per session (subject `orb_voice_session`, system_action = rule class or `no_rule_class`). Agreement is written at once when the rules named a mapped class; otherwise `agreed` stays null. A throwing call never throws.
  TEST: services/gateway/test/vtid-04775-voice-outcome-gate.test.ts
AC-4: The gate runs from `dispatchVoiceFailureFireAndForget` after the rule classifier answered, never awaited, never on a duplicate stop report. All six stop dispatches (idle sweep, superseded, SSE connection failed, config missing, WS stop, controller user stop) pass outcome signals; the self-healing dispatch itself is unchanged.
  TEST: services/gateway/test/vtid-04775-voice-outcome-gate.test.ts
  TEST: services/gateway/test/voice-self-healing-adapter.test.ts
AC-5: Both gateways pin `JEV_VOICE_SESSION_OUTCOME_MODE=shadow`, never enforce; generated pins agree.
  TEST: services/gateway/test/vtid-04775-voice-outcome-gate.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/services/jev/jev-decisions.ts (one decision)
- services/gateway/src/services/jev/gates/voice-outcome-gate.ts (new)
- services/gateway/src/services/voice-self-healing-adapter.ts (optional `outcomeSignals`, gate call after dispatch)
- services/gateway/src/routes/orb-live.ts, services/gateway/src/orb/live/session/live-session-controller.ts (pass `outcomeSignals` at the stop dispatches)
- .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml, .github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml (shadow pin)
- services/gateway/src/services/conversation/conversation-flag-pins.generated.ts
- services/gateway/test/vtid-04775-voice-outcome-gate.test.ts
- docs/JEV-INTEGRATION-PLAN.md, docs/validation/VTID-04775/**

## OASIS

OASIS_IMPACT: none new. Each check emits the existing `jev.decision.*` event (source `jev:gate:voice_session_outcome`).

## MERGE_PAYLOAD_PREVIEW

Squash merge to `main` → staging deploy with `JEV_VOICE_SESSION_OUTCOME_MODE=shadow`. No voice behaviour changes: the gate only records.

## Not in this PR

C2 (backstop → defect cluster → finding) and any enforce use of the outcome come later, after the agreement rate is known.
