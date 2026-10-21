# VTID-03964 — fix VTID-03954 regressions found in live staging verification

## Report

VTID-03954 added bounded timeouts to the ORB Live/Autopilot health-check
call chains and merged (PR #3345). Per this repo's own deployment
verification protocol, the staging deploy was checked immediately after
merge (`git_commit` on `/api/v1/admin/build-info` confirmed `7b9ca15`,
the exact merged commit, live on staging) — and the platform owner
independently reported the Command Hub Service Health panel still showing
"Autopilot (down) • Autopilot Pipeline (down)" among 5 critical issues,
with a screenshot.

Repeated `curl` against the three routes VTID-03954 touched, live against
`preview-aws-gateway.vitanaland.com`, confirmed:

- `/api/v1/orb/health` — VTID-03954's fix works: consistently 0.27–0.35s
  across repeated calls (was previously spiking to 16s+).
- `/api/v1/autopilot/health` — improved (no more full 20s timeouts) but
  still measured 6.3s on one call, over the panel's 6s client-side budget.
- `/api/v1/autopilot/pipeline/health` — WORSE: two of four repeated calls
  returned real HTTP 500s with body `{"ok":false,"error":"Body is
  unusable: Body has already been read"}` — a genuine regression VTID-03954
  introduced, not present before it.

Root-caused both, plus found a third, previously-undiagnosed instance of
the same underlying defect shape while re-checking the panel
(`/api/v1/vtid/health`, measured 14.7s on one call) — not part of
VTID-03954's original scope, but the identical unbounded-sequential-fetch
pattern, on the same dashboard, causing the same user-visible symptom.

## Acceptance Criteria

AC-1 — `routes/autopilot.ts`'s `/pipeline/health` no longer shares one
`AbortController`/signal across its three concurrent Supabase fetches.
Each fetch (`count_tasks_by_status` RPC, the stuck-tasks `vtid_ledger`
query, the worker-heartbeat `oasis_events` query) now gets its own
independent `abortAfter()` instance. This is the fix for the "Body is
unusable: Body has already been read" 500s — consistent with Node's fetch
(undici) corrupting a pooled keep-alive connection when one shared
AbortSignal aborts multiple in-flight requests to the same host at once.

TEST: `outputs/jest-new-tests.txt` — `test/routes/autopilot.test.ts`,
new test "gives each of the three direct Supabase fetches its own
independent AbortSignal": asserts exactly 3 distinct `AbortSignal`
instances (`new Set(signals).size === 3`), where the pre-fix code would
have produced a single shared instance.

AC-2 — `services/autopilot-event-loop.ts`'s `getEventLoopStatus()` (on
the critical path of both `/api/v1/autopilot/health` and
`/api/v1/autopilot/pipeline/health`) now runs its two independent
Supabase-backed reads — `getLoopStats()` and `isAutopilotExecutionArmed()`
— concurrently via `Promise.all`, instead of sequentially. Each is
individually bounded at ~3s (VTID-03954); running them sequentially could
therefore stack to ~6s from this one function alone, before the rest of
either route's own work — measured live at 6.3s on `/api/v1/autopilot/health`,
over the Command Hub panel's 6s per-check budget.

TEST: `outputs/jest-new-tests.txt` — `test/services/autopilot-event-loop.test.ts`,
new test "runs getLoopStats() and isAutopilotExecutionArmed() concurrently,
not sequentially": with both mocks delayed 40ms, asserts total elapsed
time stays under 1.8x the single-call delay (would be ~2x if still
sequential).

AC-3 — `routes/vtid.ts`'s `/health` (ledger read + `next_vtid` RPC probe)
had the identical unbounded, sequential-fetch shape, independently found
while re-checking the panel post-deploy (14.7s measured on one call, no
part of VTID-03954's original scope). Fixed the same way: each fetch gets
its own independent `abortAfter()` timeout (2500ms), and the two
independent checks now run concurrently via `Promise.all` instead of
sequentially.

TEST: `outputs/jest-new-tests.txt` — new `test/routes/vtid-health.test.ts`
(5 tests): healthy-path 200, independent-AbortSignal-per-fetch (same
pattern as AC-1), concurrent-not-sequential timing (same pattern as AC-2),
a hanging-fetch resolves in ~2.5s instead of hanging past the jest test
timeout (proving the abort wiring actually fires), and the pre-existing
missing-env-vars 503 path is unchanged.

AC-4 — zero behavioral change on the success path for any of the three
routes; only the failure/slow-path behavior changed (bounded instead of
unbounded, and no more connection-pool corruption).

TEST: `outputs/jest-full-suite.txt` — full gateway suite green (925/926
suites, 1 pre-existing skip; 15,200/15,235 tests passing), including every
pre-existing test on the three touched routes and `getEventLoopStatus`,
unmodified and still passing.

## Not yet independently re-observed

The next real signal is the Command Hub Service Health panel staying green
across a normal polling window in staging, and in particular no further
500s on `/api/v1/autopilot/pipeline/health`. This session verified via
direct repeated `curl` against the live staging endpoints as part of this
fix's own investigation (see `commands.log`), but has not observed the
panel itself over an extended window.

OASIS_PROOF: not applicable — see `OASIS_IMPACT: no` in the PR body. This
change touches only internal health-check timeout/concurrency handling; it
emits no new OASIS events and does not alter any existing `oasis_events`
emission path.
