---
slug: messenger-vitana-cards
author: kiro
author_seat: exafyltd
executor: kiro
next_actor: kiro
state: drafted
updated: 2026-10-22T08:05Z
---

Deeply-personalized, one-per-day Vitana recommendation cards in the direct
Vitana chat, delivered by the existing Vitana Companion Messages engine. Phase 1
wires the 11 enrichment cards + F1/F7/F8 + two weekly reminders, all gated on
existing signals. Phase 2 (held) adds the usage-gated F4/F5/F10 once their
signals exist. Lab tests are a separate follow-up plan.

### 2026-10-22T08:05Z · kiro-exafyltd-202610220802-4a74 · drafted
Plan authored from the messenger-vitana-cards investigation
(`.agents/tasks/messenger-vitana-cards-investigation/findings.md`). Three lanes
created (all `ready`): companion-enrichment-moments, companion-weekly-reminders
(depends on the first), messenger-surface-wiring (depends on the first).
Owner decisions recorded in plan.md §1: one card per day, lab tests out of
scope, F4/F5/F10 held for Phase 2.
Next: push the `plan(messenger-vitana-cards)` PR so CI PLAN-SPAR spars it and
allocates the lane VTIDs on convergence.
