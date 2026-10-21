# VTID-03927 — Fix three Command Hub observability gaps found while auditing whether Operator's work is trackable in real time

Found while directly reading the real Command Hub frontend/backend code to
answer the platform owner's question: "does the Operator communicate with
me about the status so that I can track and follow the ongoing process...
step by step?" Three independent, previously-undocumented gaps were found
by tracing the actual SSE endpoint, the actual per-VTID stage-timeline
builder, and the actual events this session's own VTID-03902/VTID-03913
work emits — not by assumption.

## Gap 1 — `GET /api/v1/events/stream`'s `channel` query param was dead code

The route's own doc comment has said since it was written that `channel`
filters the stream (e.g. `"operator"`), but the handler only ever read
`req.query.topic` and `req.query.vtid`. Command Hub's `startOperatorSse()`
requests `?channel=operator` expecting a scoped feed and silently got the
full platform-wide last-20-events firehose instead.

## Gap 2 — `buildStageTimeline()` froze `completedAt` at the first, not the last, success event

`sorted` events are ascending, but the SUCCESS branch used `.find()`,
which returns the FIRST matching completion event. Two governed spec-
pipeline events land in the same macro stage (`vtid.spec.generate.completed`
and, much later, `vtid.spec.approved` — both map to `PLANNER` via
`inferTaskStageFromType`), so `completedAt` froze at draft time and never
advanced to reflect the real (later) human approval.

## Gap 3 — `operator.planner.sweep_completed` mapped to no stage at all

`inferTaskStageFromType()`'s keyword list has no match for
`"operator.planner.sweep_completed"`, and `emitOasisEvent()` never writes
a `kind`/`title` column for `buildStageTimeline()`'s fallback matcher to
use either — so this event (VTID-03902's own planner-sweep summary) was
invisible in every VTID-03902 stage-timeline view.

## Fix

1. `services/gateway/src/routes/events.ts` — `channel` now maps to the
   existing `surface` column (already written as `'operator'`/`'orb'` by
   `conversation.ts`/`tenant-specialists.ts`), so the filter does real work
   against a column with real, already-populated semantics instead of a
   new invented one.
2. `services/gateway/src/lib/stage-mapping.ts` — the SUCCESS branch's
   `completedEvent` lookup now takes the LAST matching event
   (`[...sorted].reverse().find(...)`) instead of the first, so a stage's
   completion timestamp reflects the most recent thing that finished it.
3. `services/gateway/src/services/operator-planner.ts` — the sweep-summary
   `emitOasisEvent()` call now sets `task_stage: 'PLANNER'` explicitly
   (the field the type already supports, per VTID-01874), rather than
   relying on keyword inference that this event's type string can never
   satisfy.

---

AC-1 — `channel=operator` filters the SSE poll query to `surface=eq.operator`

TEST: `test/events-stream-channel-filter.test.ts` — "translates
channel=operator into surface=eq.operator on the oasis_events query"
Output: outputs/targeted-tests.txt

AC-2 — no `channel` param means no `surface` filter is applied (unfiltered
firehose behavior is preserved for every existing caller that doesn't pass
`channel`)

TEST: `test/events-stream-channel-filter.test.ts` — "omits the surface
filter entirely when no channel is passed"
Output: outputs/targeted-tests.txt

AC-3 — `channel` composes correctly with the pre-existing `vtid`/`topic`
filters

TEST: `test/events-stream-channel-filter.test.ts` — "still applies
vtid/topic filters alongside channel"
Output: outputs/targeted-tests.txt

AC-4 — a stage with two success events uses the LATEST one's timestamp as
`completedAt`, not the first

TEST: `test/stage-mapping.test.ts` — "should use the LATEST completion
event, not the first, when a stage has multiple success events"
Output: outputs/targeted-tests.txt
Mutation-verified: reverting `[...sorted].reverse().find(...)` back to
`sorted.find(...)` fails this test (received the draft timestamp instead
of the approval timestamp); restoring the fix passes again.

AC-5 — every pre-existing `stage-mapping.test.ts` scenario (single-event
stages, error priority, in-progress, VTID filtering, startedAt/errorAt
timestamps) is unaffected by the completedAt fix

TEST: `test/stage-mapping.test.ts` (full file)
Output: outputs/targeted-tests.txt

AC-6 — `operator.planner.sweep_completed` now carries `task_stage:
'PLANNER'` explicitly

TEST: `test/operator-planner.test.ts` — "generates a spec for each found
task and emits one summary event" (extended with the `task_stage`
assertion)
Output: outputs/targeted-tests.txt

AC-7 — no regression to the existing gateway test suite or type-checking

TEST: `npx jest` (full suite)
Output: outputs/full-suite.txt
TEST: `npx tsc --noEmit`
Output: outputs/tsc.txt
Note: `outputs/tsc.txt` and `outputs/full-suite.txt` both show 2 pre-existing,
unrelated failures — `Cannot find module '@aws-sdk/s3-request-presigner'`
and `'@aws-sdk/client-cognito-identity-provider'` — both declared in
`package.json` but not present in this session's `node_modules` (a stale
local install, not a code defect). Confirmed unrelated: neither package is
referenced by any file this VTID touches, and `git blame`/diff show zero
changes to `s3-storage.ts`/`cognito-auth-client.ts`, the two files that
`require()` them. CI's own `npm ci` in the Build Gate step installs from
the committed lockfile fresh, which does not carry this local gap forward.
