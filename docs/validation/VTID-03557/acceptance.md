# VTID-03557 — Acceptance (Nova Sonic "Premature close" — retry + timeout fix)

Scope of THIS PR: gateway-only. Two changes:
1. `services/gateway/src/routes/orb-live.ts` — retry Nova once (fresh HTTP/2
   connection) before VTID-03502's Vertex fallback pins the session away from
   Nova.
2. `services/gateway/src/orb/live/upstream/nova-sonic-config.ts` +
   `nova-sonic-live-client.ts` — separate the `NodeHttp2Handler` stream
   inactivity timeout (was wrongly reusing `connectTimeoutMs`, 15s) from the
   actual connect timeout, defaulting to AWS's own documented 300s.

Root-cause investigation (VTID-03557), evidence gathered from production
`oasis_events` (`orb.live.diag` topic) rather than assumption:
- Every "Premature close" failure carries `code=nova_stream_error`, never
  `nova_stream_timeout` — ruling out `NodeHttp2Handler`'s own `setTimeout`
  path (`node-http2-handler.js` stamps `.name = 'TimeoutError'` on that path,
  which `classifyNovaError` routes to a DIFFERENT typed code).
  `ERR_STREAM_PREMATURE_CLOSE`'s message is exactly "Premature close" and
  originates from Node's `stream.finished()`, indicating the far end (Bedrock
  or a network hop) tore the stream down, not our own code.
- `@smithy/node-http-handler`'s `NodeHttp2ConnectionManager.lease()` skips its
  pooled-session fast path whenever `connectionConfiguration.isEventStream` is
  true (`node-http2-connection-manager.js` L17), which routes to
  `createIsolatedSession()` — a fresh `http2.connect()` per Nova session. A
  retry is therefore not replaying whatever the first attempt hit.
- AWS's own official Node.js sample for this exact API
  (`InvokeModelWithBidirectionalStreamCommand`, docs.aws.amazon.com/nova) sets
  `requestTimeout: 300000` on `NodeHttp2Handler`. Our code had
  `requestTimeout: config.connectTimeoutMs` (15,000ms by default) — a
  connect-scoped value repurposed as the stream's whole-lifetime idle bound.

AC-1 — A Nova stream that dies before any audio (the measured
"Premature close" signature) is retried ONCE with a fresh connection before
Vertex fallback fires
  TEST: services/gateway/test/orb/nova-premature-close-retry.test.ts
        (shouldRetryNovaOnPrematureClose — 8 cases, mirrors the existing
        shouldFallbackToVertexOnNovaClose discriminator)

