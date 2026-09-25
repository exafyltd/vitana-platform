# VTID-04542 — ORB voice latency plan (P0 + A–L)

Owner ask (2026-09-25): lower ORB voice latency for the first-day greeting,
the returning user, ongoing turns and role switches, across the mobile app,
desktop and the Command Hub, and change nothing else about the conversation
or memory.

One PR, one VTID per workstream:

| VTID | Stream | Default |
|---|---|---|
| VTID-04542 | P0 telemetry + the byte-identity guardrail suite | on (measurement only) |
| VTID-04543 | A — SSE send path: per-session identity, tenant cache, active-day throttle | on |
| VTID-04544 | B — greeting reads run concurrently; skipped when a support report / tapped topic wins | on |
| VTID-04545 | C — session start: identity ‖ client context ‖ quota, shared reads, dead reads removed | on |
| VTID-04546 | D — LLM router telemetry is fire-and-forget | on |
| VTID-04547 | E — widget opens the socket while continuity loads | on |
| VTID-04548 | F — brain-cache warm for the role + timezone the next session uses; re-warm after a role switch | on |
| VTID-04549 | G — Devon pre-connect during the bridge sentence | `ORB_DEVON_PRECONNECT_ENABLED` (staging) |
| VTID-04550 | H — cascade speaks sentence by sentence | `ORB_CASCADE_STREAMING_ENABLED` (staging) |
| VTID-04551 | I — reconnect-recovery prompt restated positively (content-filter blocks) | on |
| VTID-04552 | J — mobile playback lead on the first burst only | `ORB_MOBILE_LEAD_FIRST_ONLY_ENABLED` (staging) |
| VTID-04553 | K — brief acknowledgement before a slow tool | `ORB_TOOL_ACK_INTENT_ENABLED` (staging) |
| VTID-04554 | L — audio_ready always sent; prewarm claimed only on an exact envelope match | ack on; `ORB_PREWARM_FULL_CONTEXT_ENABLED` off everywhere |

Flags are exact-`true`, pinned on `AWS-STAGE-DEPLOY-GATEWAY.yml` only.
Production workflow is not touched.

## Guardrail — nothing else in the conversation changed

`test/orb/latency/vtid-04542-voice-payload-identity.test.ts` drives the real
`connectToLiveAPI` and records, for nine scenarios (anonymous de, first day,
returning, Devon, admin surface, Command Hub, guided topic, cascade ru,
Serbian bridge), exactly what the voice provider receives at connect:
instruction, tool list + bytes, voice. It also records every greeting rung's
directive and every per-turn and session-start write. Snapshots were
recorded on `main` (1e09f77) before any stream merged and pass unchanged on
the integrated branch after every merge.

## Acceptance criteria

AC-1: What the voice model receives at connect, the greeting directives and the per-turn / session-start writes are byte-identical to main.
TEST: services/gateway/test/orb/latency/vtid-04542-voice-payload-identity.test.ts

AC-2: Turn-0 latency carries greeting_dispatched, the three wait marks, session-start steps, entry/surface/role/prewarm; hand-off timing is emitted; POST /api/v1/orb/live/client-latency records voice.latency.client and never 5xx.
TEST: services/gateway/test/orb/live/vtid-04542-latency-p0.test.ts
TEST: services/gateway/test/orb/live/vtid-04542-client-latency-route.test.ts
TEST: services/gateway/test/orb/live/session/vtid-04542-latency-wiring.test.ts
TEST: services/gateway/test/orb/live/prewarm/vtid-04542-prewarm-miss-reason.test.ts

AC-3: An SSE session's mic frames resolve identity once per session; the tenant lookup is cached; the active-day write happens once per user per day; a mismatched user is still resolved, logged and allowed.
TEST: services/gateway/test/orb/live/session/vtid-04543-sse-send-identity-cache.test.ts
TEST: services/gateway/test/services/guide/vtid-04543-active-day-throttle.test.ts

AC-4: The greeting ledger runs concurrently with the overview gather; the decision is deep-equal to the serial code across 10 fixtures x 8 read outcomes; nothing is gathered when a support report / tapped topic wins.
TEST: services/gateway/test/services/conversation/vtid-04544-greeting-payload-gather.test.ts

