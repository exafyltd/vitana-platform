---
slug: messenger-vitana-cards
author: kiro
author_seat: exafyltd
executor: kiro
next_actor: kiro
state: drafted
updated: 2026-10-22T11:30Z
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

### 2026-10-22T08:20Z · kiro-exafyltd-202610220802-4a74 · drafted (sparring round 1 answered)
CI PLAN-SPAR round 1 raised 3 blockers + 3 majors + 2 minors — all verified
against the code and ACCEPTED. Rewrote the plan:
- Removed F1/F7/F8 and the Index/diary weekly moments from scope (already
  shipped in VTID-05101; re-adding would duplicate and corrupt pickMoment).
- Dropped the `companion-weekly-reminders` lane.
- Added `companion-enrichment-signals` lane (bulk completion + dismissal reads;
  the per-member resolver has no bulk form — the real work).
- Gated the E1–E11 moments through `eligibleEnrichmentCards` (completion AND
  dismissal), not completion alone.
- Replaced the impossible staging assertion with the `disabled-on-staging`
  status pattern.
- Reworded the summary (no "never writes a diary entry"; diary nudge is
  lapsed-habit only).
Lanes now: companion-enrichment-signals → companion-enrichment-moments →
messenger-companion-verification. Responses in sparring/responses-1.md.
Next: push to start round 2.

### 2026-10-22T11:30Z · kiro-exafyltd-202610220802-4a74 · drafted (sparring round 2 answered)
CI PLAN-SPAR round 2: 1 blocker + 1 major + 1 minor — all verified and ACCEPTED.
- R2-F1 (blocker): must pass `unavailableEnrichmentCards()` as the 5th arg to
  `eligibleEnrichmentCards`; with Meta OAuth unset (every current stack) E6/E7
  are hidden, else a Connect-Instagram DM would 400 on tap.
- R2-F2 (major): the `FetchEnrichmentCompletions` seam must use allSettled /
  `unavailable[]` and never throw, or a DB error aborts the whole tick.
- R2-F3 (minor): don't use the 1-based catalog priority as the moment priority;
  assign explicit companion-scale 20–49, E1 highest → E11 lowest.
Plan, both affected lanes, and tasks updated. Responses in
sparring/responses-2.md. Next: push to start round 3 (cap is 3 rounds for a
standard change).
