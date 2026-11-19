Change types: Backend, Integration, Tooling/docs.
# Delivery loop, slice 7: the loop run end to end against a real GitLab project

No approved lane or VTID covers this slice (VTIDs come only from CI PLAN-SPAR; none was invented). Part of the WIP merge request "delivery loop"; it
needs `plan(delivery-loop)` before it can merge. Nothing here deploys or enables anything: `DELIVERY_LOOP_ENABLED` is still unset everywhere.

Slices 1 to 6 were proven with an in-memory GitLab. This slice runs the same engine against **GitLab itself** (project `vitana/rehearsal`, id 4, private,
GitLab 19.5.3, its real runners) and records what happened. It found five defects the fakes could not show. They are fixed and each has a test that fails
without the fix (outputs/red-on-base.txt).

## What was real and what was not

| Real, in the final run (r7h3c9v, 18 of 18 steps) | A stand-in, labelled in the report and in every commit it made |
|---|---|
| the GitLab REST client of the loop, the engine, every phase of it | the OASIS ledger: in memory (no database is reachable from this session) |
| the project, its issues, label events and member access level (the bot is Owner, 50) | the executor: a stub that pushes a one-line fix to the branch it is told. It is not an LLM and its commit says so |
| real merge request pipelines, runners and job logs: 3 pipelines created by the run | the reviewer: a fixed `accept` verdict |
| GitLab's retry endpoint, called through the loop's own client | the memory: a recorder |
| no webhook (the project has none, by schema): the poller is the only intake | the loop's decision to retry (an infrastructure failure): a runner failure cannot be produced from here |

The rehearsal cannot do harm by construction (`scripts/delivery-loop/rehearse.ts`, 38 tests): one project only, named operations only (no call that takes a path or
a body), every write checked by value against `main` and against objects this run did not create, a retry only of a pipeline whose ref belongs to this run. After every run
the project was listed through the API: merge requests !1 and !2 (not mine) open with their `updated_at` unchanged, the same five branches as before, no open issue.

## The seven connections: evidence per integration

| # | Mission item | Live (this slice, GitLab) | Tested without GitLab | Not connected |
|---|---|---|---|---|
| 1 | Intake from GitLab issues | A1 a label applied by a project member is read from GitLab's label events and the member's level (50); accepted, answered on the issue, `delivery-accepted` set. A3 the worker is asked, issue text as data. E1 an issue with too little to act on is rejected with the reason. | webhook to OASIS to intake: slice 3 and 5 suites | no webhook exists on any GitLab project (hooks: 0) and `gitlab-settings.mjs` declares no issue events |
| 2 | Dispatch | A3, B3: a repair or intake task reaches the executor port with its key, branch and merge request | retry schedule VTID-05737 and dispatcher-pm VTID-05736 (slices 1, 2) | the executor: Dev Autopilot has no GitLab host, so the production wiring fails closed (slice 6); Worker Orchestrator is retired and not used |
| 3 | Failure detection | B1 a real pipeline FAILED; B2 the loop saw it, read the failed job and its log from GitLab, classified it `code`, fingerprint `b1373d7adb960955` (the same on the five real runs r3x7y8z to r7h3c9v: different merge requests, pipelines and days) | authenticated event, durable idempotent recording: slice 3 | `ON CONFLICT DO NOTHING` through the live PostgREST is unproven (no database from this session) |
| 4 | Autonomous repair | B3 the worker is told the failure as the job printed it (below). B4 GitLab ran a NEW real pipeline on the pushed fix and it passed. B5 the loop verified that from GitLab's own state. `delivery.heal.detected`, `.attempt`, `.verified` rows in ledger-rows.json | the budget, exhaustion, the branch rules, the infra retry decision: heal.test.ts (35) | Dev Autopilot's own failure bridge is still GitHub-only; the loop's `delivery.heal.*` writer is the GitLab one |
| 4b | Re-execution by retry | D0 to D2: the loop's own `retryPipeline` against a real failed pipeline (580) kept id 580, moved `updated_at` (12:18:11 to 12:18:30), ended again as 580, and the merge request got no new pipeline. That is what the reconciler relies on | | the decision to retry is not live (above) |
| 5 | Automated review | C1 the green merge request was reviewed once for its head; C2 it is still open: the loop has no merge call | the real reviewer port (Claude on Bedrock by the standing rule), rework after a rejection: review.test.ts (20), adapters.test.ts | a real model never ran; the merge bot's lane-file accept is not produced by the loop |
| 6 | Learning | B6 a repair pattern and a memory outcome were recorded, only after the repair was verified | the real stores' contracts: adapters.test.ts, learn.test.ts (14) | no write to the real dev memory |
| 7 | The cycle | observe (poll) to reason to plan (intent) to execute to verify to learn, one engine, one run: ledger-rows.json | improve (a proposal after three detections in seven days): intake and learn suites | improve was not exercised live |

