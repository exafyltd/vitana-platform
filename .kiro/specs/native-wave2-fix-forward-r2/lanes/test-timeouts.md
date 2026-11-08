---
lane: test-timeouts
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-v1]
paths:
  - apps/mobile/tests/memory/helpers.tsx
  - apps/mobile/tests/diary/helpers.tsx
  - apps/mobile/tests/community/helpers.tsx
  - apps/mobile/tests/ui/helpers.tsx
  - apps/mobile/tests/test-timeouts/**
  - docs/validation/**
updated: 2026-11-08T12:05Z
vtid: VTID-05652
---
# Test timeouts — per-folder wait budget for the memory, diary, community and ui suites
Plan: `.kiro/specs/native-wave2-fix-forward-r2/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: test-timeouts -->` (tasks 1–4) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not
start before `vtid:` is set here.
**Measured on vitana-v1 origin/main `aac65bfeb`:** none of `tests/memory`, `tests/diary`, `tests/community`,
`tests/ui` sets `configure({ asyncUtilTimeout })` or `jest.setTimeout`; `tests/settings/helpers.tsx:26-28` does
(`5000`, `30000`). Every test file in the four folders imports its `helpers.tsx` except the synchronous
`diary/app-config-plugins.test.ts` and `ui/tokens-contract.test.ts`.
**Goal.** The settings pattern in the four helpers. Never edit `jest.config.js` or `jest.setup.ts`; never change a
test or an assertion.
**Acceptance:** `tasks.md` lane `test-timeouts` Acceptance bullets.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production.
## Log
### 2026-11-08T12:10Z · kiro-exafyltd-202611072144-1c88 · ready
Lane created with the plan (re-plan of `native-wave2-fix-forward/test-timeouts`, PR #4664).

### 2026-11-08T12:05Z · ci-plan-spar · ready (VTID allocated)
VTID-05652 allocated after policy approval (converged-auto-v1).
