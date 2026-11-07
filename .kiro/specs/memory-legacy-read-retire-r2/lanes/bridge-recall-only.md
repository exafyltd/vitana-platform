---
lane: bridge-recall-only
state: done
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
updated: 2026-11-06T14:00Z
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

### 2026-11-05T21:10Z · kiro-exafyltd-202611042048-44bc · in-review (D1 recorded)
Merge precondition D1 met: the owner took the 14-day production count read-only. 392 reads, 1 served by the legacy
read (0.26%), 0 `[VTID-04452] orb recall unavailable`; recorded in `docs/validation/VTID-05556/outputs/recall-failures.md`.
Branch updated to latest main; a new review on the new head follows (the evidence change alters the PR diff).

### 2026-11-06T12:57Z · agent-vitana-lane-reviewer-202611061257-ac18 · review
review: accept
head: 13df9c691252e01a114a8622393fb36b9c508c49
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4701
Findings: [non-blocking] D1 met: 1/392 legacy-served reads (0.26%), 0 recall-unavailable lines; below the plan's ~0.5% limit. The limit is per session and the count is per read; they match because the shadow logs one line per session. Counts are owner-reported without raw command output attached.
[non-blocking] The one legacy-served read has no matching '[VTID-04452] orb recall unavailable' line; its cause is unrecorded and does not change the result.
[non-blocking] Head is 1 commit behind origin/main (650d1ce6, an unrelated lane file); update the branch and re-check before merging.
Lane code unchanged since the 468cc1c4 accept. CI on 13df9c69: all 12 named runs succeeded.
Next: the land step merges under §7b after the PR is updated to latest main and green on that head.

### 2026-11-06T13:29Z · agent-vitana-lane-reviewer-202611061329-f85f · review
review: accept
head: 816dc6e7ca033514a7d0102005379323f3391196
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4701
Findings: [non-blocking] Re-review after the merge of origin/main: git diff 13df9c69..816dc6e7 -- services docs/validation/VTID-05556 is empty; the range holds only the review-entry commit f3c500f5 and the merge bringing 650d1ce6/57abbfef (another plan's lane file, not in the PR diff). Head is 0 behind origin/main (57abbfef).
[non-blocking] D1 met: 1/392 legacy-served reads (0.26%), 0 recall-unavailable lines; owner-reported counts.
[non-blocking] An identity missing tenant_id or user_id now gets 'Memory bridge disabled' instead of a DEV_IDENTITY recall (safer); keep it in Gate 2 "Decisions taken".
CI on 816dc6e7 (gh run view --json headSha,conclusion): all 12 named runs succeeded, attempt 1.
Next: the land step merges under §7b.

### 2026-11-06T13:57Z · kiro-exafyltd-202611042048-44bc · in-review → verified
merge: 05364284a12fd4d8711e0940e285bb81be9e5d86 (exafyltd/vitana-platform#4701, https://github.com/exafyltd/vitana-platform/pull/4701)
authority: §7b PM rule (land-guard merge: review current on 79d4b7a1, checks green, up to date)
Staging deploy https://github.com/exafyltd/vitana-platform/actions/runs/42227415002; staging serves 05364284.
STAGING-VERIFY passed on 05364284: https://github.com/exafyltd/vitana-platform/actions/runs/42229039116 (smoke 12/12; change suites incl. VTID-05556).

### 2026-11-06T14:00Z · kiro-exafyltd-202611042048-44bc · verified → done
Closed. Production still serves 200228350454; production is the owner's PUBLISH after Gate 2.