AC-2 — The retry and the Vertex fallback compose as a two-strike policy: the
retry flag and the fallback flag are independent, so a second consecutive
premature-close still reaches Vertex (no infinite Nova retry loop, no
regression of VTID-03502's existing safety net)
  TEST: same file, "composes with the Vertex fallback as a two-strike policy"
  TEST: services/gateway/test/orb/nova-premature-close-fallback.test.ts
        (unchanged — still passes; `shouldFallbackToVertexOnNovaClose` itself
        was not modified, only gated behind the new retry step at the call
        site)

AC-3 — The retry never fires on a real mid-conversation drop, a locally-
initiated close, a planned rotation, or an inactive session — same
discriminator guarantees as the existing fallback predicate
  TEST: same file, "does NOT fire" cases (audio produced / local close /
        rotation in flight / inactive session) + "requires EVERY condition"

AC-4 — `NodeHttp2Handler`'s stream inactivity timeout is now a dedicated,
independently-configurable value (default 300s, matching AWS's own sample)
instead of borrowing `connectTimeoutMs` (15s)
  TEST: services/gateway/test/orb/live/upstream/nova-sonic-config.test.ts
        ("streamInactivityTimeoutMs defaults to 300s..." and "...is
        env-tunable and invalid values are a typed issue, without affecting
        connectTimeoutMs")

AC-5 — Existing Nova client/config/fallback test suites are unaffected —
scoped, additive change
  TEST: services/gateway/test/orb/live/upstream/nova-sonic-live-client.test.ts
        (63 tests unchanged, all passing)
  TEST: services/gateway/test/orb/nova-premature-close-fallback.test.ts
        (unchanged, all passing)

AC-6 — Gateway suite, typecheck, and build are unaffected
  TEST: npm test (633 suites / 12,314 passing) && npx tsc --noEmit (exit 0)
        && npm run build (exit 0)
  See ./commands.log and ./outputs/ for captured results.

---

## Post-review fixes (automated Codex review, 2 findings, both confirmed real)

**Finding 1 — the discriminator could be defeated by the activation chime.**
Both `shouldFallbackToVertexOnNovaClose` (VTID-03502, already shipped) and
this VTID's `shouldRetryNovaOnPrematureClose` took `audioOutChunks: number`
and checked `=== 0`, backed by `session.audioOutChunks` — a counter also
incremented by orb-live.ts's synthetic "activation chime" (instant-feedback
audio sent to fill the 2-5s gap before real model audio) at 4 send sites
(`flushPrebufferedGreeting`, the SSE connect flow, the WS `audio_ready`
handler, and the WS fallback timer), all BEFORE any real audio, all tagged
`source: 'activation_chime'`. Verified this is a real code path (not merely
theoretical): the chime is gated on the client's `audio_ready` message,
which is independent of upstream (Nova) connection health, so a premature
close landing between connect and chime-dispatch would have read as
"audio produced" and silently defeated BOTH predicates. Measured production
data (15 real failures, 2026-08-01→08-09) showed `audio_out=0` in every
case, meaning the race hadn't yet been observed live — but that is timing
luck, not a code-level guarantee, which is why this needed a real fix
rather than being dismissed as a false positive.

Fix: both predicates' `audioOutChunks: number` parameter is renamed to
`hasProducedAudio: boolean`, and both call sites now pass
`session.transportHasShownLife === true` instead of `session.audioOutChunks`.
`transportHasShownLife` is a pre-existing (Nova item 5, `upstream-message-
handler.ts`), session-wide, never-reset flag set ONLY by genuine upstream
traffic (real model audio, input transcription proving the provider
answered) — never by the chime, which is a pure client-side synthetic send
with no upstream involvement. Same "session-wide, not per-attempt"
semantics as the old `audioOutChunks` check (deliberate — matches
`shouldFallbackToVertexOnNovaClose`'s own "a mid-conversation drop always
has audio out" design intent), just no longer poisonable by synthetic audio.
  TEST: services/gateway/test/orb/nova-premature-close-retry.test.ts +
        nova-premature-close-fallback.test.ts (updated for the renamed
        `hasProducedAudio` field; same 15 cases, same pass/fail expectations)

**Finding 2 — a successful reconnect never re-sent the greeting.**
The measured "Premature close" failure's own signature is
`greeting_sent=true`: the greeting PROMPT was already dispatched to the
dead upstream connection before it closed (`sendGreetingPromptToLiveAPI`
sets `session.greetingSent = true` synchronously on dispatch, not on
confirmed delivery). That function silently no-ops whenever `greetingSent`
is already true (its duplicate-greeting guard). Both this VTID's retry
`.then((ok) => {...})` AND the pre-existing VTID-03502 fallback's
`.then((ok) => {...})` handled `!ok` (reconnect failed outright) but did
nothing on `ok === true` (reconnect succeeded) — so a successful reconnect,
retry or fallback, opened a healthy new upstream connection that then sat
waiting for a greeting that would never be sent, leaving the user in
silence until an unrelated watchdog eventually intervened. This is a
pre-existing gap in the already-shipped VTID-03502 code, not something this
VTID introduced — found while verifying this VTID's own new retry code,
and fixed in both places since they share the exact same bug shape and the
same file/function.

Fix: new `resendGreetingIfStuckAtZeroTurns(session, source)` helper
(mirrors the existing VTID-GREETING-RECOVERY stall-recovery block a few
hundred lines above, which handles the identical "greeting sent but the
conversation never started" case on a different reconnect path — idle-stall
detection — that the premature-close retry/fallback never reaches). Checks
`session.turn_count === 0 && session.greetingSent`, and if so resets
`greetingSent = false` + `greetingTurnIndex = undefined` and re-invokes
`sendGreetingPromptToLiveAPI` on the new upstream connection. Wired into
both the VTID-03557 retry's and the VTID-03502 fallback's `.then((ok) =>
{...})` success branch.
  TEST: not independently unit-tested — `resendGreetingIfStuckAtZeroTurns`
        is a side-effecting internal helper (console.log, emitDiag,
        sendGreetingPromptToLiveAPI), not a pure predicate, matching the
        testability profile of the pre-existing VTID-GREETING-RECOVERY
        block it mirrors (also inline, also not unit-tested in isolation).
        Verified by direct code reading against the exact production
        failure signature (greeting_sent=true, turn_count=0) recorded in
        this file's root-cause section above.

  RE-VERIFICATION: npm test (633 suites / 12,314 passing, same counts as
  AC-6 — additive change, no regressions) && npx tsc --noEmit (exit 0) &&
  npm run build (exit 0). See ./commands.log (updated) for the re-run.

---

No new route is mounted by this change — `services/gateway/src/routes/orb-live.ts`
is touched only inside the existing Nova upstream connect/close handling for
the already-mounted WS session path. Recorded per the Route Mount Evidence
Gate, which fires on any change under `services/gateway/src/routes/**`
regardless of whether a route was added:

ROUTE_MOUNT: services/gateway/src/routes/orb-live.ts — no new router.*() call
added; `attachOrbLiveWebSocketServer` (already mounted, unchanged mount site)
FINAL_URL: wss://{gateway}/api/v1/orb/live/ws (pre-existing, unchanged)
CURL_PROOF: N/A — no new HTTP endpoint; behavior change is internal to the
Nova WS upstream close handler and is verified by the unit tests in AC-1/AC-2
above, not by a curl against a route.

OASIS_PROOF: new `orb.upstream.nova.premature_close_retry` event type,
emitted from the new retry branch in `orb-live.ts`'s Nova `onClose` handler
(mirrors the existing `orb.upstream.nova.premature_close_fallback` event
VTID-03502 already emits on the fallback path). Fired via `emitOasisEvent()`
with `session_id`, `provider: 'nova_sonic'`, `reason`, `status: 'warning'` —
same shape/telemetry pattern as the neighboring fallback event so both can be
compared on the same dashboard (retry-succeeded-silently vs.
had-to-fall-back-to-Vertex).
