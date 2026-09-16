# VTID-03965 — fix VTID-03964 regressions found in live staging re-verification

## Report

VTID-03964 (PR #3349) merged and auto-deployed to staging (confirmed via
`git_commit` on `/api/v1/admin/build-info` showing `dd808d6`, the exact
merged commit). Per this repo's own deployment verification protocol, the
same repeated-curl test used to validate VTID-03964 was re-run against the
live endpoint immediately after — and found the fix incomplete on two of
its three targeted routes:

- `/api/v1/orb/health` — unaffected by this VTID, still fine.
- `/api/v1/autopilot/health` — still measured 6.4-6.6s on 2 of 6 calls,
  over the Command Hub panel's 6s budget, despite VTID-03964's
  `Promise.all` fix.
- `/api/v1/autopilot/pipeline/health` — still producing real HTTP 500s on
  2 of 6 calls, with the EXACT SAME error bodies as before VTID-03964
  (`"Body is unusable: Body has already been read"`, `"The operation was
  aborted."`), despite VTID-03964 giving each of the three direct fetches
  its own independent `AbortController`.

Both are genuine follow-on defects VTID-03964 did not (and structurally
could not, given what it changed) fix — root-caused below, not merely
patched around.

## Acceptance Criteria

AC-1 — `getLoopStats()`'s internal fallback-on-failure path (a second,
sequential Supabase call to `getLoopState()` when the primary
`get_autopilot_loop_stats` RPC fails or returns no rows) can stack to
~6000ms all by itself when Supabase is slow enough to trip the primary's
~3000ms bound — exactly the condition under which the fallback is also
likely to be slow. VTID-03964's `Promise.all` parallelized this call
against its sibling `isAutopilotExecutionArmed()`, but never addressed this
internal two-step sequential shape, so the ~6.4-6.6s measurement persisted.
`getLoopStats()` now races its whole primary+fallback body (`Promise.race`
against a single 3000ms deadline) so the function resolves within ~3s total
regardless of how many sequential steps it takes internally.

TEST: `outputs/jest-new-tests.txt` — `test/services/autopilot-loop-store.test.ts`,
new test "caps total time at ~3s even when both the primary RPC and its
fallback each hang to their own bound": both calls simulated as hanging
until aborted; asserts the function resolves to `null` in ~3003ms, not the
~6000ms sequential-hang total.

AC-2 — `routes/autopilot.ts`'s `/pipeline/health` reads each of its three
Supabase response bodies (`taskCountsResp.json()`, `stuckTasksResp.json()`,
`workersResp.json()`) AFTER `Promise.all` has already settled and the
AbortController timeouts have already been cleared — completely unguarded
by try/catch, outside the `.catch(() => null)` that only protects the
`fetch()` promise itself. A failed/corrupted body read (consistent with
Node's fetch/undici pooling this route's 3 direct fetches concurrently with
`getEventLoopStatus()`'s own 2 internal fetches — up to 5 concurrent
requests to the same Supabase host) threw straight past every existing
guard into the route's top-level catch, turning one degraded data point
into a full 500. Confirmed no safe fix is available at the connection-pool
layer itself: neither the `undici` npm package nor the `node:undici` builtin
module resolves in this environment (checked directly), so a
dispatcher/Agent-based fix would have been unverifiable and was
deliberately not attempted. Instead, each of the three parses is now
independently wrapped in its own try/catch — a parse failure on any one
degrades only that field (logged via `console.error`) instead of 500ing
the whole health check, matching the fetch-level `.catch(() => null)`
pattern already in place one line above.

TEST: `outputs/jest-new-tests.txt` — `test/routes/autopilot.test.ts`, new
test "degrades one field instead of 500ing the whole route when a response
body fails to parse": simulates the exact observed corruption signature
("Body is unusable: Body has already been read") on the task-counts fetch;
asserts 200 with `tasks` zeroed out, while the other two (unaffected)
fields still populate correctly.

AC-3 — zero behavioral change on the fully-happy path for either route.

TEST: `outputs/jest-full-suite.txt` — full gateway suite green (927/928
suites, 1 pre-existing skip; 15,234/15,269 tests passing), including every
pre-existing test on both touched routes/functions, unmodified and still
passing.

## Not yet independently re-observed

The next real signal is a repeated-curl re-run against live staging (same
protocol as `commands.log`'s first section) showing `/api/v1/autopilot/health`
consistently under the panel's 6s budget and `/api/v1/autopilot/pipeline/health`
returning 200 across at least 5-6 back-to-back calls, with no further "Body
is unusable"/"operation aborted" 500s. This session verified the fix
structurally (tests simulating the exact failure signatures) and via full
regression suite, but has not yet re-observed it against live staging
traffic post-deploy — that is the immediate next step after this PR merges
and the staging auto-deploy completes.

The underlying question of WHY Supabase/PostgREST is intermittently slow
enough to trip these bounds in the first place remains explicitly
un-root-caused, same as VTID-03954/VTID-03964 before it — this VTID (like
its predecessors) only bounds and gracefully degrades the failure mode, it
does not eliminate the underlying latency source.

OASIS_PROOF: not applicable — see `OASIS_IMPACT: no` in the PR body. This
change touches only internal health-check timeout/degradation handling; it
emits no new OASIS events and does not alter any existing `oasis_events`
emission path.
