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
