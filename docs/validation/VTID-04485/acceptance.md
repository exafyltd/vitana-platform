# VTID-04485 — specialist voice ack window

AC-1: On voice, ask_support_specialist / ask_commerce_specialist wait 4.5 s by default — above the 3.0 s support-specialist latency measured live on staging (VTID-04474).
TEST: services/gateway/test/vtid-04485-specialist-voice-ack-window.test.ts

AC-2: Other channels, and the operator hand-off on voice, keep the dispatcher's own ack windows (voice 1.5 s).
TEST: services/gateway/test/vtid-04485-specialist-voice-ack-window.test.ts

AC-3: ORCHESTRATOR_SPECIALIST_VOICE_ACK_MS overrides, clamped to 1.5–8 s; an invalid value falls back to the default.
TEST: services/gateway/test/vtid-04485-specialist-voice-ack-window.test.ts

AC-4: A support answer that takes 3 s is returned in the same tool call (spoken in the same turn), not deferred to get_delegation_result.
TEST: services/gateway/test/vtid-04485-specialist-voice-ack-window.test.ts
