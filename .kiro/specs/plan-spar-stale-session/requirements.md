# Requirements — plan-spar-stale-session
Authoritative plan: `plan.md` (between the plan markers). This file adds acceptance criteria only.

## R1 — a dead round-1 session is re-run, not deduplicated
WHEN `POST /api/v1/plans/spar` matches an existing session (same producer + canonical plan hash) whose
`verdict` is `in_progress`, whose `rounds` is empty, which carries no human or policy approval, and whose
`updated_at` (or `created_at`) is older than `PASS_DEADLINE_MS[change_class] + 10 min`,
THEN the gateway marks that session `escalated` with `escalation_reasons = ['deadline_exceeded']`,
creates a new session, runs round 1, and answers `deduplicated: false`.

## R2 — live and finished sessions keep today's dedup
- An `in_progress` session inside deadline + margin is returned as is (no model call, no insert).
- An `in_progress` session that has at least one round (waiting on the planner) is returned as is, however old.
- An `escalated` session whose reasons are all non-retryable (e.g. `round_cap_reached`) is returned as is.
- A `converged` session is returned as is.

## R3 — race safety
The escalation is a guarded UPDATE (`verdict = 'in_progress'`, `updated_at < cutoff`, unapproved). WHEN it
updates no row, THEN the gateway re-reads the newest session and returns it with `deduplicated: true`. It does not
insert and does not call a model.

## R4 — no schema, client or data change
There is no migration. Only `service_role`-granted columns are written. `scripts/collab/plan-spar.mjs` and the
rounds endpoint are unchanged. The five stuck sessions recover on their spec's next PLAN-SPAR push once the
gateway PLAN-SPAR calls (staging by default) runs this code.

## R5 — tests
New Jest file `services/gateway/test/plan-sparring-stale-session.test.ts` covers R1–R3. The existing
`vtid-04868-plan-sparring-*` suites stay green, and `npm run typecheck` is clean.
