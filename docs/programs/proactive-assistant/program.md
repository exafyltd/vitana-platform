---
id: proactive-assistant
title: Proactive Vitana assistant
status: active
priority: 3
repos: [vitana-platform, vitana-v1]
specs:
  - vitana-platform:new-member-welcome
  - vitana-platform:profile-vitana-cards
  - vitana-platform:messenger-vitana-cards-v2
docs:
  - vitana-platform:docs/plans/VITANA-ONBOARDING-ASSISTANT-PLAN.md
  - vitana-platform:docs/validation/VTID-05099/plan-sparring.md
exit_criteria:
  - The build slices of docs/plans/VITANA-ONBOARDING-ASSISTANT-PLAN.md and of the Vitana Companion Messages plan are shipped
next_review: 2026-10-22
---
# Proactive Vitana assistant

Programme registry entry (VTID-05215). Links only; the plans are the source of truth.

- Vitana Onboarding Assistant plan: `vitana-platform:docs/plans/VITANA-ONBOARDING-ASSISTANT-PLAN.md`
- Vitana Companion Messages plan: `vitana-platform:docs/validation/VTID-05099/plan-sparring.md`
- Specs: `vitana-platform:.kiro/specs/new-member-welcome/` (refines the onboarding assistant plan),
  `vitana-platform:.kiro/specs/profile-vitana-cards/` (Vitana cards and their actions),
  `vitana-platform:.kiro/specs/messenger-vitana-cards-v2/` (personalized profile-enrichment cards in the Vitana
  companion DM)
