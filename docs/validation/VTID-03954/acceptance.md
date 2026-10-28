# VTID-03954 — Bound Supabase timeouts on ORB Live/Autopilot health checks

## Report

The Command Hub Service Health panel (`/command-hub/tasks/`) intermittently
flapped "ORB Live", "Autopilot", and "Autopilot Pipeline" to `down`.
Investigated live against `preview-aws-gateway.vitanaland.com` before
writing any code, per this repo's own standing rule against assuming
unverified context: repeated `curl` against these three routes vs. control
endpoints (`/alive`, `/api/v1/scheduler/health`) showed the controls
consistently fast (<0.7s) while `/api/v1/autopilot/health` hit the full 20s
curl timeout on 3 of 4 back-to-back attempts, and `/api/v1/orb/health` and
`/api/v1/autopilot/pipeline/health` both showed multi-second spikes well
past the panel's own 6s per-check client-side timeout (`fetchWT(ep.url,
{...}, 6000)` in `app.js`).

Root cause: these three routes are the only checks in the 55-item panel
backed by live, unbounded Supabase/PostgREST calls — every other check is
in-memory. None of the underlying calls had a timeout, so a slow Supabase
moment hung the route indefinitely instead of failing fast, and the panel
then (correctly, given what it saw) reported the card as `down`.

## Acceptance Criteria

AC-1 — `autopilot-loop-store.ts`'s shared `supabaseRequest()` helper
(backs `getLoopState`/`getLoopStats`, used by both `/api/v1/autopilot/health`
and `/api/v1/autopilot/pipeline/health` via `getEventLoopStatus()`) aborts
after 3000ms instead of waiting on `fetch()` indefinitely, following the
existing `abortAfter()` AbortController convention from
`vtid-ledger-reader.ts`.

TEST: `outputs/jest-new-tests.txt` —
`test/services/autopilot-loop-store.test.ts`, `supabaseRequest timeout
(VTID-03954)` block: asserts every request carries an `AbortSignal`, and
that a fetch which only ever resolves via its abort signal (simulating a
stalled Supabase connection) still returns `null` in ~3.0s rather than
hanging past the jest test timeout.

AC-2 — `system-controls-service.ts`'s `getSystemControl()` (used by
`isAutopilotExecutionArmed()`, also on `/api/v1/autopilot/health`'s
critical path) aborts after 3000ms.

TEST: covered by the same regression pattern as AC-1 — `getSystemControl`
shares the identical unbounded-fetch shape `supabaseRequest()` had; the
existing `test/system-controls.test.ts` suite (a different, Supabase-JS
client-backed module of a similar name) continues to pass unmodified,
confirming no behavioral regression to the cached/found/not-found paths.
See `outputs/jest-new-tests.txt`.

AC-3 — `routes/autopilot.ts`'s `/pipeline/health` three direct Supabase
`fetch()` calls (task counts, stuck tasks, worker heartbeats) now share one
2500ms `AbortController`, so a stalled Supabase connection on any of the
three no longer hangs the whole route.

TEST: `outputs/jest-new-tests.txt` — `test/routes/autopilot.test.ts`,
`GET /pipeline/health` block: "passes an AbortSignal on every direct
Supabase fetch" and "bounds hanging Supabase fetches instead of hanging the
route past its timeout budget" (resolves in ~2.5s against a mocked fetch
that never settles on its own).

AC-4 — `routes/orb-live.ts`'s `/health` provider-config block
(`getVoiceConfig()`/`getLiveKitCanaryConfig()`) races against the existing
`withBootstrapTimeout()` helper (2500ms) instead of relying solely on a
`try/catch` that only fires on a thrown error, never on a hang. On timeout
it falls through to the same pre-existing vertex/default fallback the
catch block already had — no new fallback logic introduced.

TEST: `outputs/jest-new-tests.txt` — the pre-existing
`test/orb-live-session-bootstrap-timeout.test.ts` suite (unmodified, still
green) already unit-tests `withBootstrapTimeout()`'s exact hang-resolves-to
-fallback behavior that this fix now routes through; no new test file was
needed since the helper itself is what's being reused, not reimplemented.

AC-5 — No behavioral change on the fast path (the overwhelming majority of
requests): every call site's existing success/error handling is untouched;
only a request that would previously have hung indefinitely now fails
after 2.5–3s via the exact same error-handling path each call site already
had for a rejected fetch.

TEST: `outputs/jest-full-suite.txt` — full gateway suite green (920/921
suites, 1 pre-existing skip; 15,131/15,166 tests passing), including every
pre-existing test on the four touched files/functions, unmodified and
still passing.

## Not yet independently re-observed

The underlying reason these specific Supabase/PostgREST calls are ever slow
is not root-caused here — this change only bounds the failure mode so a
slow moment can no longer masquerade as a hard outage on the Command Hub
panel. The next real signal is the panel staying green across a normal
polling window in staging instead of intermittently reddening these three
cards; this session has no way to observe that directly from here.

OASIS_PROOF: not applicable — see `OASIS_IMPACT: no` in the PR body. This
change touches only internal health-check timeout handling; it emits no
new OASIS events and does not alter any existing `oasis_events` emission
path.
