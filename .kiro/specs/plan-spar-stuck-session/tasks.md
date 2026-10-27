# Tasks — plan-spar-stuck-session
Authoritative plan: `plan.md`. VTID from CI PLAN-SPAR. Branch `claude/plan-spar-stuck-session/stuck-recovery` (or
`kiro/…` when the exceptions seat builds it), PR title `VTID-xxxxx (plan-spar-stuck-session/stuck-recovery): …`.

<!-- lane: stuck-recovery -->
## Lane `stuck-recovery` (executor claude; protected gate files)
- [ ] T1 apply `proposed.patch`; record red on `origin/main` (tests without the source changes) and green.
- [ ] T2 `npx jest test/plan-sparring-stuck-session.test.ts test/plan-sparring-stale-session.test.ts`,
      `node --test scripts/collab/*.test.mjs`, gateway `tsc --noEmit`; evidence in `docs/validation/<VTID>/`.
- [ ] T3 staging deploy → STAGING-VERIFY (a read-only `GET /api/v1/plans/spar/:id` probe of an existing session).

**Acceptance**
- Only the lane's paths change; the review rules of plan §4 are untouched (no edit to prompts, `submit_review`,
  evidence floor, round caps, convergence, `MAX_SESSIONS`, approval, allocation).
- Every plan §3.4 case is a test, red on base, green on head.
- Protected gate files: merged only with a legacy Claude review on the current head or an owner instruction naming
  this plan (collaboration.md §3a).