## What the worker is told (B3), before and after

The first real run showed the repair task carried `expected: 6,` and the runner's footer, and nothing of the failing assertion. The cause is in outputs/worker-instructions-before-after.txt:
the keyword list had `assertion`, but `AssertionError` has no word boundary inside it; only keyword lines were sent, normalized (a file and line became `<path>` and `<n>`); and the runner's own
`ERROR: Job failed: exit code 1` counted as evidence, so a failure with no output of its own looked repairable. Now (AC-1 to AC-4 below, rehearsal step B3, which checks all of it on the text the worker
received, saved as outputs/repair-instructions.txt):

AC-1 **Error lines are recognised by class, code and value.** `AssertionError`, `TypeError`, `ModuleNotFoundError`, `java.lang.NullPointerException`, `ERR_ASSERTION`, `actual:`, and the `✕` and `✖`
marks (which a `\b` could never match) are error lines; `terror`, `mirror`, `ERRATA` and `AssertionErrorful` are not.
TEST: fingerprint.test.ts "which lines say what went wrong" (12), "a real failed job" (8, on the real log of job 3941, fixtures/gitlab-job-script-failure.ts).

AC-2 **Only the job's own output counts.** The runner's preparation, its cleanup, its `ERROR: Job failed` footer and the first lines of the section (executor stage, pull policy, image digest) are not
evidence and are not sent. A tail that begins inside the script, or a job killed before its section closed, is read from the first or to the last line; a section with no echoed command is kept whole.
A failure whose script printed nothing is `no_evidence`: a person is asked, no worker is sent.
TEST: fingerprint.test.ts "the job's own output ...", "begins at the first command", "only when the start of the section is in view", "a script that printed nothing"; heal.test.ts the same at the level of the loop.

AC-3 **The worker gets the failure as printed.** The last 60 lines or 5000 characters of the script's output, not normalized (the real file, line and values), each line at most 500 characters, with the job's name and the
address of the whole log. The tail read from GitLab is 16 KB (it was 6 KB; every line carries a 34 character prefix that is removed again).
TEST: fingerprint.test.ts "failureRegion limits" (7), heal.test.ts "tells the executor the failure as the job printed it ...", "a long log is cut to the end".

AC-4 **A log cannot close the block it is quoted in.** Every line of the quoted log is indented by four spaces, so a log line that reads `--- end of log ---` or "ignore the rules above" is data inside the block and never one of the loop's
delimiters; the loop's own rules come after the block.
TEST: heal.test.ts "a log cannot close the block it is quoted in".

