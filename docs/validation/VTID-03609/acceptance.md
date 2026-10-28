# VTID-03609 — Acceptance

**Title:** The ORB new-day briefing read its greeting facts before the pre-fetch that
populates them had resolved
**Relationship to VTID-03607:** VTID-03607 (merged in #3088) made the briefing
*reachable* on the normal ladder. It never fired. This VTID is why.

## What this PR changes

`services/gateway/src/routes/orb-live.ts`, inside `sendGreetingPromptToLiveAPI`:

1. The new-day pre-guard no longer reads `greetingFirstName`,
   `greetingIsFirstTime`, `greetingNeedsOnboarding` or `lastFullBriefingDate`.
   Those four come from the greeting-facts pre-fetch, whose copy onto the session
   (`live-session-controller.ts` L1367) seeds the still-null locals and only writes
   the real values when `session.greetingFactsReady` resolves. That promise is
   independent of `contextReadyPromise`, so reaching the sync ladder guarantees
   nothing about it — the pre-guard was reading nulls and rejecting.
2. The async branch now awaits `greetingFactsReady` with the same two bounded
   budgets the safe-fast block has always used (`ORB_GREETING_FACTS_WAIT_MS`, then
   `ORB_NEWDAY_FACTS_WAIT_MS` when the facts are still pending and
   `lastSessionInfo` is still unset), then RE-READS every pre-fetch-owned fact and
   recomputes the temporal bucket from the possibly-updated `lastSessionInfo`.
3. A new `newday_briefing_eval` diag reports one of six mutually exclusive
   outcomes so a non-firing briefing is never silent again.

No route added, removed, or re-mounted. No schema, migration, or config change.
No change to the greeting brain (`compute-greeting-decision.ts`) — its 35 golden
snapshots pass untouched.

## Acceptance criteria

AC-1 — The pre-guard reads no pre-fetch-owned fact.
TEST: `npx jest test/orb/live/characterization/vertex-wake-opener-v2.characterization.test.ts`
— "the pre-guard does NOT gate on any pre-fetch-owned fact" asserts none of
`greetingFirstName` / `greetingIsFirstTime` / `greetingNeedsOnboarding` /
`lastFullBriefingDate` appears between `const _ndGates = {` and
`const _newdaySyncPossible`. See `outputs/jest-affected-suites.txt`.

AC-2 — The wait happens BEFORE the decision context is built. This is the whole
defect, so it is pinned as an ordering assertion rather than a presence one.
TEST: same suite — "the branch awaits greetingFactsReady BEFORE building the
new-day context" asserts `indexOf('const _factsReadyNS') < indexOf('const _ctxNS: GreetingDecisionContext')`.

AC-3 — The context re-reads the facts rather than inheriting the stale sync
snapshot.
TEST: same suite — "the new-day context RE-READS the facts rather than inheriting
the sync snapshot" asserts the `_ctxNS` literal spreads `_baseCtxSync` AND
explicitly overrides `firstName`, `greetingIsFirstTime`, `greetingNeedsOnboarding`,
`lastFullBriefingDate` and `bucket`.

AC-4 — Both bounded waits use the same env budgets as the safe-fast path, so the
two cannot drift.
TEST: same suite — "both bounded waits use the same env budgets the safe-fast path
uses".

AC-5 — Every non-firing outcome is distinguishable in telemetry.
TEST: same suite — "every non-firing outcome emits a distinguishable
newday_briefing_eval" asserts all six of `pre_guard_rejected`, `guard_rejected`,
`gather_empty`, `payload_had_no_content`, `threw`, `fired` are emitted.

AC-6 — The greeting brain is unchanged: its golden snapshots pass without rewrite.
TEST: `npx jest test/services/conversation/compute-greeting-decision.golden.test.ts`
— 35 snapshots pass, none written. See `outputs/jest-affected-suites.txt`.

AC-7 — No stale `VTID-03593` reference survives anywhere under the gateway.
TEST: `grep -rn "VTID-03593" services/gateway/src services/gateway/test` returns no
matches. See `outputs/grep-no-stale-vtid.txt`.

## Route mount

ROUTE_MOUNT: none. `services/gateway/src/routes/orb-live.ts` is in the diff, but the
change is inside `sendGreetingPromptToLiveAPI` — a helper, not a route handler. No
`router.get/post/use` line is added, removed, or altered. The Route Mount Evidence
Gate fires on the file path rather than the nature of the change; these markers
record that the honest answer is "nothing mounted".

FINAL_URL: https://gateway.vitanaland.com/api/v1/orb/live/transport — an existing,
unchanged route in the touched file, used to show the router still serves normally.

CURL_PROOF: `curl -s -w '%{http_code} %{content_type}' https://gateway.vitanaland.com/api/v1/orb/live/transport`
→ `200 application/json; charset=utf-8` / `{"ok":true,"transport":"sse"}`.
JSON, not an HTML 404, so the route exists and is mounted. See
`outputs/curl-orb-live-transport.txt`.

## Production evidence

`outputs/prod-evidence.md` — the five due-but-unbriefed sessions, the
`user_journey` dates proving they were due, and the absence of
`greeting_context_pending` proving they reached the sync ladder. Also records the
live confirmation of the sibling VTID-03592 fix on the same traffic.

## Notes, including one about this pack's own method

An earlier local run of the new suite was reported as passing when it had in fact
**failed to load** — `ReferenceError: readFileSync is not defined`, because the
file imports `fs`/`path` as namespaces and the new block used bare names. A suite
that fails to load emits no per-test failure lines, so a grep for `✕` showed
nothing and the other suites' passing count was mistaken for success. CI caught
it. `commands.log` step 2 therefore runs the suite alone and reads the full
output, and the test names are listed there so the count cannot be confused with
a neighbouring suite's again. This is the same class of mistake CLAUDE.md records
for the Aurora integration suite ("a skipped suite is green").

Three characterization suites (`system-instruction`, `time-since`, `tool-catalog`)
fail to LOAD in this local checkout on `Cannot find module '@aws-sdk/client-polly'`
— incomplete local `node_modules`, not a repo state, and unrelated to this diff.
The `offer-integrity contract` suite has two failing tests that reproduce on a
clean tree with these commits stashed.
