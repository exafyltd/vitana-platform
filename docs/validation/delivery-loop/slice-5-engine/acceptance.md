Change types: Backend, Integration.
# Delivery loop, slice 5: the engine (intake, dispatch, heal, verify, review, learn, improve)

No approved lane or VTID covers this slice (VTIDs come only from CI PLAN-SPAR; none was invented). Part of the WIP merge request "delivery
loop"; it needs `plan(delivery-loop)` before it can merge. New code only (`services/gateway/src/services/delivery-loop/`); nothing is wired into
`index.ts` yet, so nothing runs in any environment until slice 8, and then only behind `DELIVERY_LOOP_ENABLED=true`.

There was no "Central Loop Engine" in the repository (the loop catalog is documentation plus a read-only route, and the loops run as separate
timers). This slice builds it. Every claim below is about the code in this change and its tests; nothing was run against a live gateway, a
live database or a live worker (none is reachable from this session).

## The loop, per mission item

| # | Mission item | Where | What it does |
|---|---|---|---|
| 1 | Autonomous intake | `intake.ts`, `poll.ts` | A GitLab issue with the intake label (`DELIVERY_INTAKE_LABEL`, default `agent-task`) is read from the webhook rows (slice 3) or polled from GitLab. It is accepted or rejected with a reason; an accepted issue becomes an intent and a note on the issue. |
| 2 | Dispatch | `intents.ts`, `drive.ts`, `ports.ts` | The intent is carried out by the executor through `TaskPort` (the governed Dev Autopilot path; adapter in slice 6), or a failed pipeline is retried through GitLab. Only at L3 with the execution plane armed. |
| 3 | Failure detection | `heal.ts`, `poll.ts`, slice 3 | A failed pipeline (webhook row, or polled under the same dedupe key) is classified from GitLab's `failure_reason` and the normalized log. |
| 4 | Autonomous repair | `heal.ts`, `drive.ts` | `infra` failure: retry the failed jobs. `code` failure with evidence: a repair task on the branch's own merge request. At most 3 attempts per branch per day, then a person. The `delivery.heal.*` events are written here. |
| 5 | Automated review | `review.ts`, `ports.ts` | A green merge request of an owned branch is reviewed once per head; "changes" becomes a rework on the same branch, at most 2 rounds, then a person. |
| 6 | Learning | `learn.ts`, `ports.ts` | Verified repairs, exhausted repairs and reworks become memory and repair patterns, retried until the memory takes them. |
| 7 | Loop engineering | `engine.ts` | observe, reason, plan, execute, verify, learn, improve in one cycle, one gateway task per window, with a durable cursor. |

## Acceptance criteria and the tests that prove them

AC-1 **Intake is attributed and bounded.** The label must have been applied by a project member of at least Developer access (a Guest or
Reporter can label an issue; that is not a request). A confidential issue, a description under 20 characters, a label of unknown origin and a
label by a non-member are each rejected with a reason said on the issue. The text of an issue is never written to OASIS.
TEST: test/delivery-loop/intake.test.ts (30 tests): `evaluateIssue`, "who applied the label counts", "never writes the issue text to OASIS".

AC-2 **Decisions survive a change of level.** Every unit of work is recorded as an intent (and every GitLab note as a requested note) at L1 and
above, and carried out only when the level allows it. Raising the level later acts on what was already decided, and nothing is decided twice.
L1 writes nothing to GitLab and starts nothing; L2 adds notes and labels; L3 with the execution plane armed executes. A disarmed plane executes
nothing and arming it later does.
TEST: intake.test.ts "what the level allows", heal.test.ts "what the level allows for a heal", review.test.ts "needs L2", "at L2 the rework is decided and said".

AC-3 **A failure is classified, then retried or repaired, within a budget.** `script_failure` with evidence in the log is a repair; every failed
job failed for the runner or GitLab (`runner_system_failure`, `stuck_or_timeout_failure`, ...) is a retry of the failed jobs; a failure with no
evidence, or one GitLab does not explain, is not tried and a person is asked. The budget is per branch per 24 h (3 by default), not per failure,
so a new failure after each repair cannot keep the loop going. A log GitLab cannot be reached for is never mistaken for "no evidence".
TEST: heal.test.ts: `decideHeal` (3 tests), "a failed pipeline of a branch the loop owns", "the attempts and their end" (31 tests in the file).

