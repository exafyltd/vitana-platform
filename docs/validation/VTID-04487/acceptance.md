# VTID-04487 — specialist voice tools are not cut off by the 3 s tool budget

AC-1: ask_support_specialist and ask_commerce_specialist get their own voice tool budget in orb-live (SPECIALIST_VOICE_TOOLS), so the VTID-04485 ack window actually applies.
TEST: services/gateway/test/vtid-04485-specialist-voice-ack-window.test.ts

AC-2: The budget is max(3 s, specialistAckWindowMs('voice') + 1 s) — always above the ack window, never below the old flat 3 s.
TEST: services/gateway/test/vtid-04485-specialist-voice-ack-window.test.ts

AC-3: No other voice tool's budget changes; the voice/orb, delegation and support suites stay green.
TEST: services/gateway/test/vtid-04456-customer-support-pipeline-regression.test.ts
