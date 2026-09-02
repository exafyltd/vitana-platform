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