AC-5: Session start overlaps identity, client context and the quota gate; the response body, session fields and writes are unchanged.
TEST: services/gateway/test/orb/live/session/vtid-04545-session-start-characterization.test.ts

AC-6: callViaRouter never waits for its telemetry inserts; payloads, trace linking and cost are unchanged.
TEST: services/gateway/test/vtid-04546-llm-router-telemetry-nonblocking.test.ts

AC-7: The widget opens the socket while continuity loads and sends a byte-identical start frame.
TEST: services/gateway/test/frontend/orb-widget-ws-early-open.test.ts

AC-8: The prewarm warms the brain-cache key the next session start reads (role from the route, timezone in the key); the widget sends route + timezone and exposes VitanaOrb.prewarm() for a role switch.
TEST: services/gateway/test/orb/live/prewarm/vtid-04548-prewarm-brain-role.test.ts
TEST: services/gateway/test/frontend/orb-widget-role-prewarm.test.ts

AC-9: Devon's stream is pre-connected only with the flag on, and used only when instruction, tools and voice are byte-identical to the swap's own envelope; flag off is unchanged.
TEST: services/gateway/test/orb/live/session/vtid-04549-persona-preconnect.test.ts
TEST: services/gateway/test/orb/live/session/vtid-04549-persona-preconnect-wiring.test.ts

AC-10: With the flag on the cascade sends each sentence's audio as soon as it is synthesized, keeps the mic gated for the whole reply, and speaks the same words; flag off is one TTS call as before (Polly ru, Fish sr).
TEST: services/gateway/test/orb/live/upstream/cascaded-streaming.test.ts
TEST: services/gateway/test/orb/live/upstream/cascaded/sentence-pipeline.test.ts

AC-11: The reconnect-recovery prompt carries zero negative imperatives for every stage and keeps every behavioural clause (no hardcoded spoken sentence).
TEST: services/gateway/test/services/conversation/vtid-04124-greeting-prohibition-stack.test.ts
TEST: services/gateway/test/orb/live/characterization/no-hardcoded-spoken-wording.test.ts

AC-12: The mobile playback lead applies to the first burst only when the server declares it; off omits the field from every handshake.
TEST: services/gateway/test/frontend/orb-widget-mobile-lead-first-only.test.ts
TEST: services/gateway/test/orb/live/vtid-04552-playback-lead-server.test.ts

AC-13: The tool-acknowledgement intent is added only with the flag on, as intent (no quoted sentence), and never changes which sections the instruction budget trims.
TEST: services/gateway/test/orb/live/instruction/vtid-04553-tool-ack-intent.test.ts

AC-14: audio_ready is always sent (bounded wait for a resuming context); a prewarmed stream is claimed under ORB_PREWARM_FULL_CONTEXT_ENABLED only on an exact fingerprint match.
TEST: services/gateway/test/frontend/orb-widget-audio-ready-always.test.ts
TEST: services/gateway/test/orb/live/prewarm/vtid-04554-prewarm-parity.test.ts

AC-15: The client latency beacon posts once per tap cycle with the documented marks.
TEST: services/gateway/test/frontend/orb-widget-latency-beacon.test.ts

## Not claimed

- No live latency number is claimed here. Staging measurement (voice.latency.measured
  + voice.latency.client) is the next step after merge.
- ORB_PREWARM_FULL_CONTEXT_ENABLED stays off: the session instruction carries render
  time, so a login prewarm almost never matches; enabling it would only remove the
  blind claim's latency gain.

## Route evidence (new route: the client latency beacon)

ROUTE_MOUNT: `router.post('/live/client-latency', optionalAuth, handleClientLatencyBeacon)` in services/gateway/src/routes/orb-live.ts; the router is mounted at `/api/v1/orb` (services/gateway/src/index.ts, `mountRouterSync(app, '/api/v1/orb', orbLiveRouter)`).
FINAL_URL: POST https://preview-aws-gateway.vitanaland.com/api/v1/orb/live/client-latency (staging).
CURL_PROOF: before merge the route exists only on this branch, so the proof is the supertest suite against the real router (services/gateway/test/orb/live/vtid-04542-client-latency-route.test.ts): 204 on a valid body, 400 on an invalid one, 413 over 4 KB, JSON bodies, never 5xx. After the staging deploy the real curl against FINAL_URL is recorded in outputs/staging-curl.txt.
