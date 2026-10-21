# VTID-04785 — ORB voice session ends and provider selection never recorded

Measured on production `oasis_events` (24 h to 2026-10-01 12:25 UTC, read-only):
117 `vtid.live.session.start`, 34 `vtid.live.session.stop`, zero
`orb.upstream.provider.selected`. Evidence: `outputs/prod-evidence-readonly.txt`.

Root causes:

1. **SSE end path was silent.** `GET /live/stream`'s `req.on('close')`
   (routes/orb-live.ts) finalized memory, closed the upstream and deleted the
   session from `liveSessions` without emitting `vtid.live.session.stop`.
   Because it deletes, the idle sweep and a later `POST /live/session/stop`
   (404) could never report the end either. SSE: 25 of 107 sessions had a
   stop; WS 12 of 12 (its twin was fixed in VTID-03561). 76 of the 82
   stop-less sessions carry `conversation.session.finalized` reason
   `sse_disconnect`, which only this handler writes. The new
   `voice_session_facts` end was missing on the same path.
2. **Every `orb.upstream.*` emit was rejected by the database.**
   `oasis_events.service`, `.status` and `.message` are NOT NULL; the emits
   pass only `{type, vtid, payload}` cast `as any`, so the INSERT failed with a
   not-null violation, `emitOasisEvent` returned `{ok:false}` (it does not
   throw) and the `.catch(() => {})` never saw it. Zero rows ever.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: When an SSE ORB session's EventSource closes, the gateway emits exactly one `vtid.live.session.stop` (transport `sse`, reason `sse_disconnect`, live session id, metrics, surface/role/lang/provider/close_code) before the session is deleted.
  TEST: services/gateway/test/vtid-04785-session-end-telemetry.test.ts
AC-2: The same SSE close records the `voice_session_facts` end (`recordLiveSessionEnd(session, id, 'sse_disconnect')`) exactly once.
  TEST: services/gateway/test/vtid-04785-session-end-telemetry.test.ts
AC-3: Idempotent with every other end path: when `POST /live/session/stop` (or any path) already emitted, the SSE close emits nothing and records nothing; a repeat close cannot double-book; a throwing emit never breaks the socket close callback.
  TEST: services/gateway/test/vtid-04785-session-end-telemetry.test.ts
  TEST: services/gateway/test/orb/live/session/live-session-controller.test.ts
AC-4: Every `liveSessions.delete(` in orb-live.ts and live-session-controller.ts is preceded by a real stop emit (code, not comment) — mutation-verified: removing the SSE wiring fails two tests at orb-live.ts:17066.
  TEST: services/gateway/test/vtid-04785-session-end-telemetry.test.ts
AC-5: `emitOasisEvent` no longer lets an event missing a NOT NULL column (`source`/`status`/`message`) fail silently: it skips the doomed INSERT, returns `{ok:false, error:'missing_required_fields:…'}` and logs one console.error per topic. Nothing is defaulted (that would start landing every other silently-failing topic at an unreviewed volume); complete events are inserted byte-for-byte, an empty string is still accepted.
  TEST: services/gateway/test/vtid-04785-session-end-telemetry.test.ts
AC-6: `orb.upstream.provider.selected` and `.selection_error` pass all three fields explicitly at the call site.
  TEST: services/gateway/test/vtid-04785-session-end-telemetry.test.ts
AC-7: No voice payload changes: VTID-04542 payload identity snapshots unchanged (not updated), role / support / operator regression suites green, full gateway suite green.
  TEST: services/gateway/test/orb/latency/vtid-04542-voice-payload-identity.test.ts
  TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts
  TEST: services/gateway/test/vtid-04456-customer-support-pipeline-regression.test.ts
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/orb/live/session/live-session-controller.ts (new `emitSseDisconnectStop`)
- services/gateway/src/routes/orb-live.ts (SSE close calls it; provider.selected/selection_error required fields)
- services/gateway/src/services/oasis-event-service.ts (`missingOasisRequiredFields`)
- services/gateway/test/vtid-04785-session-end-telemetry.test.ts (new)
- docs/validation/VTID-04785/**

No route, schema, migration or client change.

## Not fixed here (residual, recorded)

- The gateway installs no SIGTERM/SIGINT handler, so sessions live on a task
  that ECS replaces are lost without a stop. No production deploy correlates
  with the 6 residual stop-less sessions in the window, so it is not the
  measured cause; a drain-on-shutdown is a separate change.
- The GET `/orb/live` legacy SSE (`sessions` map, not `liveSessions`) never
  emitted `vtid.live.session.*` events at all; it is not counted in the starts.

## OASIS

OASIS_PROOF: no new topic. `vtid.live.session.stop` is now emitted on the SSE close path (`transport:'sse'`, `reason:'sse_disconnect'`). Every `orb.upstream.*` topic already in `src/types/cicd.ts` (provider.selected, selection_error, canary.*, cascaded.connect_*, nova.*) starts landing; status comes from the caller's payload `status` where present (`success`/`error`), else `info`. Expected on production after PUBLISH: starts ≈ stops per transport, and `orb.upstream.provider.selected` ≈ one per Nova/cascade connect. Asserted in test/vtid-04785-session-end-telemetry.test.ts.
