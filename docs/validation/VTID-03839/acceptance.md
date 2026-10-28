# VTID-03839 — Operator on-ramp: `approved_by` must be a UUID

## Report

After VTID-03838 (operator prompt lists `autopilot_execute_task`) reached
staging (`ae833f6`, confirmed via `/api/v1/admin/build-info`), the real
on-ramp test for the already-approved, deliberately low-risk VTID-03829
("Gateway: add task-title unit tests") was repeated twice on
`preview-aws-gateway.vitanaland.com`.

**Attempt 1 (00:50 UTC)** — the tool WAS invoked this time (the VTID-03838
fix works live: `governance.evaluate` for `operator.autopilot.execute_task`
fired, `allowed`, L4). The safety gate then rejected with
`file_outside_allow_scope` for `services/gateway/src/utils/task-title.ts`.
That rejection was **self-inflicted**: `dev_autopilot_config.allow_scope`
(read-only check) covers `services/gateway/src/{services,routes,lib,orb,
types,frontend/command-hub}/**` and `services/gateway/test/**`, not
`src/utils/**`, and the request had listed the source file for a test-only
plan. `approveAutoExecute` re-extracts the file list from `plan_markdown`
(an explicit `## Files to modify` section wins — `extractFilePaths`), so the
plan text, not only `files_referenced`, decides what the gate sees.

**Attempt 2 (07:19 UTC)** — same request with a plan whose
`## Files to modify` lists only `services/gateway/test/task-title.test.ts`.
`governance.evaluate` allowed; the safety gate **passed**; then the
execution INSERT failed:

```
execution insert failed: 400: {"code":"22P02", "message":
"invalid input syntax for type uuid: \"operator-chat:e947d9bb-95b6-4b99-86c1-b5c75de27570\""}
```

Root cause, verified rather than assumed:

1. `dev_autopilot_executions.approved_by` is a `uuid` column
   (`information_schema.columns`, live).
2. `operator-execution-onramp.ts` called
   `approveAutoExecute({ finding_id, approved_by: input.requestedBy })`,
   and `requestedBy` is the label `operator-chat:<threadId>` set by
   `executeExecuteTask` in `gemini-operator.ts`.
3. Every other caller passes a real user UUID (`req.user.id` on the
   `/findings/:id/approve-auto-execute` routes) or nothing at all
   (`autoApproveTick`, where NULL is the documented system sentinel).
   The on-ramp is the only caller that ever put a non-UUID there.
4. The on-ramp relied on `approved_by` being set for a side effect:
   `approveAutoExecute` only 7-day-snoozes a safety-gate-rejected finding
   when `approved_by` is absent (`isAutoApprove = !input.approved_by`), and
   records the outcome as `approved` vs `auto_exec` on the same test.
   Dropping the label therefore needs those semantics carried by something
   else.

Fix:

- `ApprovalInput.interactive?: boolean` — an explicit "someone is waiting
  on this synchronously" flag. It suppresses the auto-snooze and records
  the outcome as `approved`, and never changes what is written to
  `approved_by`.
- The on-ramp passes `{ finding_id, interactive: true }` — no `approved_by`.
  The requester is still recorded on the recommendation
  (`spec_snapshot.requested_by`), the execution metadata (`triggered_by`)
  and the OASIS event; it just no longer goes into a uuid column.
- `approveAutoExecute` rejects a non-UUID `approved_by` **before any DB
  work**, naming the column and the `interactive` alternative. Previously
  the finding and plan rows were inserted and the whole safety gate ran
  before Postgres surfaced the type error.

## Acceptance Criteria

AC-1 — A non-UUID `approved_by` is rejected by `approveAutoExecute` before
any Supabase call, with an error that names the uuid column and the
`interactive` alternative.

TEST: `test/vtid-03839-onramp-approved-by-uuid.test.ts` — "rejects a
non-UUID approved_by BEFORE any DB access, naming the uuid column and the
interactive alternative"; `isUuidString` unit cases in the same file.

AC-2 — `interactive: true` with no `approved_by` reaches the execution
INSERT with `approved_by = null` and records a human `approved` outcome
(not `auto_exec`).

TEST: same file — "interactive request with no approved_by: inserts
approved_by = null and records a human "approved" outcome".

AC-3 — Existing callers are unchanged: a real user UUID is written
verbatim and recorded as `approved`; a system auto-approve (no
`approved_by`, not interactive) still writes null and records `auto_exec`.

TEST: same file — "a real user UUID still passes the pre-check and is
written verbatim" and "system auto-approve … is unchanged".

AC-4 — On a safety-gate rejection an interactive caller gets the
violation back and the finding is NOT snoozed; the same rejection without
`interactive` (unattended tick) still snoozes for 7 days (mutation check —
the flag is load-bearing).

TEST: same file — the two cases under "safety-gate rejection".

AC-5 — The on-ramp itself no longer passes its requester label as
`approved_by` and declares itself interactive.

TEST: `test/vtid-03820-operator-execution-onramp.test.ts` — "creates the
recommendation + plan rows, calls approveAutoExecute, and stamps the
DeepSeek override on success" (asserts `{ finding_id, interactive: true }`
and the absence of `approved_by`).

AC-6 — No regression: `tsc --noEmit` clean; the affected suites green;
full gateway suite green.

TEST: `outputs/tsc-noemit.txt` (exit 0); `outputs/jest-scoped-onramp.txt`
(5/5 suites, 56 tests); `outputs/jest-full-suite-tail.txt`.

## Live evidence

`outputs/staging-repro-2026-09-13.txt` — the real staging request, the
tool result, the `oasis_events` trace for the thread (read-only), the live
column type, and the two `autopilot_recommendations` rows the attempts
created.

## Not verified here — the next real signal

The fix is verified structurally and by regression. **It is not yet
verified against a live on-ramp run.** After this merges and
`AWS-STAGE-DEPLOY-GATEWAY.yml` redeploys staging, the exact attempt-2
request is to be repeated on staging. The informative outcomes are
`status: "queued"` (a real `dev_autopilot_executions` row, and later a
real PR titled "Operator on-ramp: VTID-03829") or the next specific gate
reason. Production promotion is a separate, later decision and is not
touched here.

Follow-up worth its own VTID, not done here: the VTID-03838 prompt rule
"list in files_referenced the source file(s) to change AND their test
file(s)" steers the model into listing the source file even for a
test-only plan, which is what produced attempt 1's self-inflicted
`file_outside_allow_scope`. The safety gate behaved correctly; the
wording should say "the files the plan will create or change — a
test-only plan lists only the test file".
