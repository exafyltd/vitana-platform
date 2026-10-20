# VTID-05254 — Plan sparring: re-run dead in_progress round-1 sessions

Plan: `.kiro/specs/plan-spar-stale-session/` (branch `kiro/plan-spar-stale-session/plan`), converged in 2 rounds,
approved by policy `converged-auto-v1`. All tests use in-memory fakes; no gateway, Supabase, Bedrock or GitHub call.

AC-1: A session that is `in_progress`, has 0 rounds, no human/policy approval and was last updated more than `STALE_AFTER_MS` (60 min) ago is escalated `deadline_exceeded` and round 1 runs on a fresh session (`deduplicated: false`).
TEST: services/gateway/test/plan-sparring-stale-session.test.ts — "(a) escalates a stale in_progress session with 0 rounds and re-runs round 1 on a fresh session"

AC-2: A fresh `in_progress` session (under 60 min), a session that already has a round, and an escalation with a non-retryable reason are still deduplicated, with no model call.
TEST: services/gateway/test/plan-sparring-stale-session.test.ts — "(b) …", "(c) …", "(d) an escalated session with a non-retryable reason is still deduped"

AC-3: The existing retryable-escalation path (`model_unavailable`) is unchanged.
TEST: services/gateway/test/plan-sparring-stale-session.test.ts — "(d2) the existing retryable-escalated path is unchanged"

AC-4: The boundary is exact for every change class: `STALE_AFTER_MS - 1 ms` is deduped, `+ 1 ms` is re-run.
TEST: services/gateway/test/plan-sparring-stale-session.test.ts — "(f) boundary, light|standard|expedited"

AC-5: A lost race returns the re-read row with `deduplicated: true` and inserts nothing; a store error answers 502 `store_error`; a failed insert after escalation recovers on the next create.
TEST: services/gateway/test/plan-sparring-stale-session.test.ts — "(e) lost race …", "(h) partial failure …", "(i) a store error from the escalation throws 502 store_error …"

AC-6: `escalateDeadRoundOne` updates only an unapproved `in_progress` row whose `updated_at` is older than the cutoff.
TEST: services/gateway/test/plan-sparring-stale-session.test.ts — "updates only an unapproved in_progress row older than the cutoff and selects the ids"

AC-7: The existing plan-sparring service and repository suites still pass.
TEST: services/gateway/test/vtid-04868-plan-sparring-service.test.ts, services/gateway/test/vtid-04868-plan-sparring-repository.test.ts

Outputs: `outputs/jest-plan-sparring.txt`, `outputs/typecheck.txt`.
