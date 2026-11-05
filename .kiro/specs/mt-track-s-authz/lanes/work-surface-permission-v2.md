---
lane: work-surface-permission-v2
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - services/gateway/src/orb/profile/assistant-profile.ts
  - services/gateway/src/orb/live/session/live-session-controller.ts
  - services/gateway/src/routes/orb-livekit.ts
  - services/gateway/src/routes/conversation.ts
  - services/gateway/test/mt-track-s-authz-work-surface.test.ts
  - services/gateway/test/routes/orb-livekit.test.ts
  - docs/validation/**
updated: 2026-11-03T16:40Z
vtid: VTID-05529
---
# Lane: work-surface-permission-v2 (repo vitana-platform)
Supersedes `work-surface-permission` (seat exafy, VTID-05453). The lane's paths cannot be amended from another seat, because lane permissions come from the base revision. This lane carries the same work with the same tasks and acceptance, and `services/gateway/test/routes/orb-livekit.test.ts` (on main, pinned to the previous contract by three assertions) is in scope. The code base is the `work-surface-permission` branch, PR #4654 (draft, head `5a7406dde6`). Tasks: `tasks.md`, group `work-surface-permission-v2`. The VTID is allocated by CI on convergence.

## Log
### 2026-11-03T15:05Z · kiro-hotmail-202611011452-6d16 · created
Created by plan amendment wsp-1 (mt-track-s-authz), which supersedes `work-surface-permission`.

### 2026-11-03T16:40Z · ci-plan-spar · ready (VTID allocated)
VTID-05529 allocated after policy approval (converged-auto-v1).

### 2026-11-04T16:11Z · agent-vitana-lane-reviewer-202611041611-bd4c · review
review: accept
head: 0b892417c113dae601b2909a5db88fbdecc6455b
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4673
Findings: 0 blocking, 5 non-blocking
- PR #4673: CI results, the PR title and the PR body could not be read in this session (gh pr view and gh pr checks use GraphQL, which the gateway rejects; gh api is not an allowed command). The land step must see every check finished and green on this head with the PR up to date, confirm the PR body names the rule 42h contract change and OPEN-1, and confirm the squash subject names only VTID-05529 (main has no VTID-05453 staging manifest).
- services/gateway/src/orb/live/session/live-session-controller.ts:995: the plan and task W4 cap this file at 20 lines; the diff is +50/-13. The extra lines (brain-role clamp 1485, operator-thread bind 2076, stored briefing gate 1600) close route-derived paths around the refusal and have pinned tests (AC-7, AC-10). List them under Decisions taken at Gate 2.
- docs/validation/VTID-05529/acceptance.md:64: OPEN-1 is stale at this head. The route-suite outputs show the pre-patch failures, no committed output shows the suite green (92 passed is only in the body of commit 41b0708), and red.txt has 73 tests against 74 in green.txt (the added source-contract test is red by construction). Not required for merge.
- docs/validation/VTID-05529/plan-sparring.md:1: the heading and last bullet name VTID-05453 as 'this record'. The content passes the PR-GATE sparring check and the verdict on main lists VTID-05529. Not required for merge.
- docs/validation/VTID-05529/scope.json:4: paths omits services/gateway/test/routes/orb-livekit.test.ts; PR-GATE scope passes only through the kiro-agent[bot] exemption. Add the path with the next commit that touches this folder.
Next: the land step merges under §7b once every check run is finished and green on this head; findings 3 to 5 need no action before merge