AC-4 **A repair is verified from GitLab's own state.** A green pipeline after an attempt verifies the heal; a red one is the attempt's result
and asks for the next; a branch with no pipeline after the attempt's timeout counts the attempt as spent. A retried pipeline keeps its id and
so produces no new webhook fact: the reconciler reads the branch's pipeline, so a retry that goes green is verified without any fact.
TEST: heal.test.ts "a retried pipeline that goes green is verified without any new fact", "a repair that goes green is verified", "an attempt that produced nothing".

AC-5 **The loop touches only what it owns.** It repairs and reviews only the branches with the configured prefixes (`dev-autopilot/`,
`delivery-loop/` by default). Lane branches of the Kiro and Claude sessions, a person's feature branch, tags and (unless the owner asks) `main`
are left alone, and a repair of `main` is made on a branch of its own, never pushed to `main`. A project outside `DELIVERY_LOOP_PROJECTS` is never read.
TEST: heal.test.ts "what the loop leaves alone", controls.test.ts "the branches the loop owns" (5 tests), engine.test.ts poller "leaves branches the loop does not own alone".

AC-6 **Review is bounded and never merges.** A merge request is reviewed once per head and only when its pipeline is the head's and it is not a
draft; a verdict about another commit acts on nothing; "changes" is a rework on the same branch for at most 2 rounds (one unit of work per
round), then a person. The loop has no merge call at all.
TEST: review.test.ts (20 tests).

AC-7 **Learning is not lost to an outage.** Lessons are written by a sweep over the outcome rows of the last day, and the row that says "learned"
is written only after the memory accepted it, so a memory that is down is retried next cycle and a lesson is written once.
A failure that is detected 3 times in 7 days becomes one proposal per week as a GitLab issue labeled `delivery-proposal`, which is not the intake
label: a proposal never becomes a task until a person labels it.
TEST: learn.test.ts (14 tests).

AC-8 **One gateway task runs a window, the loop keeps no state, and a quiet loop is silent.** The claim is a ledger row with an idempotency key per
window, taken only before the first write or side effect; a task with nothing to do takes nothing and writes nothing. The cursor is `(created_at,
id)` and is stored in the cycle row, so a restart resumes. A failure of the world (GitLab or OASIS down) stops the cycle at the fact it hit and
passes nothing; a fact whose own handling fails three times is recorded as blocked and passed. The action budget (default 5 per cycle, 0 to 50)
counts notes, executions and retries; a cycle that hits it stops at that fact and finishes it next cycle.
TEST: engine.test.ts (19 tests), including the end-to-end test: issue, merge request, failed pipeline, repair, green, verified, reviewed, learned, then silence.

## Defects the tests found in this slice's own first draft (fixed, each covered by a test)

- The poller announced an answered issue as new on every poll, forever: the loop's own comment moves the issue's `updated_at`. Facts are now keyed by the issue's content version.
- One issue seen by the webhook, the poller and a label event produced several rejection decisions and notes. Rejections are keyed by (reason, content version).
- A note skipped below L2 was lost once the cursor passed its fact. Notes are now requested at L1 and posted by a sweep when the level allows.
- A failed label update after a successful comment repeated the comment. The comment and the labels are now two recorded steps.
- A repeat attempt at a repair found its first, finished intent and created no second one; the same for rework rounds. Intents of attempt-type work are only reused while open.
- A cycle with nothing to do wrote a claim and a cycle row. Claiming is lazy and the cycle row is written only when the cursor moves.
- A reviewer outage would have set a merge request's fact aside after three cycles. It is the world failing and is retried without limit.

## What this does NOT prove

- Nothing here ran against a live gateway, OASIS, GitLab webhook, worker or LLM. The tests use a fake GitLab (modelled on GitLab 19.5.3 responses
  read in slice 4), an in-memory ledger that models PostgREST's primary-key behaviour (slice 3), and fakes for the executor, reviewer and memory.
- The executor adapter does not exist yet (slice 6): `TaskPort` is the contract it must meet, and the loop's dispatch is only as real as that adapter.
  An executor that opens its merge request on GitLab does not exist in the repository today (Dev Autopilot is GitHub-only).
- The reviewer and memory adapters do not exist yet (slice 7).
- Whether `ensureIntent` and the sweeps scale: they query the ledger several times per intent per cycle. Bounded (100 intents, 50 rows per sweep), but unmeasured.
- A comment is not an idempotent GitLab write. The loop records it before and after, so a crash between the comment and its record repeats it once.
