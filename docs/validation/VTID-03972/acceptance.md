# VTID-03972 — fix production latency: oasis_events bloat + unbounded auth-path Supabase calls

## Report

User-reported live in production: the MAXINA mobile app (community role)
is slow to log in, and every subsequent screen navigation shows a loading
spinner for a long time. Screenshot showed a stuck blank-white spinner.

Traced to two compounding causes, both confirmed live rather than assumed:

1. `oasis_events` (the platform's shared telemetry/event log) had grown to
   933MB — ~16x every other table in the database combined — because its
   only real retention job (`oasis-events-info-retention`, pg_cron jobid 6)
   silently only ever pruned `status='info'` rows. A February migration's
   intended blanket 14-day retention job was never actually created on the
   live project. Live `pg_stat_activity` caught real PostgREST queries
   against this table blocked on `DataFileRead` I/O waits.
2. `services/gateway/src/middleware/auth-supabase-jwt.ts` runs on every
   authenticated/optionally-authenticated gateway request. Its two Supabase
   lookups (`resolveVitanaId`, `fetchPrimaryTenantForUser`) had zero
   `AbortController`/timeout, so whenever the DB had one of the I/O-stall
   moments from cause 1, the request just hung with no bound — on every
   screen, not one route. `services/gateway/src/routes/autopilot-recommendations.ts`
   (backs the badge-count poll fired on every `AppLayout` mount + every 60s,
   including from MAXINA/`role=community`) had the identical gap.

## Acceptance Criteria

AC-1 — `oasis_events` has a plain index on `created_at` (none existed
before — only composite indexes with `topic`/`status` leading, so any pure
time-range query forced a sequential scan), the retention cron job (jobid
6) covers all statuses instead of only `status='info'`, and cleanup runs in
small committed batches (`oasis_events_cleanup_batched`, 5000 rows/batch)
so neither the large first catch-up run nor any future nightly run can
hold a long lock on this table. All three applied directly to the live
project and verified against real `pg_stat_user_tables`/`cron.job` state.

TEST: `commands.log` — "Live production fix" section: `CREATE INDEX
CONCURRENTLY` succeeded, `cron.alter_job` succeeded, one manual batched run
observed reducing `n_live_tup` from 505,574 to 495,582 (~10,000 rows) with
the corresponding rise in `n_dead_tup`, confirming real committed progress
even though the client-side call itself timed out waiting on the DB.

AC-2 — `resolveVitanaId()` and `fetchPrimaryTenantForUser()` (called from
`requireTenant` and `requireAuthWithTenant`) now race against a 2500ms
`AbortController` timeout, matching the pattern already established in
`vtid-ledger-reader.ts`. `requireAuthWithTenant`'s two independent lookups
(vitana_id resolution, tenant resolution) now run concurrently via
`Promise.all` instead of sequentially, so their timeouts no longer stack.
`fetchVitanaIdForUser`/`fetchPrimaryTenantForUser` in
`auth-supabase-jwt-repository.ts` both gained a required `signal:
AbortSignal` parameter and chain `.abortSignal(signal)` on the Supabase
query builder — the same idiom already used in
`orb-memory-bridge-repository.ts`.

TEST: `test/middleware/auth-supabase-jwt.test.ts` — its fake per-table
thenable Supabase chain now stubs `.abortSignal(): chain` so the existing
`requireAuth`/`requireTenant`/`requireAuthWithTenant`/`resolveVitanaId`
test cases exercise the new call shape unchanged. **Could not be run
against a real jest process in this session** — this sandbox's npm
registry access is blocked (`npm ci` → 403; see `commands.log`'s "What
could NOT be run locally" section). This PR's own Build Gate step
(`cd services/gateway && npm ci && npm run build`, same VALIDATOR-CHECK
workflow, GitHub-hosted runner) is the real compilation/type-check
verification; its own job status on this PR is the pass/fail signal for
this AC's structural correctness. Not claiming a jest pass this session
did not observe.

AC-3 — `autopilot-recommendations.ts`'s three hot-path Supabase fetches
(`callRpc`, `queryRecommendationsByRole`, `queryRecommendationsFallback` —
together backing `GET /` and `GET /count`, hit by the MAXINA mobile badge
poll) now race against a 3000ms `AbortController` timeout via the same
`abortAfter()` idiom, instead of having no timeout at all.

TEST: `outputs/path-ownership-gate.txt`, `outputs/route-evidence-gate.txt`,
`outputs/csp-gate.txt` — this repo's own dependency-free CI-gate scripts
run directly against the real diff, confirming: the touched files fall
under the `gateway_backend` profile allowlist (the one out-of-remit file,
the migration, is correctly NOT JUDGED rather than rejected); no route
registration was added (the fix only edits existing route/helper
internals, so the Route Mount Evidence Gate correctly does not fire); and
no CSP-relevant pattern appears in any added line (this change touches no
browser-served frontend surface). All three ran clean/exit-as-expected —
see `commands.log` for the exact commands and this AC's own three output
files for full captured stdout.

## Not yet independently observed

Same honest gap as this repo's other recent latency-fix VTIDs (03954,
03964, 03965): the code fix has not yet been observed against live
staging/production traffic post-deploy — that requires this PR merging
(staging auto-deploy) and then either a repeated-curl timing check or,
ideally, the reporting user confirming the mobile app feels responsive
again. The DB-side fix (AC-1) is already live and independently verified
against real production state; the code-side fix (AC-2/AC-3) still needs
that live confirmation once deployed.

Also not done in this VTID, flagged as follow-up: the other ~8 `fetch()`
calls in `autopilot-recommendations.ts` (activate/reject/snooze/generate/
history/sources — user-initiated, not polled every 60s) still lack
timeouts, and `generatePersonalRecommendations` (a separate service module
reachable from the community auto-generate path inside `GET /`) was not
audited for the same gap.

OASIS_PROOF: not applicable — see `OASIS_IMPACT: no` in the PR body. This
change adds no new `oasis_events` emission path; it only reads/prunes that
table at the SQL/maintenance level and adds request-level timeouts to
existing Supabase reads.
