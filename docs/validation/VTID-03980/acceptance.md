# VTID-03980 — SSE event ticker back-pressure (Command Hub was starving the shared DB)

## Report

Continuation of VTID-03972's production-latency investigation, measured
live 2026-09-16 16:00–16:30 UTC on the single shared Supabase project.
`pg_stat_activity` and the Postgres logs showed the same statement timing
out continuously (1,770 `canceling statement due to statement timeout` in
one hour):

    SELECT oasis_events.* FROM oasis_events WHERE surface = $1
    ORDER BY created_at DESC LIMIT $2 OFFSET $3

Source: `GET /api/v1/events/stream` (`services/gateway/src/routes/events.ts`),
the Command Hub's SSE ticker. Per open tab it polled every 3s on a fixed
`setInterval`; the FIRST poll carried no `created_at` bound at all (a full
seq scan + sort of a ~540 MB table with no created_at index); once that
page hit PostgREST's 8s `statement_timeout`, `lastSeenTimestamp` was never
set, so the identical heaviest query was re-issued every 3s — overlapping,
since 3s < 8s — forever, per tab. Logins (Supabase Auth sign-in measured at
32.8s / one 504) and the mobile app's `profiles` read were starved behind it.

## Acceptance Criteria

AC-1 — The first poll (and every poll while no cursor exists) is bounded to
the last `SSE_INITIAL_WINDOW_MS` (15 min) via `created_at=gt.<since>`, so it
is a bounded range scan (index-friendly) instead of an unbounded sort of the
whole table. The cursor path (`created_at=gt.<lastSeen>`) and the
VTID-03927 `channel→surface` mapping are unchanged.

TEST: `services/gateway/test/events-stream-backpressure.test.ts` —
`buildSseEventsQuery` unit tests (bounded first poll, cursor once present,
filters preserved) and the live-route test "the very first poll already
carries a created_at lower bound and an abort signal".

AC-2 — Polls never overlap: a tick that fires while a previous poll is still
in flight is skipped, and the loop is self-scheduling (`setTimeout` chain)
rather than a fixed `setInterval`.

TEST: `services/gateway/test/events-stream-backpressure.test.ts` — "never
overlaps polls: while one poll is still in flight, the next tick is skipped".

AC-3 — Each poll carries its own `AbortController` with a
`SSE_POLL_TIMEOUT_MS` (5s) timeout, below PostgREST's 8s statement_timeout,
and a failed/timed-out poll doubles the delay (capped at 30s) while a
successful poll resets it to 3s. Client disconnect aborts any in-flight poll
and clears the pending timer.

TEST: `services/gateway/test/events-stream-backpressure.test.ts` —
`nextSsePollDelay` unit tests (reset on success; 6s→12s→24s→30s cap on
failure) and the live-route test "backs off after a failed poll instead of
hammering at the base interval".

## What could NOT be run locally

`npm ci` in `services/gateway` fails in this sandbox (registry returns 403,
see `commands.log`), so the jest suite and `tsc --noEmit` were not executed
here. The PR's own Build Gate and Gateway (Jest) checks on GitHub-hosted
runners are the compilation and test verification; their status on this PR
is the pass/fail signal. Not claiming a local jest pass this session did not
observe.

## Related live DB findings (recorded, not part of this code change)

- The `idx_oasis_events_created_at` index VTID-03972 reported creating did
  not exist when checked at 15:5x UTC; a pg_cron-driven
  `CREATE INDEX CONCURRENTLY` then produced an index reporting only 670
  indexed tuples against 485,635 in the table, so it was dropped again
  (`DROP INDEX CONCURRENTLY`) rather than left in place. A
  `(surface, created_at DESC)` build via pg_cron stalled `indisvalid=false`
  and is being dropped the same way. Index creation on this table needs to
  be done from a session that can hold a connection for the full build and
  verify `pg_stat_progress_create_index` — flagged to the platform owner.
- The nightly retention job (`oasis_events_cleanup_batched`, jobid 6,
  03:00 UTC) has not yet done its first full run.

OASIS_PROOF: not applicable — `OASIS_IMPACT: no`. This change adds no
`oasis_events` emission path; it only changes how an existing reader polls.