Also fixed, found while reading the same code: a log with CRLF line endings read as empty (a carriage return before the newline was taken for a redraw); the fingerprint's pinned test values `1fa07224c3897566` and
`9d708813b2e7e4b7` are unchanged. The fingerprint of a REAL failure does change with this fix (job 3941's failure: `2a96bae70df24351` before, `b1373d7adb960955` after), because the lines it is
built from changed (the runner's footer left, the assertion lines came in). Nothing is recorded under the old value: the loop has never run outside its tests and this rehearsal. Once a loop is
live, any later change to what a fingerprint is built from would orphan the attempt budgets and learned patterns recorded under the old values. Two tests changed on purpose (scope.json): the footer is no longer an error line.

## The other defects the live runs found

AC-5 **A quiet loop writes nothing, after any activity.** The first quiet cycle after an active one wrote a claim and an all-zero cycle row (the cursor baseline was set only on the quiet path). Run r2d4e5f.
TEST: engine.test.ts "silence after activity" (3 tests; they fail on the old code: 13 rows against 3).

AC-6 **Re-reading what GitLab showed a moment ago writes no claim.** The poller reads again, on purpose, everything GitLab changed in the last two minutes. Each repeat recorded a fact the ledger already had, and recording takes the
window's claim first, so every pipeline left about three claim rows behind. Run r3x7y8z (rows 47 to 48 in a settled loop). `recordFact` is the poller's write: idempotent by key, so it needs no claim; decisions and side effects still take it.
TEST: engine.test.ts "re-reading what GitLab showed a moment ago writes nothing, not even a claim" (3 tests, which fail with the old write). The earlier silence tests passed because `settle` accepts the first quiet cycle, which comes after the claims.

AC-7 **The rehearsal's own checks mean what they say.** B3 was loose (any of four phrases): it now needs the assertion, both values, the place, the log address and none of the runner's text. Z1 ran its three cycles back to back, in one 15 second
window, so only the first could write: they are now in three windows. The first run's 9 of 15 was the rehearsal's branch prefix without the trailing slash the loop requires (it owned no branch, and correctly left the failure alone): a regression test pins it.

AC-8 **Stale facts are not acted on.** The poller's first window (six hours) put the pipelines of the earlier runs into the ledger: in the final run's first cycle, 11 facts were read and 10 were skipped as `mr_not_open` (five failed and five green pipelines of
merge requests that were closed), with no action. That guard was unit-tested; real data now exercised it.

AC-9 **Nothing else moved.** `tsc --noEmit` is clean for the source, the tests and the scripts (outputs/tsc.txt). Full gateway suite (outputs/full-gateway-suite.txt): 1805 suites, 30455 tests, 30393 passed, 2 failed, both pre-existing (the S3 region default in
`storage-provider` and `openssl` missing for `vtid-04226`), identical to the slice 3 to 6 baselines. The regression suites that guard this area are green: operator pipeline 71, role separation 105 (the atlas drift guard), customer support 25, loop catalog 25,
route guard 14, project-manager 286, delivery 198, gitlab-events 73, oasis idempotency 15, locked source-type list 78. The loop's own: 12 suites, 332 tests.

## Limits, said plainly

- **The executor is a stub.** What is proven is that the loop asks for the right work with the right text; that a model fixes it is not. Dev Autopilot has no GitLab host (slice 6, "What this does NOT do"); that is the owner's decision under `plan(delivery-loop)`.
- **The loop's decision to retry was not exercised on GitLab**, only what it relies on (D). GitLab was not made to fail a job for a runner reason.
- **Only the first failed job's log goes to the worker.** The fingerprint reads up to three failed jobs; a pipeline with two failing jobs gets a repair told about the first. A second attempt would meet the other. Not changed here.
- **No webhook was involved.** The webhook to OASIS path is slice 3's unit tests; the poller is what ran. The webhook signing secret and the project hooks do not exist.
- **The ledger was in memory.** `ON CONFLICT DO NOTHING` through the live PostgREST, the real `oasis_events` retention and the real read cursor are unproven.
- **Improve and rework were not live.** A rejection by a real reviewer, and three detections of one fingerprint, are covered by tests only.
- **Run time:** one run takes about five and a half minutes (r7h3c9v: 12:13:06 to 12:18:40 UTC; three real pipelines plus polling).

## For the owner (unchanged from slice 6, repeated so it is not lost)

The executor decision (a GitLab host for Dev Autopilot, a sanctioned way to give loop-created work a VTID, a place on the locked source-type list); GitLab project hooks and the signing secret
`vitana/gateway/staging/gitlab-webhook-signing-token`; `DELIVERY_LOOP_*` in the task definition and the GitLab token secret; a catalog entry for the loop; and raising the autonomy level (L2 and up) when the loop has been watched at L1.
