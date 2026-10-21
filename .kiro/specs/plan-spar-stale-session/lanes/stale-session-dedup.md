---
lane: stale-session-dedup
state: in-review
next_actor: kiro
pr: https://github.com/exafyltd/vitana-platform/pull/4208
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: exafyltd
paths:
  - services/gateway/src/services/plan-sparring/plan-sparring-service.ts
  - services/gateway/src/services/plan-sparring/plan-sparring-repository.ts
  - services/gateway/test/plan-sparring-stale-session.test.ts
  - docs/validation/**
updated: 2026-10-20T10:28Z
vtid: VTID-05254
---
# stale-session-dedup — re-run dead round-1 sparring sessions (repo vitana-platform)
Plan: `.kiro/specs/plan-spar-stale-session/plan.md` and the `stale-session-dedup` section of `tasks.md`
(S1–S4, allowed paths, acceptance). Design: `design.md`.
**Held until PLAN-SPAR allocates this lane's VTID.** This is `services/gateway/src/**`, which is not a
governance path (`.github/**`, `.claude/**`, `.kiro/steering/**`, `.kiro/automations/**`, `scripts/collab/**`,
`CLAUDE.md`, `docs/programs/areas.yaml`), so a Kiro lane may change it. `scripts/collab/plan-spar.mjs` is out
of scope. `docs/validation/**` is only for this lane's own `docs/validation/<VTID>/` record.
Executor rules (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md` or another
lane, no merge/approve/deploy/dispatch, no Supabase or AWS writes. Do not terminalize the five stuck sessions
yourself. Branch `kiro/plan-spar-stale-session/stale-session-dedup`; PR title
`VTID-xxxxx (plan-spar-stale-session/stale-session-dedup): …`; trailers `Collab-Session`/`Collab-Lane`.
On PR open: `state: in-review`, `next_actor: kiro`, `pr: <url>`, a log entry, then release the claim.
## Log
### 2026-10-20T10:00Z · kiro-hotmail-202610151618-b437 · created → ready
Created and held. Premise: `createSparringSession` dedup (`plan-sparring-service.ts:246-253`) returns a
dead `in_progress` session with 0 rounds forever, because only an escalated session with a retryable reason
(`:46`) is re-run. Reviewer seat `exafyltd` (≠ `hotmail`).

### 2026-10-20T10:13Z · ci-plan-spar · ready (VTID allocated)
VTID-05254 allocated after policy approval (converged-auto-v1).

### 2026-10-20T10:28:14Z · kiro-hotmail-202610151618-b437 · ready → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4208, head `c6f3f0f06a40fd7bc13f298f80a28cf818130d6a`.
Tests: stale-session 17/17, with vtid-04868 service+repository 79/79, plan-sparring 117 passed/1 skipped; typecheck clean.
