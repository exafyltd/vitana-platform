Change types: Backend.
# VTID-05736 acceptance (agentic-delivery-scope/dispatcher-pm)

Outcome: a parked lane with a retryable reason is retried by the machine on the 15/30/60/120/240/480 min schedule and, after the 6th
attempt in 24 hours, recorded as blocked with `next_actor: owner`. The schedule is lane `dispatcher` (VTID-05737, `retry.ts`).

AC-1 Dry run decides and writes nothing. TEST: services/gateway/test/project-manager/retry-act.test.ts "act: dry_run writes nothing" (dry_run, off).
AC-2 A live tick unparks the lane to `parked_from` through the pm-agent lane writer, sets `next_actor` to the lane's executor, logs
`retry attempt N of 6 (...)` and records OASIS `delivery.retry.scheduled`. Only `state`, `next_actor` and `updated` of the lane file change
and the log gets one entry. TEST: retry-act.test.ts "live: unparks to parked_from", "only the PM keys of the lane file change on a retry".
AC-3 After the 6th attempt: `delivery.blocked` (status warning), the lane stays parked with `next_actor: owner`, recorded once, never retried
again when the 24 h window slides on. TEST: retry-act.test.ts "the 6th attempt spent", "after the 6th attempt the end is a single blocked decision".
AC-4 Never retried: security or data-loss risk, a production write, a protected file without its reviews, an escalated sparring verdict, any
unknown reason, and the PM's own `reviewer_flagged_risk` and `stale_claim`. TEST: retry-act.test.ts "never retries a lane parked for %s".
AC-5 The PM's own guards stay: live mode only, the lease, the pm-agent writer; a failing event write never undoes the unpark; the act layer still
has no merge, Gate 2, deploy, dispatch or VTID seam for a retry. TEST: retry-act.test.ts "the lease still gates it", "a failing event write",
the fake merge and Gate 2 seams throw if reached.
AC-6 The history is the lane log the PM wrote, so it works across ticks: park -> 6 retries -> blocked -> quiet, over a real lane file
(applyLaneChange -> parseLaneLog -> parkInfoOf -> decide -> act). TEST: retry-act.test.ts "the loop over a real lane file".
AC-7 Nothing else moved: the 14 other project-manager suites pass unchanged (286 tests). outputs/green-pm-suites.txt.

Staging proof: not verified on staging. The PM runs in dry-run there (PM_AGENT_ENABLED=false); covered by the lane tests.
No address in the diff, the PR body, a commit message or this folder.
