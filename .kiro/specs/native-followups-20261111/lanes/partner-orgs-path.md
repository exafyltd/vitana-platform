---
lane: partner-orgs-path
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
  - apps/mobile/src/identity/useMyPartnerOrgs.ts
  - apps/mobile/tests/shell.test.tsx
  - apps/mobile/tests/identity.test.tsx
  - apps/mobile/tests/followups/partner-orgs/**
  - docs/validation/**
updated: 2026-11-11T12:56Z
vtid: VTID-05726
---
# Fix the doubled `/api/v1` in `useMyPartnerOrgs`
Plan: `.kiro/specs/native-followups-20261111/` — `plan.md` and the `tasks.md` section marked `<!-- lane: partner-orgs-path -->` are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here.

**Goal.** `apps/mobile/src/identity/useMyPartnerOrgs.ts:23` passes `/api/v1/partner-orgs/mine` to a gateway client that already adds `/api/v1` (`packages/core/src/gateway.ts:22`), so the request goes to `/api/v1/api/v1/partner-orgs/mine`. Fix it to `/partner-orgs/mine` and change, in the same PR, only the fake-gateway key at `tests/shell.test.tsx:49` and `tests/identity.test.tsx:149` (owner-approved).

**Acceptance:** the `tasks.md` lane `partner-orgs-path` Acceptance bullets. Checks: a new URL test (red on base); `tests/shell.test.tsx`, `tests/identity.test.tsx`, `tests/professional/bottom-tabs.test.tsx`, `tests/staff/chrome.test.tsx` and the full suite green; the diff of the two edited tests is one line each.

**Never.** no edit to `GuidedModeProvider.tsx` or `AuthGate.tsx` (open PR #1645), no other test edit. No VTID by hand, no merge or approve, no workflow dispatch or deploy, no write to Supabase, AWS or any live system, no test against production; the native app has no production profile.

## Log
### 2026-11-11T12:40Z · kiro-exafyltd-202611072144-1c88 · ready
Lane created with the plan.

### 2026-11-11T12:56Z · ci-plan-spar · ready (VTID allocated)
VTID-05726 allocated after policy approval (converged-auto-v1).
