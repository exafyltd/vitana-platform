---
lane: new-members-feed-client
state: executing
next_actor: kiro
depends_on: [new-members-feed-api]
executor: kiro
seat: jtadic
area: frontend
reviewer_seat: agent:vitana-lane-reviewer
repos: [exafyltd/vitana-v1]
paths:
  - src/hooks/useAllNewsFeed.ts
  - src/hooks/useNewsFeed.ts
  - src/hooks/useAllNewsFeed.new-members.test.ts
  - src/hooks/community-intro-feed.vtid-05206.test.ts
  - src/hooks/useNewMembersFeed.ts
  - src/hooks/useNewMembersFeed.test.ts
  - tests/e2e/staging/vtid-*-new-members-feed.staging.spec.ts
  - docs/validation/VTID-*/**
claimed_by: kiro-jtadic-202610291040-a0e6
branch: kiro/welcome-finish-r2/new-members-feed-client
pr:
updated: 2026-11-03T12:21Z
vtid: VTID-05478
---
# Lane `new-members-feed-client`
Plan: `.kiro/specs/welcome-finish-r2/` — `plan.md` and the `tasks.md` section `<!-- lane: new-members-feed-client -->` are authoritative.
VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here.

## Log
### 2026-10-30T15:00Z · kiro-jtadic-202610291040-a0e6 · created → ready
Lane drafted with the plan.

### 2026-11-02T15:59Z · ci-plan-spar · ready (VTID allocated)
VTID-05478 allocated after policy approval (converged-auto-v1).

### 2026-11-03T12:21Z · kiro-jtadic-202610291040-a0e6 · ready → executing
Built in vitana-v1 (branch `kiro/welcome-finish-r2/new-members-feed-client`, head `63c0432c836e65d76d279522ea582f9834dc6e9c` after a normal merge of `origin/main`, clean, no conflicts in the hook files):
- `useNewMembersFeed.ts` fetches `GET /api/v1/community/new-members?limit=5` with the member's bearer token (from the Supabase session).
- `useAllNewsFeed.ts` and `useNewsFeed.ts` consume that helper instead of querying `global_community_profiles` directly.
- On any non-200, network error, timeout or missing token the card is hidden (empty list); it never falls back to the table query.
- Tests red-on-base (hooks still queried the table) then green: `useNewMembersFeed.test.ts`, `useAllNewsFeed.new-members.test.ts`, `community-intro-feed.vtid-05206.test.ts`, and `useNewsFeed.community-error-logging.test.ts` (now proves a failed gateway call logs and shows no card, matching the lane's "gateway error → card hidden" acceptance).
- Read-only Playwright staging spec `tests/e2e/staging/vtid-05478-new-members-feed.staging.spec.ts`; evidence in `docs/validation/VTID-05478/` (in vitana-v1).

`depends_on: new-members-feed-api` — the gateway route (VTID-05477) must be deployed to staging before this merges (§7b); the client fails safe if the gateway lags.

BLOCKER (lane-scope): the built v1 diff also edits `src/hooks/useNewsFeed.community-error-logging.test.ts` (it now asserts a failed-gateway-call logs + shows no card, the lane's own "gateway error → card hidden" acceptance, task B2). That file is in the builder's `docs/validation/VTID-05478/scope.json` but is missing from this lane's `paths`, so the v1 PR's required Lane scope fails. A lane PR cannot widen its own `paths` (VTID-05213 self-widen ban; scope-check pins paths to the base revision). The path must be added to this lane file through the `plan(welcome-finish-r2)` PR / CI PLAN-SPAR revision (planner authority) or via a `lane_admin` reassignment — neither is a lane-builder action. Removing the test change instead would break the v1 suite (it still asserted the removed table-error path). Needs the plan driver / planner to add `src/hooks/useNewsFeed.community-error-logging.test.ts` to this lane's `paths` on a trusted revision before the v1 PR can go green.

next: reviewer agent reviews the v1 PR (after the lane `paths` fix lands on a trusted revision).
