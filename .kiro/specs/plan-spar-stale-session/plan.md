---
change_class: standard
---
# plan(plan-spar-stale-session): re-run dead in_progress sparring sessions
<!-- plan:begin -->
## Problem
Five PLAN-SPAR sessions are stuck for good (read-only check 2026-10-20): `verdict = in_progress`,
`rounds = 0`, `updated_at` equal to `created_at`. mt-tenant-admin `16789ea0-ccfd-4c04-b25c-828f204e3c1a`
(created 07:56:31Z), mt-packs `bf74db47-7a95-47f4-bbe1-74eed286a52f`, mt-jobs
`60ea1408-6953-4519-9674-73e5c6aa6da2`, mt-launch `b160433a-bf5f-40d0-ade5-8495305e8f5b`, mt-discover
`da362c5a-6f93-4756-a159-42d2372a4754`. Their round-1 partner pass died before it wrote anything. The likely
cause is a gateway task restart, or the request being killed while 6 passes ran at once. No code path ever
finishes such a session.

Premises, checked against `origin/main` @ `26aab2dc5`:
1. **Create dedups dead sessions forever.** `services/gateway/src/services/plan-sparring/plan-sparring-service.ts:246-253`:
   `createSparringSession` loads the newest session for producer + canonical plan hash
   (`plan-sparring-repository.ts:75-89`, `fetchSessionByPlanHash`, ordered by `created_at desc`). It re-runs
   only when that session is `escalated` with a reason in `RETRYABLE_REASONS` (`:46`: `model_unavailable`,
   `code_access_unavailable`, `deadline_exceeded`) and has no `human_approved_by`. Otherwise it returns the
   stored row. An `in_progress` row whose pass is dead comes back unchanged on every call.
2. **The session row only changes when the pass ends.** `insertSession` (`repository.ts:49-67`) writes
   `verdict: 'in_progress'`. Nothing touches the row again until `writeRound` (`service.ts:222-236`) runs after
   `runPartnerPass` returns (`:280-303`). `updated_at` is set by `updateSessionState` (`repository.ts:137`) and by
   the touch trigger (`supabase/migrations/20261004110000_vtid_04868_plan_sparring_gate.sql:146-161`). So a dead
   round-1 pass leaves `rounds = []` and `updated_at = created_at`, as observed.
3. **The pass deadline is only checked inside a live process.** `PASS_DEADLINE_MS` (`service.ts:44`) is light
   10 / standard 15 / expedited 5 min. `runPartnerPass` checks it between model turns only
   (`partner.ts:174`), so one slow model call can run past it. Once the process is gone nothing checks it.
4. **The client cannot get out.** `scripts/collab/plan-spar.mjs` `create()` (`:114-122`) waits on an
   in_progress session with no round (`waitFor`, `:103-112`; `WAIT_MS` 25 min, `:37`) and then throws
   `session <id>: no round 1 after 25 min`. `step()` throws before it writes `state.json` (`:194-231`). The next
   push calls `create` again, the gateway dedups to the same id (premise 1), and the run fails again.
   `step()` already re-creates escalated sessions that are `infra` + `retryable` without using up a session
   (`:188-193`; `deadline_exceeded` is in both `INFRA_REASONS` `:34` and `RETRYABLE_REASONS` `:35`).
5. **Later rounds do not stick.** `submitPlannerRound` (`service.ts:332-415`) does not dedup. If a round-n pass
   dies, the session stays `in_progress` with `n-1` rounds. The client throws after `waitFor` (`plan-spar.mjs:123-129`),
   again before `state.json` is written. On the next push `step()` sees `live.rounds.length === cur.rounds`
   (`:208-211`), finds `responses-<n-1>.md` not yet in `submitted`, and posts the round again (`:212-215`). The
   gateway runs a fresh pass and the RPC's expected-round check (`writeRound`, `:231-232`) accepts it. A racing
   live pass ends in a 409 `round_conflict`, which the client already waits through (`:126`). So the rounds
   endpoint needs no change. Neither does `plan-spar.mjs`.

