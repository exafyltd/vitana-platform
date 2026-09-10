# VTID-03802 — acceptance

Each `AC-` below is followed by the check that proves it. Suite:

- `services/gateway/test/orb/live/upstream/upstream-provider-selector.test.ts`
  (new `describe('deriveVoiceRuntimeHealthy ...')` block, 4 tests)

---

AC-1 — A session resolved to `nova_sonic` reports `healthy` from Nova's own
config-derived readiness, not from `livekitReady`.
TEST: upstream-provider-selector.test.ts — "nova_sonic reads novaReady, not livekitReady"

AC-2 — A session resolved to `cascaded` reports `healthy` from whether the
cascade pipeline is enabled.
TEST: upstream-provider-selector.test.ts — "cascaded reads cascadeReady"

AC-3 — A session resolved to `vertex` keeps its pre-existing behavior
(reads `vertexReady`).
TEST: upstream-provider-selector.test.ts — "vertex reads vertexReady (unchanged behavior)"

AC-4 — A session resolved to `livekit` keeps its pre-existing behavior
(reads `livekitReady`).
TEST: upstream-provider-selector.test.ts — "livekit reads livekitReady (unchanged behavior)"

AC-5 — `GET /api/v1/orb/health` calls the new `deriveVoiceRuntimeHealthy()`
helper instead of the old inline `provider === 'vertex' ? vertexReady :
livekitReady` ternary.
CURL: `grep -n "deriveVoiceRuntimeHealthy(activeProvider" services/gateway/src/routes/orb-live.ts` — present at the `voiceRuntimeHealthy` assignment inside the `/health` route handler.

AC-6 — `synthesizeGreetingBridgeAudioPcm()` never calls out to Google Cloud
TTS when Polly fails to serve a request; it returns null immediately.
TEST: greeting-bridge-tts.test.ts — "returns null (never calls out to Google) when Polly cannot serve the request"

AC-7 — `synthesizeGreetingBridgeAudioPcm()` still returns the Polly result
when Polly succeeds (unchanged happy path).
TEST: greeting-bridge-tts.test.ts — "returns the Polly result when Polly serves the request"

---

## Root cause of the reported symptom (production, read-only, via Supabase MCP)

This session had Supabase MCP access to the production project
(`inmkhvwdcuyhnxkgfvsb`) already connected — the user pointed this out after
the AC-1..AC-5 fix shipped, and it let this VTID find the actual live-session
root cause rather than only the monitoring-endpoint bug.

Query: per-session outcome over the last 48h, grouping `oasis_events` by
`session_id` and checking whether each session ever reached the
`model_start_speaking`/produced any `audio_out` bytes. Of 64 real sessions
(sessions with a `vtid.live.session.start` event), 10 showed this exact
signature: `orb.session.identity.resolved` → `vtid.live.session.start` →
`orb.live.context.bootstrap` (all within milliseconds, `transport:"sse"` on
every one) followed by **zero further `orb.live.diag` events of any kind**
until an unrelated `idle_no_engagement` watchdog closed the session
90-145 seconds later — `turn_count:0`, `audio_in_chunks:0`,
`audio_out_chunks:0` on every one.

CURL: (Supabase `execute_sql`, not curl — recorded here as the acceptance
gate's evidence line) — query and full output in `commands.log`.

Traced the code path: `GET /live/stream` (`orb-live.ts`) `await`s
`sendGreetingAudioBridge(session)` BEFORE opening the real upstream (Nova)
connection. That function calls `synthesizeGreetingBridgeAudioPcm()`, which
— before this fix — fell through to a live `bridgeTtsClient.synthesizeSpeech()`
call (Google Cloud TTS) whenever Polly did not serve the request. GCP is
fully decommissioned (VTID-03599/VTID-03649): that call cannot succeed, and
with no explicit timeout on the client, an unreachable/hanging call there
stalls the `await` indefinitely — before `connectToLiveAPI` is ever called,
before any diagnostic event fires, before any error reaches the client.
Exactly the reported symptom: "just connecting all the time."

---

## Live discrepancy this PR fixes (production, read-only)

Both curls below were made against the SAME moment in production, before this
fix:

CURL: `curl -s https://gateway.vitanaland.com/api/v1/orb/nova-sonic/health`
-> `{"ok":true,"configured":true,"enabled":true,"ready":true,...,"issues":[]}`

CURL: `curl -s https://gateway.vitanaland.com/api/v1/orb/health`
-> `..."voice_runtime":{"active_provider":"nova_sonic","provider_reason":"nova_forced_vertex_unavailable","healthy":false,...}`

Nova reports itself fully ready with zero configuration issues; the general
health probe reports the identical resolved provider as unhealthy. That is
the bug AC-1/AC-5 fix.

## What this session could and could not run

This sandbox has no network access to the npm registry (`npm install`/`npm
ci` returns 403) and no pre-existing `node_modules`, so the gateway's own
`jest`/`tsc` could not be executed here — see `outputs/tsc-manual-check.txt`
for what verification WAS possible (the globally-installed TypeScript
compiler, which surfaces missing-dependency noise identical across every
file in the checkout, but no new errors attributable to this change). The
CI `Build Gate` (`npm ci && npm run build`) and the `Gateway (Jest, ~7.5k
tests)` check run are the first real compile + full-suite execution of this
change, and are being watched to green.

## Not covered

Whether the fixed `voice_runtime.healthy` field actually changes what the
Command Hub System Overview ORB card displays end-to-end — that needs a
human with Command Hub UI access, or a follow-up curl against the deployed
gateway once this ships to staging.
