# VTID-04000 — Serbian voice bridge: revive Vertex Live on a NEW GCP account, sr only

## Report / decision

VTID-03998's Fish `latency` fix was measured live against a real Serbian
voice (6 trials, `s2.1-pro-free`) and disproved: at realistic reply length
(~535 chars) `'normal'` and `'low'` both averaged ~9.6s — no measurable
difference. Fish's real throughput is ~50-60 chars/sec regardless of mode,
so the actual driver of the reported "zero audio" pre-login failures is
turn text length vs. TTS throughput, not the request-shape field VTID-03998
tuned. Fixing that in the shared cascade would mean touching
`cascaded-live-client.ts`'s turn-shaping, outside the Fish-only scope the
platform owner had set.

The platform owner instead opened a **new, dedicated GCP project** (never
the decommissioned `lovable-vitana-vers1`) with a 90-day free-credit window
and asked to revive the Vertex Live API for Serbian specifically, since
Gemini Live natively speaks Serbian in one hop — confirmed via Google's own
docs (`sr` is in the Live API's supported-language list) before any code
was written.

## Investigation

Read `upstream-provider-selector.ts` in full. Confirmed the Vertex
infrastructure (`VertexLiveClient`, the AWS-compatible ADC bootstrap
`gcp-adc-bootstrap.ts`, Serbian's own Gemini TTS voice mapping in
`voice-mapping.ts`) was never deleted after the GCP shutdown — it was made
structurally unreachable by VTID-03723, which rewired every selector branch
so `provider: 'vertex'` could never be returned again, after a real
incident (staging's `voice.active_provider='vertex'` row silently routing
Polish/Portuguese sessions to a dead Vertex connection that "spoke" fluent
English because nothing else was ever consulted). `ctx.vertexUnavailable`
is declared on the selector's context type but is no longer read anywhere
— the force-through is unconditional, not flag-gated.

## Fix — one narrow, explicit, additive carve-out

New `orb/live/upstream/vertex-serbian-bridge.ts`:
`isVertexSerbianBridgeEnabled()` (exact-string `VERTEX_SERBIAN_BRIDGE_
ENABLED=true`, same activation-gate convention as `isCascadeEnabled()`) and
`isVertexSerbianBridgeLanguage(lang)` (true only for `sr`, any region/script
suffix — never widened to a list).

`upstream-provider-selector.ts`: new `tryVertexBridgeRescue()`, mirroring
`tryCascadeRescue()`'s exact "returns null when it does not apply"
contract, checked BEFORE `tryCascadeRescue()` at all 5 call sites
(`resolveWithoutVertex`, both branches of `evaluateNovaRequest`, both
branches of `evaluateNovaCanary`). Fires only when BOTH
`vertexSerbianBridge.enabled` and `vertexSerbianBridge.languageSupported`
are explicitly `true`. New `SelectionReason: 'vertex_serbian_bridge'`.

`routes/orb-live.ts`: wired the two precomputed booleans into the real
`selectUpstreamProvider()` call site the same way `cascade`/`nova` already
are — the selector itself never reads env vars or language strings.

`scripts/aws/setup-vertex-serbian-bridge.sh`: provisioning script (dry-run
by default, `--apply` to execute) — creates a scoped GCP service account
(`roles/aiplatform.user` only) on the new project and pushes its key into
AWS Secrets Manager as `vitana/gateway/<env>/gcp-service-account-json`.
Refuses outright if `--gcp-project lovable-vitana-vers1` is passed.
Deliberately NOT wired into `AWS-STAGE-DEPLOY-GATEWAY.yml` in this VTID —
same reasoning as `setup-fish-audio-secret.sh`'s own precedent: this
session cannot confirm the secret exists before merging code that would
require it, and that workflow's secret-resolution loop hard-fails the
entire staging deploy on a missing listed secret.

`CLAUDE.md`: updated the GCP-decommission banner, NEVER rule 27, and
§2e's own intro to document this as a deliberate, narrow, time-boxed
exception rather than a general reopening — plus a new
§2e-vertex-serbian-bridge section with the full mechanism, the
`VERTEX_PROJECT_ID` stale-fallback caveat (still defaults to the
decommissioned project id when `GOOGLE_CLOUD_PROJECT`/`GCP_PROJECT_ID` are
unset), and the new env vars in §8.

## Acceptance Criteria

AC-1 — the bridge fires ONLY when both `enabled` and `languageSupported`
are explicitly `true`; a half-satisfied gate, an absent context, or a
language Nova already speaks all leave existing behaviour byte-for-byte
unchanged.

TEST: `upstream-provider-selector.test.ts`, "VTID-04000: Vertex Serbian
bridge — the one narrow exception" (10 tests: positive path at all 3 call
sites, priority over the cascade rescue, 4 mutation-negative cases).

