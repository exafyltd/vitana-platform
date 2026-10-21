# VTID-03723 — remove Vertex as an ORB voice routing destination

Reported live, repeatedly: "Polish and Portuguese still speak English with
Polish/Portuguese accent." Root-caused to `selectUpstreamProvider()` still
treating `provider: 'vertex'` as a valid destination in 11 return sites —
staging's `voice.active_provider='vertex'` short-circuited every pre-login
session to the dead Gemini live client before Nova or the Polly cascade were
ever consulted. Confirmed live via `/api/v1/orb/health` reporting
`model: gemini-2.0-flash-exp`, and via zero historical
`orb.upstream.cascaded.*` events despite the cascade being built and tested
across three prior VTIDs (03683/03720/03721/03722).

Standing rule (CLAUDE.md IF-THEN 27): "There is no sanctioned Google
dependency left at all... do not reintroduce a Google call anywhere." Vertex
is removed as a routing destination entirely, not merely deprioritized.

---

AC-1 — `selectUpstreamProvider()` never returns `provider: 'vertex'`, for any input

TEST: `services/gateway/test/orb/live/upstream/upstream-provider-selector.test.ts` —
"invariant: across a broad matrix of contexts, provider is never vertex" (13 distinct contexts)
TEST: same file — every one of the 11 individually-rewritten test cases (env-explicit
rollback, system_config default, unknown-provider, LiveKit degradation x3, Nova-gate
degradation x3, Nova-canary degradation x2)
Output: outputs/targeted-tests.txt

AC-2 — the exact reported staging configuration routes to the cascade, not Vertex

TEST: same file — "reproduces the exact reported staging configuration:
active_provider=vertex + a Polish/Portuguese session → cascade, never Nova
speaking English, never Vertex"
TEST: same file — "the same configuration WITHOUT the cascade enabled forces
Nova rather than falling back to Vertex"
Output: outputs/targeted-tests.txt

AC-3 — `vertexUnavailable` (`VERTEX_LIVE_UNAVAILABLE`) is no longer a precondition
for the fix — every gate forces off Vertex regardless of whether that flag is set

TEST: `services/gateway/test/orb/live/upstream/vertex-unavailable-forces-nova.test.ts` —
all cases parameterized over `vertexUnavailable: undefined|false|true`, all assert
`provider !== 'vertex'`
Output: outputs/targeted-tests.txt

AC-4 — global Nova promotion still respects the OTHER hard gates (language/runtime),
but a blocked gate forces Nova instead of degrading to Vertex

TEST: `services/gateway/test/orb/live/upstream/nova-global-promotion.test.ts` —
"global promotion does NOT bypass the other hard gates"
TEST: same file — "global promotion cannot resurrect a disabled Nova"
Output: outputs/targeted-tests.txt

AC-5 — the cascade rescue applies even on paths that used to defer to a
"live Vertex" case that no longer exists

TEST: `services/gateway/test/orb/live/upstream/cascaded-voice.test.ts` —
"VTID-03723: the cascade now rescues regardless of vertexUnavailable — there
is no 'live Vertex' branch left to defer to"
Output: outputs/targeted-tests.txt

AC-6 — the two hardcoded `provider: 'vertex'` fallbacks in `orb-live.ts`
OUTSIDE the selector (config-read-failure default, idle-Nova-rotation-exhaustion
override) no longer materialize a Vertex connection either

TEST: verified by source read + `tsc --noEmit` (no test framework hook exists for
these two call sites in isolation; both are exercised indirectly by the full
`test/routes/orb-live.test.ts` suite, part of the orb-suite run below, which
stays green)
TEST: `services/gateway/test/orb/**` (full sweep, includes `routes/orb-live.test.ts`)
Output: outputs/orb-suite.txt

AC-7 — the Voice Lab test-bench's own self-checks (the platform owner's
explicit "use the audio testing program" instruction) assert the corrected
behavior, not the old vertex-degradation behavior

TEST: `services/gateway/test/services/voice-lab/nova-sonic-test-runner.test.ts` —
"offline tier passes on a clean environment" (asserts `selector_non_allowlisted`,
`selector_language_fallback`, `selector_emergency_rollback` all pass under the
new behavior)
Output: outputs/targeted-tests.txt

AC-8 — no regression across the full ORB test tree or the gateway build

TEST: `services/gateway/test/orb/**` — 201/201 suites, 3713/3720 tests
(1 pre-existing skip, 6 pre-existing todo — unrelated to this change)
Output: outputs/orb-suite.txt
TEST: `npx tsc --noEmit` — clean, zero errors
Output: outputs/tsc.txt

---

## Deliberately out of scope

`active-provider-resolver.ts` (`GET /orb/active-provider`, the LiveKit-vs-
gateway-transport resolver) still reports `effectiveProvider: 'vertex'` in
its default case. Its own header comment confirms this is a legacy
**transport label** ("Nova sessions ride the same gateway WS/SSE the Vertex
path uses... the widget must not grow a Nova branch"), not a claim that a
session connects to Google Vertex. Renaming it touches the frontend
`useActiveVoiceProvider()` hook and is a separate, larger refactor unrelated
to the reported defect — not attempted here.

Turkish-language support (`tr`) and any further per-language Polly voice/
cascade-eligibility gaps raised by the platform owner in the same
conversation are tracked as a separate, distinct VTID per CLAUDE.md §4.1
rule 6 ("Two unrelated fixes ... get two VTIDs, not one shared across
both") — `tr` is not in `SUPPORTED_LIVE_LANGUAGES` at all yet, which is an
additive language-support gap, not a Vertex-routing defect.
