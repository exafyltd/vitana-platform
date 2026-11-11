---
lane: de-keys
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
  - src/i18n/*/settingsNative.json
  - src/i18n/*/aiAssistantsNative.json
  - src/i18n/*/aiCoachNative.json
  - docs/validation/VTID-*/**
updated: 2026-11-11T20:00Z
vtid: VTID-05761
---
# Catalog: remove the `_pending_review` flags in three namespaces, keep the German keys (de-keys)
Plan: `.kiro/specs/native-catalog-de-keys/` — `plan.md` (decisions 1–3) and the `tasks.md` section marked
`<!-- lane: de-keys -->` (K1–K5) are authoritative. VTID: assigned by CI after PLAN-SPAR converges.

**Goal.** In the non-German shards of `settingsNative`, `aiAssistantsNative` and `aiCoachNative`, delete the
`_pending_review` flag objects so the raw key set matches `src/i18n/de/<ns>.json` exactly. Every value stays as it is. No German
key is missing (checked in K2); if one is, the lane stops and lists it.

**Acceptance:** the three exact-key test files pass as written: `apps/mobile/tests/settings/i18n-rtl.test.tsx`,
`apps/mobile/tests/ai-assistants/i18n-rtl.test.tsx`, `apps/mobile/tests/ai-coach/i18n-rtl.test.tsx` (25 failed on base, 260 pass
after); no test file is edited; `npm run typecheck` in `apps/mobile` passes; no value of any locale or of `de` changes; the
key-diff evidence lists the 113 removed flag leaves.

**Never:** no new text in any locale, no German edit, no test edit, no key rename, no production or live system.

## Log
### 2026-11-11T19:55Z · kiro-exafyltd-202611072144-1c88 · ready
Lane created with the plan.

### 2026-11-11T20:00Z · ci-plan-spar · ready (VTID allocated)
VTID-05761 allocated after policy approval (converged-auto-v1).
