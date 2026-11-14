---
lane: route-tests
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
reviewer_seat: agent:vitana-lane-reviewer
area: frontend
repos: [exafyltd/vitana-v1]
paths:
  - apps/mobile/tests/parity-gaps/**
  - docs/validation/**
updated: 2026-11-10T18:28Z
vtid: VTID-05685
---
# Route tests for the two untested native parity rows
Plan: `.kiro/specs/native-parity-test-gaps/` — `plan.md` and the `tasks.md` section marked `<!-- lane: route-tests -->`
(tasks T1–T4) are authoritative. VTID: assigned by CI after PLAN-SPAR converges.

**Goal.** New tests prove that `app/(app)/intents/mine.tsx` redirects to `/comm/find-partner?view=posts` and that
`app/(app)/comm/my-groups/[id].tsx` renders the group detail for its `id`, as ledger rows `INTENTS.MINE` and
`/comm/my-groups/:id` say.

**Acceptance (reviewer: agent:vitana-lane-reviewer):** only new files under `apps/mobile/tests/parity-gaps/**` and
`docs/validation/**`; the new tests pass and fail under the recorded mutations; the full mobile suite and typecheck pass;
`parity-ledger.mjs --check` unchanged.

**Never:** no source, ledger, resolver or existing-test edit; no network; no VTID by hand.

## Log
### 2026-11-10T18:10Z · kiro-exafyltd-202611072144-1c88 · ready
Lane created with the plan.

### 2026-11-10T18:28Z · ci-plan-spar · ready (VTID allocated)
VTID-05685 allocated after policy approval (converged-auto-v1).
