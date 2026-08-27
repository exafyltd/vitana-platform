# VTID-03779 — Nova session pre-establishment ("warm start")

Real staging measurement (VTID-03764) found authenticated ORB voice
sessions pay ~5-8s tap-to-first-audio while anonymous sessions (near-zero
context, a 1-2 tool catalog instead of the full ~390-declaration
authenticated set) land at ~0.7-1.7s. The user explicitly rejected trimming
the authenticated tool catalog to close that gap (real regression risk — a
tool not declared is a tool Nova cannot call) and instead directed: build
the actual cold-start payload (real system instruction, real tool catalog)
in the background, at login time, before the ORB overlay is ever opened —
"make the cold start a warm start... this way process happens in the
background without user noticing and technically it becomes a warm start."

This VTID ships the mechanism end to end: a backend registry that holds an
already-connected Nova client per user_id, a WS `prewarm` message that
builds and connects one with the real authenticated payload, a claim path
inside the existing session-start flow that reuses it instead of cold-
connecting, and the frontend wiring that opens the WS transport and sends
`prewarm` right after login/setAuth — before the ORB overlay is ever shown.

AC-1 — A prewarmed Nova client can be registered, claimed, and its
lifecycle (keepalive, TTL, supersession, dead-on-claim) is correct in
isolation

`services/gateway/src/orb/live/prewarm/nova-session-prewarm.ts` is a plain
in-process registry keyed by user_id. `registerPrewarmedNovaSession` arms a
5s silence keepalive (Bedrock kills a no-audio bidirectional stream after
~15s) and a TTL expiry (default 90s, env-tunable via
`ORB_NOVA_PREWARM_TTL_MS`); `consumePrewarmedNovaSession` pops and returns
the entry, or null (and closes the dead client) if it died between prewarm
and claim.

TEST: `services/gateway/test/orb/live/prewarm/nova-session-prewarm.test.ts`
— 10/10 passing: register-then-claim, claim-with-nothing, dead-on-claim,
supersede-on-second-prewarm, discard, keepalive-fires-then-stops-on-claim,
never-feeds-a-closed-client, TTL-expiry, TTL-no-op-after-claim, invalid-TTL
falls back to default.

AC-2 — A client built before its real session exists can be safely
repointed at that session once it exists

`NovaSonicLiveClient` captures four Nova-specific callbacks
(`onRotationDue`, `onIdleDeadlineApproaching`, `onFirstRawChunk`,
`onEarlyNormalizedEvent`) as constructor-time closures — a genuine
correctness trap for a client constructed by the prewarm path, since the
real `GeminiLiveSession` these closures reference does not exist yet at
that point. `rebindSessionDeps()` repoints all four at claim time; every
other listener (audio/transcript/turnComplete/interrupted/error/close) is
already a plain mutable field, re-registered on every connect via the
pre-existing `bindUpstreamSessionHandlers`, so needs no equivalent fix.

TEST: `services/gateway/test/orb/live/upstream/nova-sonic-live-client.test.ts`
— "repoints onRotationDue so the original constructor-time callback no
longer fires" and "repoints onFirstRawChunk and onEarlyNormalizedEvent so
only the rebound callbacks observe post-claim traffic": both prove the OLD
closure goes dead and the NEW one fires, not merely that the method exists.

AC-3 — The WS `prewarm` message and the session-start reuse branch are
correctly wired inside orb-live.ts