## Change (one lane `stale-session-dedup`, gateway only)
1. `plan-sparring-service.ts`: add `STALE_AFTER_MS = 60 * 60_000` and an exported pure helper
   `isDeadRoundOne(s, nowMs)`. It is true only when all of these hold:
   - `verdict === 'in_progress'`
   - `rounds.length === 0`
   - no `human_approved_by` and no `policy_approved_at`
   - `(updated_at ?? created_at)` parses to a time older than `nowMs - STALE_AFTER_MS`

   A missing or unparsable timestamp counts as not dead. In the create dedup
   branch (`:248-253`), when `isDeadRoundOne(e, now())` (with `now = deps.now ?? Date.now`), call the new repository
   function from item 2. If it updated the row, go on to insert a fresh session (existing code `:255-304`) and
   return `deduplicated: false`. If it updated nothing (another request already changed the row), re-read with
   `fetchSessionByPlanHash` and return that row as `deduplicated: true` without inserting. The client
   already handles every verdict it can get back: it waits on `in_progress`, and an escalated
   `deadline_exceeded` row is retried on the next push (`plan-spar.mjs:116,188-193`). Every other branch is
   unchanged: a fresh in_progress session is still deduped, an in_progress session with round 1 written (waiting on
   the planner) is still deduped, and a non-retryable escalated session is still deduped.

   Why a flat 60 min and not deadline + a small margin: nothing can tell a dead pass from a slow live one.
   The deadline is only checked between turns (premise 3), and a single model call has no upper bound: the
   Bedrock adapter sends `InvokeModelCommand` through a default `NodeHttpHandler` with no request timeout
   (`services/gateway/src/providers/bedrock.ts:218-229`). There is no liveness signal on the row during a pass
   either: `model_log` is written only after the pass returns (`service.ts:294,301`), and `rounds` and
   `updated_at` only change in `writeRound` (premise 2). So the threshold is chosen to make a false positive
   practically unreachable: the longest deadline is 15 min (standard), leaving 45 min for one in-flight call
   past it. The five stuck rows are hours old, so 60 min still recovers them. The cost: a newly dead session
   recovers on the first push at least 60 min after it was created. A push before that dedups to the dead id
   and the client times out after `WAIT_MS` (25 min, `plan-spar.mjs:37`), exactly as today.

   Residual trade-off, accepted and recorded: if a live pass ever does run past 60 min, it is escalated and a
   second pass starts on a fresh session. The new session wins. The old pass's `writeRound` hits the append
   RPC's in_progress check and ends with 409 `round_conflict` (`service.ts:228-232`), and its review is
   discarded. That costs one wasted partner pass and nothing else. The plan is not terminalized, and no
   session budget is used, because the escalated row is `deadline_exceeded` (infra + retryable).

   Partial failure (escalate succeeded, then `insertSession` failed): the old row stays `escalated` +
   `deadline_exceeded` with `final_plan_hash = null` and no successor. The create call returns 502
   `store_error`. The next create recovers it through the existing retryable branch (`service.ts:250-252`:
   no `human_approved_by`, verdict `escalated`, `deadline_exceeded` ∈ `RETRYABLE_REASONS` `:46`), which then
   inserts a fresh session. So this plan depends on that branch keeping `deadline_exceeded` retryable, and
   test (h) pins it. Escalate-before-insert is kept on purpose: the guarded UPDATE is what decides the race
   between two creates, and inserting first would let both racers insert a session.
2. `plan-sparring-repository.ts`: add `escalateDeadRoundOne(sb, id, cutoffIso)`. It runs an `UPDATE` with
   `verdict: 'escalated'`, `escalation_reasons: ['deadline_exceeded']`, `updated_at: now`, guarded by
   `.eq('id', id).eq('verdict', 'in_progress').lt('updated_at', cutoffIso).is('human_approved_by', null)
   .is('policy_approved_at', null)`, and `.select('id')`. It returns the updated ids. The guard means that of
   two racing creates only one escalates, and a pass that wrote in the meantime is never overwritten. It writes
   only columns `service_role` may already UPDATE (`20261004110000…sql:180-182`). There is no migration.
   `final_plan_hash` stays `null`, so the dead session can never be approved (`service.ts:445`). `deadline_exceeded`
   is the real cause, and it is already infra + retryable for both the gateway (`:46`) and the client (`plan-spar.mjs:34-35`).
   If a dead pass ever comes back, its `writeRound` is refused because the session is no longer `in_progress`
   (`service.ts:228-232`). That ends the old request with 409 and leaves the new session alone.
