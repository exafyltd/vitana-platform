# VTID-04943 — plan sparring record

Change class: standard. Partner: plan-sparring-partner (read-only). Rounds: 2. Verdict: CONVERGED.
Plan hash (sha256 of the text between the plan markers): `52db5d275087d220b7ba5000c9db611bfed26b7e51ca6b0f9191e453758d0865`
Owner approval: 2026-10-07, in the Claude Code session ("Yes"), before the VTID was allocated.

# Plan: the WebSocket voice transport records the audio-ready handshake again

Change class: standard (gateway runtime code)
Scope: `services/gateway/src/routes/orb-live.ts` (WS `case 'audio_ready'` and the HTTP
`POST /session/:id/audio-ready` route), `services/gateway/src/services/orb/orb-session-state.ts`
(new helper next to `writeOrbSessionState`), a new jest test, `docs/validation/<VTID>/**`.

<!-- plan:begin -->
## Problem
Morning check row 16 (ORB session-state health) has been red since 2026-10-05: in the last 24h
132 session starts (`orb.session.identity.resolved`) against 0 `orb.session.audio_ready.acked`
events (`ci_orb_session_state_health()`, migration 20260804080000_vtid_03486_ci_health_rpcs.sql:72).
The last ack before the outage was 2026-10-04 07:28:34Z.

Cause: commit cbbd963de (VTID-04866, merged 2026-10-04 07:18Z, owner decision) moved production
voice to the WebSocket transport. The widget sends `audio_ready` in-band on WS
(`orb-widget.js` `_signalAudioReady`, ~line 2007) and only falls back to
`POST /api/v1/orb/session/:id/audio-ready` when there is no open socket. Only that HTTP route
(`orb-live.ts` ~16331) writes the `audio_ready_ack` orb_session_state row and emits the
`orb.session.audio_ready.acked` OASIS event. The WS handler (`orb-live.ts` ~18010,
`case 'audio_ready'`) releases the deferred/pre-buffered greeting but records nothing. No other
event distinguishes a greeting released by `audio_ready` from one released by the fallback timer
(checked `orb.live.diag` stages over 24h), so today nobody can tell whether the handshake works
for members.

## Change
1. Extract the HTTP route's recording into one helper in `orb-session-state.ts` (which already
   owns the `audio_ready_ack` key and `writeOrbSessionState`):
   `recordAudioReadyAck({ supabase, userId, sessionId, transport, greeting?, emit })`. It does the
   `writeOrbSessionState(..., 'audio_ready_ack', {session_id, ready_at}, 10)` write, then calls the
   injected `emit` (orb-live passes its existing `emitOasisEvent`, so the module gains no new
   import) with the same vtid/type/source/status/message as today. The payload keeps `session_id`,
   `user_id`, `ok`, `reason` unchanged, because `ci_orb_session_state_health()` and
   ALERT-ORB-SESSION-STATE-HEALTH.yml read `ok`. It adds `transport: 'http' | 'ws'`. Null
   `supabase` or a missing user returns early with `{ ok:false, reason }`. Any throw, from the write
   or the emit, is caught, so it never throws.
2. HTTP route calls the helper with `transport: 'http'`. Behaviour and response unchanged.
3. WS `case 'audio_ready'` calls the helper with `transport: 'ws'`, fire-and-forget, AFTER the
   existing greeting release logic, only when the session has an identified user (same rule as the
   HTTP route: anonymous sessions record nothing). It must not delay or alter the greeting release.
4. Add to the WS payload which branch the `audio_ready` hit: `greeting: 'deferred_sent' |
   'prebuffer_flushed' | 'already_released'`. `already_released` means the greeting was not
   waiting on this ack, either because the fallback timer had already released it or because it
   was never deferred. It is telemetry only, and the ratio of `already_released` to the other two
   shows how often the fallback beats the handshake.
5. No change to the health RPC, the check's thresholds, the widget, or the transport choice.

## Verification
- Jest: the helper writes the state row and emits the event with `transport`; it swallows a write
  failure. The WS handler calls it once per `audio_ready` with the session's user and session id,
  after the greeting branch, and never for an anonymous session; the HTTP route still returns the
  same body. Existing ORB suites stay green.
- The jest suite is the binding pre-merge gate: helper (null supabase, write failure, emit
  failure), WS call once per `audio_ready` after the greeting branch and never for anonymous, HTTP
  body unchanged.
- Staging (read-only, per rule 48): no suite opens a voice session. staging-tests.json carries the
  jest suite. A read-only query of `oasis_events` for `transport: ws` acks from real staging
  sessions is best-effort evidence only.
- Production, after PUBLISH (owner's yes): read-only `ci_orb_session_state_health()` shows
  acks_24h > 0 and the morning check's row 16 turns green. If acks stay 0 while sessions start,
  that is a real handshake failure and gets its own investigation.
<!-- plan:end -->

## Planner responses (round 1)
- F1 ACCEPTED. The helper lives in `orb-session-state.ts`. To avoid a new import there, `emit` is injected (orb-live passes `emitOasisEvent`). This also answers Q1: the test passes a jest.fn, with no module mocking.
- F2 ACCEPTED. Null supabase or a missing user returns early; write and emit failures are caught. All are pinned in the test.
- F3 ACCEPTED. Jest is the binding gate; the staging query is best-effort; production `ci_orb_session_state_health()` is the final confirmation.
- F4 ACCEPTED. Renamed to `already_released` and documented as "fallback timer or never deferred". Splitting it would need new state; the ratio is enough for diagnosis.
- Q2: the consumers (`ci_orb_session_state_health()`, migration 20260804080000:97-102, and ALERT-ORB-SESSION-STATE-HEALTH.yml:85) read only `topic` and `ok`. `ok` is kept; the new fields are additive JSONB.

## Partner round 1 (summary of findings)
F1 [minor] helper placement → put it in orb-session-state.ts. F2 [minor] null supabase in the WS context. F3 [minor] staging check is probabilistic. F4 [minor] already_sent label conflates two states. Verdict CONVERGED.

## Partner round 2
F1–F4 closed. No new findings. Verdict CONVERGED.
