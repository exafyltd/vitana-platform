---
lane: v1-test-card-button
state: ready
next_actor: kiro
branch: kiro/companion-test-card/v1-test-card-button
depends_on: [gateway-test-card]
executor: kiro
seat: exafyltd
area: frontend
repos: [exafyltd/vitana-v1]
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - src/components/settings/VitanaMessagesSettings.tsx
  - src/components/settings/VitanaMessagesSettings.test-card.test.tsx
  - src/hooks/useCompanionTestCard.ts
  - src/hooks/useCompanionTestCard.test.ts
  - src/i18n/*/screens.json
  - docs/validation/VTID-*/**
updated: 2026-11-06T17:09Z
vtid: VTID-05589
---

# Lane: v1-test-card-button (repo exafyltd/vitana-v1)

Admin-only "send me a test card" button in Vitana messages settings. Tasks T1-T5 in tasks.md.

## Log
### 2026-11-06T17:10Z · kiro-exafy-202611061658-9ca9 · ready
Lane created with the plan.

### 2026-11-06T17:09Z · ci-plan-spar · ready (VTID allocated)
VTID-05589 allocated after policy approval (converged-auto-v1).
