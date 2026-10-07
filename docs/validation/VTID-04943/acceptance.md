# VTID-04943 — the WebSocket voice transport records the audio-ready handshake

VTID: VTID-04943
VALIDATION_PROFILE: gateway_backend

## Problem
Morning check row 16 (ORB session-state health) has been red since 2026-10-05: 132 session
starts in 24h, 0 `orb.session.audio_ready.acked` events. The last ack was 2026-10-04 07:28:34Z,
ten minutes after VTID-04866 moved production voice to the WebSocket transport. The widget sends
`audio_ready` in-band on WS; the WS handler released the greeting but recorded nothing. Only the
HTTP `POST /orb/session/:id/audio-ready` route wrote the ack. No other event showed whether a
greeting was released by the handshake or by the fallback timer.

## Change
- `recordAudioReadyAck()` in `services/orb/orb-session-state.ts`: the `audio_ready_ack` state
  write plus the `orb.session.audio_ready.acked` event, with `transport` (and on WS `greeting`)
  added to the payload. `ok` is kept for `ci_orb_session_state_health()`. The emitter is
  injected and fire-and-forget; it never throws.
- The HTTP route uses it (`transport: 'http'`); its responses are unchanged.
- The WS `audio_ready` calls it after the greeting branch, without waiting, only for an
  identified user, with `greeting: deferred_sent | prebuffer_flushed | already_released`.
- No change to the health RPC, thresholds, widget or transport choice.

## Acceptance criteria
AC-1: the helper writes the ack row and emits the event with transport/greeting; it records
nothing for anonymous callers or without a database; a failed write still emits with ok:false;
it never throws. Both transports call it; WS after the greeting branch, never awaited.
TEST: services/gateway/test/vtid-04943-orb-ws-audio-ready-ack.test.ts

AC-2 (after PUBLISH, read-only): `ci_orb_session_state_health()` reports acks_24h > 0 and
morning check row 16 passes.
CURL: GET https://gateway.vitanaland.com/api/v1/admin/build-info -> the published commit; row 16 of MORNING-SYSTEM-HEALTH-CHECK.yml then reads acks_24h
