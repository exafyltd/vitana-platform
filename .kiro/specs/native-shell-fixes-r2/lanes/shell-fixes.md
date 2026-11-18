---
lane: shell-fixes
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
  - apps/mobile/src/identity/useMyPartnerOrgs.ts
  - apps/mobile/src/identity/GuidedModeProvider.tsx
  - apps/mobile/src/shell/AuthGate.tsx
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/app/(public)/commerce-login.tsx
  - apps/mobile/app/(public)/commerce/connect/index.tsx
  - apps/mobile/app/(public)/commerce/connect/privacy.tsx
  - apps/mobile/app/(public)/commerce/join.tsx
  - apps/mobile/tests/identity.test.tsx
  - apps/mobile/tests/shell-fixes/**
  - docs/validation/**
updated: 2026-11-08T12:04Z
vtid: VTID-05647
---
# Shell fixes — doubled `/api/v1` gateway paths, the commerce sign-in redirect, public commerce route mounts
Plan: `.kiro/specs/native-shell-fixes-r2/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: shell-fixes -->` (tasks 1–9) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not
start before `vtid:` is set here. Do not open the PR before vitana-v1 #1587 (VTID-05524) has merged.
**Measured on vitana-v1 origin/main `aac65bfeb`:** `useMyPartnerOrgs.ts:23` and `GuidedModeProvider.tsx:71` pass
paths that already start with `/api/v1` to a client that adds `/api/v1` (`packages/core/src/gateway.ts:22,31`,
`packages/core/src/config.ts:21-24`); `AuthGate.tsx:46` sends every signed-out user to `/maxina`, where web sends
`/commerce*` to `/commerce/join` (`src/components/AuthGuard.tsx:65`). `tests/identity.test.tsx:149` keys its fixture
on the doubled path and is updated in the same PR.
**Goal.** Fix the two request paths and the signed-out commerce redirect, mount the four public commerce routes, with
a red-first fake-gateway / mocked-router test for each.
**Acceptance:** `tasks.md` lane `shell-fixes` Acceptance bullets.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; the native app has no production profile.
## Log
### 2026-11-08T11:47Z · kiro-exafyltd-202611072144-1c88 · ready
Lane created with the plan (re-plan of `native-shell-fixes/shell-fixes`, PR #4657).

### 2026-11-08T12:04Z · ci-plan-spar · ready (VTID allocated)
VTID-05647 allocated after policy approval (converged-auto-v1).
