---
lane: my-groups-deeplink
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
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/tests/discover-commerce/routes.test.tsx
  - apps/mobile/tests/followups/my-groups/**
  - docs/validation/**
updated: 2026-11-11T12:56Z
vtid: VTID-05725
---
# Make `/comm/my-groups/:id` resolve native
Plan: `.kiro/specs/native-followups-20261111/` — `plan.md` and the `tasks.md` section marked `<!-- lane: my-groups-deeplink -->` are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here.

**Goal.** `resolveWebPath('/comm/my-groups/g-1')` is `unported` (`resolve.ts:154,199-200`) although `app/(app)/comm/my-groups/[id].tsx` exists. Add the pattern to `NATIVE_PATTERNS` and make the one pin change in `tests/discover-commerce/routes.test.tsx:117-120`, listed in the PR body (owner-approved).

**Acceptance:** the `tasks.md` lane `my-groups-deeplink` Acceptance bullets. Checks: a new resolver test (red on base); `tests/navigation.test.tsx`, `tests/discover-commerce`, `tests/community` and the full suite green.

**Never.** `NATIVE_ROUTES` is not changed; no other test edit. No VTID by hand, no merge or approve, no workflow dispatch or deploy, no write to Supabase, AWS or any live system, no test against production; the native app has no production profile.

## Log
### 2026-11-11T12:40Z · kiro-exafyltd-202611072144-1c88 · ready
Lane created with the plan.

### 2026-11-11T12:56Z · ci-plan-spar · ready (VTID allocated)
VTID-05725 allocated after policy approval (converged-auto-v1).
