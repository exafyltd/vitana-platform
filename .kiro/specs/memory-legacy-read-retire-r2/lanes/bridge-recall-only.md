---
lane: bridge-recall-only
state: in-review
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: platform
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - services/gateway/src/services/orb-memory-bridge.ts
  - services/gateway/src/services/orb-memory-bridge-repository.ts
  - services/gateway/src/services/memory/recall-shadow.ts
  - services/gateway/test/services/memory/**
  - services/gateway/test/services/orb-memory-bridge.test.ts
  - services/gateway/test/routes/orb-live.test.ts
  - services/gateway/test/vtid-05147-effective-role-permitted.test.ts
  - docs/MEMORY-SYSTEM-PLAN.md
  - docs/validation/VTID-*/**
updated: 2026-11-05T12:30Z
claimed_by: kiro-exafyltd-202611042048-44bc
branch: kiro/memory-legacy-read-retire-r2/bridge-recall-only
pr: https://github.com/exafyltd/vitana-platform/pull/4701
vtid: VTID-05556
---
# bridge-recall-only — the ORB memory read is recall() only (vitana-platform)
Plan: `.kiro/specs/memory-legacy-read-retire-r2/plan.md`. **Held until PLAN-SPAR allocates this lane's VTID.**

## Log
### 2026-11-05T11:45Z · kiro-exafyltd-202611042048-44bc · created → ready
Created and held. A local prototype on `29b639da` exists (red 4/5 on origin/main for the new wiring test; 73/73 across the three bridge test files with the change).

### 2026-11-05T11:55Z · ci-plan-spar · ready (VTID allocated)
VTID-05556 allocated after policy approval (converged-auto-v1).

### 2026-11-05T12:25Z · kiro-exafyltd-202611042048-44bc · ready → executing
Claimed. Built from the local prototype, rebased on `3b5292f6`. Red on origin/main: 6 failed / 54 passed (lane tests on main
code); green on the head: 180/180 across the six affected suites, memory suites 48/48, `tsc --noEmit` clean. Evidence in
`docs/validation/VTID-05556/` (`land-guard evidence` ok; preflight passes).

### 2026-11-05T12:30Z · kiro-exafyltd-202611042048-44bc · executing → in-review
exafyltd/vitana-platform#4701, head `8a33f5aa`. Next: reviewer agent `vitana-lane-reviewer` on the current head. Merge also
waits on AC-6 / D1, the read-only 14-day production count of not-ok recalls, which this session cannot take (no AWS
credentials).

### 2026-11-05T20:08Z · agent-vitana-lane-reviewer-202611052008-dd89 · review
review: changes
head: 133744ff20fbc8b5d66dd54e1d6e041e660ed4d2
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4701
Findings: [blocking] CI on the head could not be verified: gh pr view/checks fail (GraphQL pass-through unsupported), gh api check-runs and gh run list are denied; head SHA not confirmed.
[non-blocking] D1 (premise 7 production count) is correctly recorded as a pending merge precondition in acceptance.md and the lane log; outputs/recall-failures.md is absent, so merge waits on it.
[non-blocking] commands.log:38 and the 12:30Z lane log refer to AC-6, which no longer exists.
[non-blocking] An identity missing tenant_id/user_id now returns 'Memory bridge disabled' instead of a DEV_IDENTITY recall (safer, not stated in the plan).
[non-blocking] No test covers the dev-sandbox no-identity, bridge-enabled recall path.
Next: re-review with check-run access (or the run links) on the current head; the lane's seat fixes no code. Merge also waits on D1 (outputs/recall-failures.md).

### 2026-11-05T20:25Z · kiro-exafyltd-202611042048-44bc · in-review → executing
Review round 1 returned `changes`; fixing.

### 2026-11-05T20:26Z · kiro-exafyltd-202611042048-44bc · executing → in-review
exafyltd/vitana-platform#4701 (https://github.com/exafyltd/vitana-platform/pull/4701).
Review round 1 (`changes`) answered:
- [blocking] CI not readable: `gh pr view/checks` are GraphQL and fail in this environment. The re-review prompt gives the
  run IDs so the reviewer can use `gh run view` (REST, in its allowed commands). On head `133744ff`, all 28 check runs were
  green (gateway Jest shards 1-4, unit, pr-gate, Lane scope, Collab handoff, validate-pr, Minimal CI).
- [non-blocking] The "AC-6" references now point to the "Merge precondition" section (commands.log; this entry replaces the
  12:30Z wording).
- [non-blocking] An identity object missing `tenant_id` or `user_id` now gets "Memory bridge disabled" outside the dev
  sandbox, where before it was recalled as `DEV_IDENTITY`. Kept on purpose: it never reads another user's memory. Recorded
  here for Gate 2 "Decisions taken".
- [non-blocking] Added the dev-sandbox no-identity test (`recall-bridge-wiring.test.ts`): red on main's code, green here.

### 2026-11-05T20:30Z · agent-vitana-lane-reviewer-202611052025-bd2e · review
review: accept
head: 468cc1c44407019f7df07cf8375fba18d87fcf5d
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4701
Findings: [non-blocking] D1 (premise 7 production count) is still a pending merge precondition; outputs/recall-failures.md is absent, so the lane must not merge until the count is recorded and is at or below about 0.5% of sessions.
[non-blocking] The head is behind origin/main (merge-base ec7f45cc, main 27de7a98); update to latest main and re-check that head before merging under §7b.
[non-blocking] An identity missing tenant_id or user_id now gets 'Memory bridge disabled' instead of a DEV_IDENTITY recall (safer); recorded for Gate 2 "Decisions taken".
[non-blocking] Round-1 AC-6 wording: commands.log fixed, and the 20:26Z entry supersedes the 12:30Z wording. Round-1 dev-sandbox test: added in recall-bridge-wiring.test.ts, red on main's code (1 failed) and green on the head (6/6).
CI on 468cc1c4 (gh run view --json headSha,conclusion): all 12 named runs succeeded.
Next: the land step merges under §7b after the PR is updated to latest main and green on that head, and after D1 is recorded in outputs/recall-failures.md.
