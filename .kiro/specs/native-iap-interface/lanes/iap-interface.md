---
lane: iap-interface
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
  - apps/mobile/src/iap/**
  - apps/mobile/tests/iap/**
  - docs/validation/**
updated: 2026-11-10T17:03Z
vtid: VTID-05680
---
# Vendor-neutral purchase interface, no-op default, flag OFF
Plan: `.kiro/specs/native-iap-interface/` — `plan.md` and the `tasks.md` section marked `<!-- lane: iap-interface -->`
(tasks I1–I5) are authoritative. VTID: assigned by CI after PLAN-SPAR converges.

**Goal.** `apps/mobile/src/iap/` defines `PurchaseProvider` (products, purchase, restore, entitlement), a no-op default,
`setPurchaseProvider` (pattern of `apps/mobile/src/push/provider.ts:53`) and a feature flag `iap_enabled` that defaults
OFF and is enforced by the module's facade. Nothing imports the module; no screen changes.

**Never:** no vendor SDK or package, no store product ID, no key, no network call, no change to checkout, wallet or
drawer screens, no edit to an existing test, no VTID by hand.

## Log
### 2026-11-10T17:10Z · kiro-exafyltd-202611072144-1c88 · ready
Lane created with the plan.

### 2026-11-10T17:03Z · ci-plan-spar · ready (VTID allocated)
VTID-05680 allocated after policy approval (converged-auto-v1).
