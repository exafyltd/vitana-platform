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
updated: 2026-10-20T12:18Z
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

### 2026-10-20T12:18Z · kiro-hotmail-202610151618-b437 · merged (§7b owner-directed)
Owner instruction in conversation 2026-10-20: "you do it, claude is off , you have to do it, we have changed the
rule" (in reply to the list naming #4172, #4206, #4208), under collaboration.md §7b. Staging-only deploy path; no
production workflow dispatched.
- #4206 (plan PR) merged (squash) as `ac33c17411f4b63fed30d17c5b9bbc4cf07fc9fd`, 2026-10-20T12:02Z. The
  `docs/programs/standalone/program.md` conflict was resolved by keeping both rows (main's `retire-claude-code` +
  this plan's `plan-spar-stale-session`), merge commit `f389b1395e48b3a5ce93aa77cb3d73d98527a7f5`. PLAN-SPAR `spar`
  passed with no new commit; `state.json` still `converged`. Required check `validate` green. Non-required `Lane scope`
  flagged only `docs/programs/standalone/program.md` (the programme registry row a plan PR adds; governance-artifact
  false positive). Merged without `--admin`.
- #4208 (this lane, VTID-05254) merged (squash) as `3063c95430c089fa157e6e66932bd3eb9d2bc787`,
  2026-10-20T12:16Z, head `e10d4f7bad8f1bf5ced752d730f5270dc854497c` (main merged in). `Lane scope` green,
  `validate` (the only required check) green. Merged without `--admin`.
- Jest decision: pre-existing main failure from #4182, identical failure set, non-required check. `Gateway (Jest,
  ~7.5k tests)`, `Gateway Service Tests` and `Test Suite Summary` were red on #4208 (TEST-SUITE run 39419950441,
  OASIS Persistence CI run 39419950381). Main's latest runs (39396752827, 39396752521 on `0d35512b`) fail the same
  way. Both have 1 failing suite / 1 failing test,
  `test/vtid-05077-planner-fallback-and-thinking.test.ts` › "the spend route returns the planner summary and the
  screen shows it as a chip": it expects `/command-hub/app.js?v=20261120-vtid-05148`, but #4182 (`80e2b355`) bumped
  it to `20261121-vtid-05082`. No plan-sparring test fails. The PR added 18 passing tests (28466 vs 28448 passed).
  Required contexts on `main`: `["validate"]` only.