`connectToLiveAPI`'s Nova branch (unexported, un-isolable without a
refactor — same conclusion `orb-live-nova-incident-regressions.test.ts`
already reached for this file) is covered by source-text characterization,
the established pattern this file already uses elsewhere (see
`nova-sonic-voice-fallback.test.ts`'s "the call site no longer uses a bare
?? fallback").

TEST: `services/gateway/test/orb/live/prewarm/orb-live-prewarm-wiring.test.ts`
— 6/6 passing: the WS message union includes `prewarm` and the switch
dispatches it fire-and-forget; `handleWsPrewarmMessage` is gated on
`isFeatureLive('ORB_NOVA_PREWARM')` and bails on no identity / an already-
active session; `connectToLiveAPI` claims by user_id before falling back to
cold connect; the reuse branch calls `rebindSessionDeps` before the session
can rotate/idle/diagnose; a claimed warm connection skips the real
`connect()` call entirely; `reused_warm_start` is threaded into both the
latency mark and the `connect_succeeded` OASIS event.

AC-4 — The frontend opens the WS transport and prewarms it right after
login, before the ORB overlay is shown, and a real session tap reuses it

`orb-widget.js`'s `_prewarmNovaWs()` is called from both `init()` and
`setAuth()` — the exact same lifecycle points the pre-existing
`_prewarmBootstrap()` (context-pack cache warm) already uses. It opens a
WS connection, waits for the server's `connected` handshake, and sends
`{type:'prewarm'}`. `_sessionStartWs` claims that socket (if still open and
ready) instead of opening a fresh one, and sends `start` immediately
instead of waiting for a `connected` message that will not arrive again on
a reused socket. An account switch / logout (`_wipeIdentityBoundState`, the
function `setAuth`'s identity-change branch and `clearAuth` both already
call) closes and clears any existing prewarmed socket and bumps a
generation counter so an in-flight prewarm handshake from the OLD identity
can never be claimed on the NEW identity's behalf.

TEST: `services/gateway/test/frontend/orb-widget-nova-prewarm.test.ts` —
9/9 passing, covering: the no-op guards (anonymous, active session,
already-warm socket); prewarm is only sent after the `connected` handshake;
a closed/errored socket clears its own bookkeeping; the identity-switch
race is closed via the generation counter; `_wipeIdentityBoundState`
tears down any existing prewarmed socket; both call sites (`init`,
`setAuth`) invoke it; `_sessionStartWs` reuses a ready prewarmed socket and
sends `start` immediately; the non-reused (fresh-connect) path is provably
untouched.

AC-5 — The mechanism is fully inert until explicitly enabled, and pinned
to staging only

`handleWsPrewarmMessage` returns immediately unless
`isFeatureLive('ORB_NOVA_PREWARM')` is true. `FEATURE_ORB_NOVA_PREWARM_ENV`
is pinned to `"staging-only"` on `AWS-STAGE-DEPLOY-GATEWAY.yml` (both the
strip list and the re-add list, so a future edit cannot silently drop one
half) and deliberately NOT added to `AWS-PROD-DEPLOY-GATEWAY.yml` — this
needs a real staging measurement against the <3s cold-start / ~1.5s
warm-start targets before prod is a question.

TEST: `services/gateway/test/orb/live/upstream/staging-nova-prewarm-flag-pinned.test.ts`
— 3/3 passing: the flag is upserted as `"staging-only"`; it is stripped
from any inherited value first; it is confirmed absent from the prod
workflow.

## What this VTID deliberately does NOT do

- Does not trim, reorder, or change the authenticated tool catalog or
  system instruction in any way — the prewarmed payload is byte-identical
  to what the cold path already builds and sends.
- Does not change behavior for any session that never prewarms (never
  logged in via a client old enough to send `prewarm`, prewarm expired
  before the tap, prewarm was superseded, the flag is off) — every such
  case falls straight through to the pre-existing, unmodified cold-connect
  path.
- Does not attempt to prewarm the anonymous path — anonymous sessions
  already meet the latency target (VTID-03764 measurement) and have
  nothing expensive to warm.
- Does not promote the feature flag to production. That is a separate,
  later decision gated on a real staging measurement.
- Does not carry personalized memory/brain context into the prewarmed
  system instruction — `buildLiveSystemInstruction` is called with the
  same arguments the existing "context timed out" degraded cold-start path
  already uses (no `bootstrapContext`), not the full wake-brief-decided
  context a normal tap-time connect can build. A user whose real session
  claims a prewarmed connection therefore opens without the
  personalization a slower cold connect would have had. This is an
  accepted, deliberate tradeoff for this VTID — flagged for the user's
  awareness rather than silently shipped, and a candidate follow-up (warm
  the context pack too, at prewarm time, keyed the same way) once the
  latency win itself is confirmed against real traffic.

OASIS_PROOF: this VTID emits real state-transition signals, not polling —
`emitDiag(session, 'nova_warm_start_claimed', { provider, prewarm_age_ms })`
(an `orb.live.diag` event, the existing diagnostic-stage mechanism this file
already uses for every other Nova connect-path branch decision) fires once
per session, exactly when a real session claims a prewarmed connection —
not on a timer, not on every message. `reused_warm_start: boolean` is
additionally threaded into the pre-existing `orb.upstream.nova.connect_succeeded`
event (a field addition, not a new event type) so the connect-success
telemetry this codebase already relies on for latency/rollout analysis
distinguishes a warm claim from a cold connect without a separate query.

## Verification run in this session

- `npx tsc --noEmit -p services/gateway` — clean.
- `node --check services/gateway/src/frontend/command-hub/orb-widget.js` —
  syntactically valid.
- `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml'))"`
  — valid YAML.
- Full gateway suite: 721/722 suites (1 pre-existing skip), 13,516 tests
  passing, 0 failures — see `outputs/full-suite.txt`. Re-run after rebasing
  this branch onto latest `origin/main` (which had since absorbed several
  unrelated merged guided-topic-reconnect fixes touching the same files) —
  the cherry-pick auto-merged cleanly with no conflicts.

**Not yet independently confirmed against live traffic** — the mechanism
has not been deployed. The next step, once this merges and staging picks
it up, is a real Playwright measurement (the same harness VTID-03741/03764
used) comparing a warm-started tap against a cold one on real staging
traffic, reported before any claim that the <3s/<1.5s targets are met.
