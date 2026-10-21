# VTID-04602 — specialist voice ack default 6 s
AC-1: SPECIALIST_VOICE_ACK_DEFAULT_MS is 6000; env override clamp unchanged; orb-live tool budget follows (7 s).
TEST: services/gateway/test/vtid-04602-04604-go-live.test.ts
Reason: live staging (VTID-04487) lookups took 2.6–4.7 s; at 4.5 s one run in three answered "I'm checking" instead of the answer.
