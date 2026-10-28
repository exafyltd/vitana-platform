# VTID-04511 — remove the pre-connect greeting audio bridge (the second voice)

VTID: VTID-04511

## What happened (staging, 2026-09-24, read-only `oasis_events`)

From 16:04 every session of the reporting member started with
`greeting_bridge_sent` (a Polly-synthesized filler phrase, 124 chars) written
to the SSE stream before Nova's own greeting. Nova then greeted over it or cut
it off — two voices from two engines, the second sounding like an old TTS.

- The bridge only runs on the SSE path. The member's tab had latched to SSE
  after WebSocket starts failed (VTID-04512).
- `AWS-STAGE-DEPLOY-GATEWAY.yml` upserted
  `FEATURE_ORB_GREETING_TTS_BRIDGE_ENV=staging-only` on **every** staging
  deploy. Production had the same pin removed after the same double-voice
  incident (VTID-04128); staging never did, so every staging deploy
  re-enabled it.

## Fix

- The bridge is removed from the gateway: no synthesis, no cache read, no
  audio frame, no `greeting_bridge_sent` diag. Nova's greeting is the only
  greeting audio.
- The staging workflow pins the flag to `off` (the flag no longer gates
  anything; the pin keeps the task definition honest).

## Acceptance

AC-1: `orb-live.ts` contains no greeting-bridge synthesis, cache read, send or diag.
TEST: services/gateway/test/services/tts/vtid-04100-greeting-bridge-cache.test.ts

AC-2: The guided-topic lesson audio still plays before the upstream connect (ordering unchanged apart from the removed call).
TEST: services/gateway/test/orb/live/characterization/guided-topic-audio-bridge.characterization.test.ts

AC-3: The staging workflow pins `FEATURE_ORB_GREETING_TTS_BRIDGE_ENV` to `off`; every staging-workflow pin suite and the run-block syntax guard pass.
TEST: services/gateway/test/orb/live/upstream/vtid-04100-prod-greeting-bridge-flag-pinned.test.ts

AC-4 (post-deploy, staging): an SSE session shows no `greeting_bridge_sent` diag and one voice only.
UI: a voice session on https://preview-aws.vitanaland.com with `sessionStorage['vtorb.wsFallback']` set (forces SSE)

## Not changed

The guided-topic lesson audio (VTID-03650) is also Polly; it plays authored
lesson narration on a tapped My Journey topic, not a greeting. Flagged for the
owner's decision, not removed here.
