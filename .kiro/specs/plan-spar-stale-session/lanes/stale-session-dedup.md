---
lane: stale-session-dedup
state: done
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
updated: 2026-10-21T22:34Z
vtid: VTID-05254
branch: kiro/plan-spar-stale-session/stale-session-dedup
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

### 2026-10-21T21:49Z · kiro-hotmail-202610212137-725e · in-review → verified
Close-out of the merged lane (queue sweep 2026-10-21, item 1). Lane claim taken by this session.
- PR https://github.com/exafyltd/vitana-platform/pull/4208 squash-merged to `main` 2026-10-20T12:16:59Z, head
  `e10d4f7bad8f1bf5ced752d730f5270dc854497c`.
- merge: 3063c95430c089fa157e6e66932bd3eb9d2bc787
- authority: owner instruction in conversation 2026-10-20 naming #4172, #4206, #4208 ("you do it, claude is off , you
  have to do it, we have changed the rule"), under collaboration.md §7b. Deploy path staging only; no production
  workflow was dispatched by any Kiro session.
- STAGING-VERIFY: gateway run https://github.com/exafyltd/vitana-platform/actions/runs/39575858903 (2026-10-21T09:17Z)
  at `a2d069ea03855d3491d94e924af572611d4f709c` passed, including this lane's suite VTID-05254 (3/3: gateway alive after
  deploy, vtid health endpoint unaffected, plan-sparring Jest). `3063c954` is also inside the passing run
  https://github.com/exafyltd/vitana-platform/actions/runs/39658010525 at `b9e0db028c22f034a570a3b067d691f6ccd98757`.
  The earlier run 39456004226 at `3063c954` failed only on VTID-05082 #3, which VTID-05266 fixed.
- The production commit STAGING-VERIFY reported at 2026-10-21T19:01Z is `a2d069ea`, which contains `3063c954`, so this
  lane is already in production. No Gate 2 is pending for it.
- No reviewer-agent entry exists for this lane. Here `verified` records the owner-directed merge and the STAGING-VERIFY
  pass. It is not an agent accept.
- This entry supersedes record PR #4220. That PR's branch `kiro/plan-spar-stale-session/merge-record` fails main's Collab
  handoff check ("branch … is lane plan-spar-stale-session/merge-record but commits name …stale-session-dedup").

Next: `verified → done` in a follow-up PR, because the lane state machine allows one step per PR. The VTID-05254
ledger row is not terminalized by Kiro (no live writes, §7a); the PM or Claude terminalizes it.

### 2026-10-21T22:34Z · kiro-hotmail-202610212137-725e · verified → done
The merge record and STAGING-VERIFY result are in the entry above (merge `3063c95430c089fa157e6e66932bd3eb9d2bc787`,
STAGING-VERIFY run 39575858903 PASS, already in production at `a2d069ea`). Lane closed. `claimed_by` is cleared and the
lane claim is released after this PR merges.
Left for the coordinator: `handoff.md` for plan-spar-stale-session is still `approved` and needs the `_plan` holder. The
VTID-05254 ledger row is terminalized by the PM or Claude, not by Kiro (§7a, no live writes).
