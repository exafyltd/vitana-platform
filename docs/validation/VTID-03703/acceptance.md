# VTID-03703 — ORB voice: never route to a dead Vertex, Nova or the cascade only

Evidence pack for the explicit product directive: "When Nova is not ready,
it should switch to polly TTS, so either Nova or polly, but no fucking
Vertex anymore."

**Root cause (VTID-03688 live telemetry):** sessions were dying with
upstream WebSocket close code 1007 ("invalid argument") shortly after a
recovered greeting. Tracing `selectUpstreamProvider()`
(`services/gateway/src/orb/live/upstream/upstream-provider-selector.ts`)
found that `evaluateNovaRequest()`/`evaluateNovaCanary()` only forced Nova
through `vertexUnavailable` when Nova *itself* was gated (unsupported
runtime/language). Two other branches — `nova_disabled` and
`nova_not_allowlisted` — still returned `provider: 'vertex'` even with
`vertexUnavailable: true`, because those branches were written back when
Vertex was a real fallback. It has been permanently dead since the
2026-08-16 GCP billing shutdown (CLAUDE.md §1), so those sessions reached a
genuine dead Vertex connect.

---

AC-1 — `nova_disabled` no longer routes to Vertex when Vertex is unavailable

Before this change, an explicit `nova_sonic` request with Nova disabled and
`vertexUnavailable: true` still returned `provider: 'vertex'`. It now either
routes through the VTID-03683 cascade (Transcribe → Bedrock → Polly) when
the blocked reason is a language the cascade covers, or forces Nova through
blind with `reason: 'nova_forced_vertex_unavailable'`.

TEST: `services/gateway/test/orb/live/upstream/vertex-unavailable-forces-nova.test.ts`
— "Nova disabled, explicit request, vertexUnavailable=true: forced onto
Nova, never Vertex"
TEST: same file — "Nova disabled, default (no-request) path,
vertexUnavailable=true: forced onto Nova, never falls through to a vertex
default"
Output: `outputs/targeted-tests.txt`

AC-2 — `nova_not_allowlisted` (identity/canary gate) no longer routes to
Vertex when Vertex is unavailable

Before this change, a caller not on the Nova canary allowlist with
`vertexUnavailable: true` still degraded to `provider: 'vertex'` — a dead
Vertex connect outranked canary policy. It is now forced onto Nova instead
(`reason: 'nova_forced_vertex_unavailable'`, `novaReady: false`).

TEST: `vertex-unavailable-forces-nova.test.ts` — "identity not allowlisted,
explicit request, vertexUnavailable=true: forced onto Nova — a dead Vertex
outranks canary policy"
TEST: same file — "identity not allowlisted, default (no-request) path,
vertexUnavailable=true: forced onto Nova, never falls through to a vertex
default"
Output: `outputs/targeted-tests.txt`

AC-3 — A language the cascade covers is rescued by the cascade, not a
blind forced Nova

When `vertexUnavailable` is true and the blocking reason is an unsupported
language that the Transcribe→Bedrock→Polly cascade (VTID-03683) can serve,
the selector routes to `provider: 'cascaded'` rather than forcing Nova onto
a language it cannot actually speak.

TEST: `vertex-unavailable-forces-nova.test.ts` — "Nova disabled, language a
cascade already covers, vertexUnavailable=true: routes to the cascade, not
a blind forced Nova"
Output: `outputs/targeted-tests.txt`

AC-4 — The operator emergency-rollback override is untouched

`env_explicit_vertex` (`ORB_LIVE_PROVIDER=vertex`, a deliberate manual
operator action, not automatic session routing) still returns
`provider: 'vertex'` even with `vertexUnavailable: true` — this directive
is about automatic session routing, not about removing the operator's own
manual rollback lever.

TEST: `vertex-unavailable-forces-nova.test.ts` — "env_explicit_vertex is
untouched — the emergency-rollback escape hatch is a deliberate operator
action, not automatic session routing"
Output: `outputs/targeted-tests.txt`

AC-5 — No regression to the happy path or to `vertexUnavailable` unset
behavior

Every scenario in AC-1/AC-2 is paired with the identical scenario at
`vertexUnavailable` unset (default), asserting the old `provider: 'vertex'`
behavior is unchanged when the flag is off — the flag is the only thing
that moves. The happy path (all gates pass) is unaffected by the flag.

TEST: `vertex-unavailable-forces-nova.test.ts` — "Nova disabled, explicit
request, unset (default): still vertex — unchanged behavior"
TEST: same file — "identity not allowlisted, explicit request, unset
(default): still vertex — unchanged behavior"
TEST: same file — "all gates pass normally: vertexUnavailable=true does not
change the happy-path reason"
Output: `outputs/targeted-tests.txt`

AC-6 — Full regression suite is clean

TEST: `npx jest test/orb` — 171/171 suites, 3235/3241 tests passing (6
pre-existing todo), 0 failures.
Output: `outputs/full-orb-suite.txt`

AC-7 — Type-checks clean

TEST: `npx tsc --noEmit` — no output, exit 0.
Output: `outputs/tsc.txt` (empty — clean)

---

## Verification summary

| Check | Result |
|---|---|
| Targeted selector/cascade tests | 59/59 passing |
| Full `test/orb` suite | 171/171 suites, 3235/3241 tests, 0 failures |
| `tsc --noEmit` | clean |
| `env_explicit_vertex` regression check | confirmed untouched |
| Live traffic confirmation (staging) | **pending — this PR must merge and deploy first** |

## Known limitation carried forward

The underlying Nova "Premature close"/`nova_validation` flakiness that
necessitates retries in the first place (documented extensively in
CLAUDE.md's VTID-03647→03688 change-log chain) is not fixed by this
change. This change only ensures that whenever Nova cannot serve a
session, the fallback is Nova-forced or the Polly cascade — never a dead
Vertex — per the explicit product directive. It does not make Nova itself
more reliable.