3. Tests: a new file `services/gateway/test/plan-sparring-stale-session.test.ts`, which mocks the repository the
   same way `test/vtid-04868-plan-sparring-service.test.ts:31-112` does and adds `escalateDeadRoundOne`. Cases:
   (a) a stale in_progress session with 0 rounds is escalated `deadline_exceeded`, a new session is inserted, round 1 runs, and `deduplicated: false`;
   (b) a fresh in_progress session with 0 rounds, younger than `STALE_AFTER_MS`, is deduped and no model is called;
   (c) an old in_progress session with round 1 written is still deduped;
   (d) an escalated session with a non-retryable reason (`round_cap_reached`) is still deduped;
   (e) the guard updates nothing (lost race): the re-read row comes back with `deduplicated: true`, and there is no insert and no model call;
   (f) the boundary, for each change class (`STALE_AFTER_MS` minus 1 ms is deduped, plus 1 ms is re-run);
   (g) `isDeadRoundOne` returns false for a missing timestamp or an approved session;
   (h) partial failure: escalation succeeds and `insertSession` returns an error, so the call throws 502
   `store_error` and the old row is left `escalated` + `deadline_exceeded`. The next create with the same plan
   inserts a fresh session through the retryable branch and runs round 1 (`deduplicated: false`).
   The existing suites `services/gateway/test/vtid-04868-plan-sparring-service.test.ts` (989 lines, the mock
   template at `:31-112`, `makeDeps` at `:209-236`) and `services/gateway/test/vtid-04868-plan-sparring-repository.test.ts`
   exist on `origin/main` and must stay green.

## Recovery of the five stuck sessions
No data change in this plan. `PLAN-SPAR.yml:75` calls staging (`preview-aws-gateway.vitanaland.com`) by default,
and staging shares the production database. Once this merges and staging deploys, the next push to each of
the five specs runs `create`. The gateway escalates the dead row and starts a fresh session, so the spec
recovers on that push without using a session. (`step()` only calls `create` here, because `state.json` never
recorded the dead session.) Until then Claude Code may terminalize the five rows. That is a live write, so
Kiro does not do it.

## Out of scope
- A reaper or cron job. Item 1 fixes the only path that keeps a dead session alive, so a reaper adds moving parts for no gain.
- `plan-spar.mjs` (governance path) and the rounds endpoint (premises 4 and 5).
- Fixing the restart or concurrency that killed the passes.

## Overlap
`sparring-floor-retry` lane `floor-retry-code` (VTID-05240, `executor: claude`, not built yet) also edits the
`retryable` expression at `service.ts:250-251`. The two changes are independent: one widens the escalated
reasons, the other adds an in_progress branch. Whichever merges second rebases and keeps both, and
`deadline_exceeded` must stay in `RETRYABLE_REASONS` (the partial-failure recovery in item 1 relies on it; test (h)).

## Verification
- `cd services/gateway; npx jest test/plan-sparring-stale-session.test.ts test/vtid-04868-plan-sparring-service.test.ts test/vtid-04868-plan-sparring-repository.test.ts`: all pass.
- `cd services/gateway; npm run typecheck`: clean.
- Staging (rule 47, read-only): `docs/validation/<VTID>/staging-tests.json`, modelled on
  `docs/validation/VTID-05236/staging-tests.json`. GET `/alive` and GET `/api/v1/vtid/health` return 200. The
  behaviour itself needs a write (POST create), so Jest proves it.
<!-- plan:end -->
