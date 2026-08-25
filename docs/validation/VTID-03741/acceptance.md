# VTID-03741 — ORB voice latency reduction (Phase 0-2)

User-reported: ORB voice takes 6-8s from tap to first audible word;
requirement is <3s cold-start / <1.5s warm-start. This VTID covers the
investigation + the first three phases of the staged plan the platform
owner approved. Phase 3 (promote `FEATURE_ORB_SAFE_FAST_GREETING` to prod)
and Phase 4 (retune `CONTEXT_READY_GATE_TIMEOUT_MS`) are deliberately NOT
part of this change — both need real staging telemetry (enabled by Phase 0
here) to make safely, and this session has no AWS/admin access to observe
that data. See the CHANGE LOG entry in CLAUDE.md for the full narrative.

AC-1 — Real click-to-first-audio telemetry is enabled on staging

`services/gateway/src/orb/live/latency-tracker.ts`'s `LatencyTracker`
already existed (`voice.latency.measured` OASIS events, marking
`upstream_connected`/`context_awaited`/`setup_sent`/`greeting_sent`/
`audio_out_first_chunk`) but self-gates on `isFeatureLive('LATENCY_TELEMETRY')`,
which resolves to `off` whenever `FEATURE_LATENCY_TELEMETRY_ENV` is unset —
and it was unset on BOTH the AWS staging and prod gateway task defs (grepped
directly, zero matches in either deploy workflow before this change), so the
tracker has been a no-op the whole time it existed.

TEST: `services/gateway/test/orb/live/upstream/staging-latency-telemetry-flag-pinned.test.ts`
CURL: N/A — config-only change, verified by reading the deploy workflow and
by the pinning test above; live confirmation is the next staging deploy's
`oasis_events` carrying `voice.latency.measured` rows.

AC-2 — The wake-brief candidate ranker runs providers in parallel, not sequentially

`decideContinuation()` ran its ~10 registered providers in a plain
`for...of` loop with `await` inside — strictly sequential, on the critical
path gating Nova/Vertex session setup via `contextReadyPromise`. Each
provider is already isolated (never throws upward, own independent read)
and selection is priority-based, not first-to-finish, so concurrency only
changes latency, not the winner.

TEST: `services/gateway/test/services/assistant-continuation/decide-continuation.test.ts`
— `describe('VTID-03741 parallel ranker', ...)`.

Replaced the loop with `Promise.all` over a new `invokeProviderWithTimeout`
wrapper (`DEFAULT_PROVIDER_TIMEOUT_MS`, default 800ms, env-tunable via
`WAKE_BRIEF_PROVIDER_TIMEOUT_MS`) so a hung provider can no longer stall the
whole decision — previously unbounded. Tests: concurrent wall-time proof
(5×40ms providers finish in <150ms, would be ~200ms serial), hung-provider
timeout bound, completion-order-independent selection. All 46 pre-existing
tests in this file pass unchanged.

AC-3 — Two load-bearing fast-start/cache flags are pinned on staging, matching prod

`FEATURE_ORB_FAST_START_ENV` and `FEATURE_ORB_BRAIN_CACHE_ENV` are pinned on
`AWS-PROD-DEPLOY-GATEWAY.yml` (VTID-03504) with measured prod evidence (9.5s
cold-start hang without fast-start; brain-build p50 degrading to
17.4s/119.7s max without the cache) but were never set anywhere in
`AWS-STAGE-DEPLOY-GATEWAY.yml` — confirmed by reading the file.

TEST: `services/gateway/test/orb/live/upstream/staging-fast-start-brain-cache-flags-pinned.test.ts`
— also asserts staging and prod carry the identical value.

Whatever staging's task def actually ran for these two flags before this
change is undetermined from this repo (inherited from whatever a manual
edit or earlier build left) — the "config that exists only in live AWS
state" shape VTID-03513 already cost four days for elsewhere. Pinned both
to the same `staging+prod` value prod already runs; this session has no
AWS/admin credentials to confirm current live staging state first, so this
is a recorded judgment call, not a confirmed measurement: both flags are
pure deferral/caching mechanisms already proven safe in prod for weeks, and
staging exists specifically to catch a regression before prod.

## Deliberately NOT done in this VTID

- **Phase 3** (promote `FEATURE_ORB_SAFE_FAST_GREETING` to prod): still
  staging-only. Promoting it needs someone to observe it working correctly
  on staging first (a user-facing spoken-content change, not a pure
  timing/caching change like AC-3's flags) — this session cannot watch live
  staging traffic.
- **Phase 4** (retune `CONTEXT_READY_GATE_TIMEOUT_MS`): the current default
  (4000ms) already sits close to the ~4.4s uncached brain-build cost;
  lowering it blind, before AC-1's telemetry produces a real distribution,
  risks truncating legitimately-slow-but-necessary context builds rather
  than helping. Needs the AC-1 data first.
- **Phase 5** (Polly Bidirectional Streaming API for guided-topic
  narration): larger, separate lift, out of scope for this pass.