TEST: `vertex-serbian-bridge.test.ts` (11 tests: activation-gate exact
string, language predicate incl. region/script variants and every
Nova/cascade-covered language rejected).

AC-2 — the pre-existing VTID-03723 invariant ("Vertex is never a
destination") still holds for every context that does NOT satisfy both
new gates, including half-satisfied bridge configs added to the existing
invariant matrix.

TEST: `upstream-provider-selector.test.ts`, "invariant: across a broad
matrix of contexts, provider is never vertex" — 3 new half-satisfied
bridge contexts added to the existing matrix, all still assert
`provider !== 'vertex'`.

AC-3 — every pre-existing selector/predicate behaviour is unchanged.

TEST: `outputs/jest-selector-and-bridge.txt` — 2/2 suites, 58/58 tests
passing (all pre-existing VTID-03723/L1/L2.1/Nova/health tests unmodified
except the header comment and invariant-matrix additions, which do not
change any assertion's expected outcome).

## Verification

TEST: `outputs/tsc-noemit.txt` — `tsc --noEmit`, clean (exit 0).

TEST: `outputs/jest-selector-and-bridge.txt` — 58/58 tests passing.

TEST: `outputs/npm-build.txt` — `npm run build`, clean (exit 0).

TEST: `outputs/jest-full-suite.txt` — full gateway suite: 938/939 suites (1
pre-existing skip), 15,325/15,360 tests passing, 0 failures.

TEST: `outputs/bash-syntax-check.txt` — `bash -n
scripts/aws/setup-vertex-serbian-bridge.sh`, clean.

## Not yet independently confirmed

**Ships inert.** `VERTEX_SERBIAN_BRIDGE_ENABLED` is unset by default —
every line of this VTID changes nothing on a live task definition until an
operator:
1. Runs `scripts/aws/setup-vertex-serbian-bridge.sh provision --gcp-project
   <new-project-id> --env staging --apply` and confirms via its `status`
   action.
2. Wires `GCP_SERVICE_ACCOUNT_JSON`, `GOOGLE_CLOUD_PROJECT`,
   `VERTEX_AI_LOCATION`, and `VERTEX_SERBIAN_BRIDGE_ENABLED=true` into
   `AWS-STAGE-DEPLOY-GATEWAY.yml`.
3. Deploys and confirms a real Serbian voice session actually connects to
   Vertex (`orb.upstream.provider.selected` reporting `reason:
   'vertex_serbian_bridge'` in `oasis_events`) and produces audio within
   budget.

This session has no GCP/AWS credentials for the new project, so none of
that live verification could happen here — the code path is verified
structurally (unit tests + the existing invariant suite), not against a
real Vertex connection. The next real signal is the reporting user's next
pre-login Serbian session, once the operator steps above are done.

## Post-merge finding: pre-existing Vertex/LiveKit parity gap (not this VTID's regression)

This PR's own `voice-pipeline-parity` CI scanner (report-only, runs on
every gateway PR) flagged 13 `high`-severity `missing_in_vertex` items:
7 OASIS event topics (`orb.live.context.bootstrap`,
`orb.live.context.bootstrap.skipped`, `orb.live.tool.executed`,
`orb.navigator.requested`, `orb.navigator.blocked`,
`admin.briefing.injected`, `feedback.ticket.created`) and 6 watchdog
settings (`session_timeout_ms`, `conversation_timeout_ms`,
`max_connections_per_ip`, `max_reconnects`, `max_history_chars`,
`extraction_throttle_ms`) present in the LiveKit/Nova pipeline but absent
from `VertexLiveClient`. `safety_critical: 0` — not a crash/security gap —
but this VTID reactivates the exact code path the scan is comparing
against, so it is directly relevant here: a real Serbian bridge session
will not get the same timeout/reconnect-capping/observability coverage a
Nova or cascade session gets, until those are backported or confirmed
covered elsewhere. Documented in CLAUDE.md
§2e-vertex-serbian-bridge as a caveat to check before promoting the
bridge past a small canary. Not fixed here — backporting 13 items into
`VertexLiveClient` is a separate, larger VTID, and the bridge ships
inert regardless.
