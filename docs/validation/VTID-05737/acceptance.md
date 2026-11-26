Change types: Backend.
# VTID-05737 acceptance (agentic-delivery-scope/dispatcher)

Outcome: the retry schedule and eligibility of the Project Manager exist as tested pure functions (`nextRetry`, `isRetryable`,
`retryDue`). Nothing calls them yet; lane `dispatcher-pm` (VTID-05736) wires them.

AC-1 Schedule: attempt n is due 15, 30, 60, 120, 240, 480 minutes after the previous attempt (the first after the lane was parked).
TEST: services/gateway/test/project-manager/retry.test.ts "nextRetry: the schedule" (first attempt, six-step schedule).

AC-2 At most 6 attempts in 24 hours: the 7th is `{blocked: true, reason: 'attempts_exhausted', next_actor: 'owner'}`; attempts older than
the window do not count, so a lane parked again a day later starts over.
TEST: retry.test.ts "the 7th attempt inside 24 h is blocked", "attempts older than 24 h no longer count", "counts only the attempts inside the window".

AC-3 Never retried: security or data-loss risk, a production write, a protected-file merge without its reviews, an escalated sparring
verdict, and any reason the module does not know (fail closed). Retryable: failed check, model tier unavailable, missing prerequisite,
infrastructure failure.
TEST: retry.test.ts "isRetryable", "nextRetry: never retried".

AC-4 Contract: pure, no I/O, no clock; the inputs are not changed; unusable numbers block with `invalid_input` instead of throwing.
TEST: retry.test.ts "nextRetry: purity", "unusable times block instead of throwing".

Staging proof: not verified on staging. Nothing calls the functions until `dispatcher-pm`.
No address in the diff, the PR body, a commit message or this folder.
