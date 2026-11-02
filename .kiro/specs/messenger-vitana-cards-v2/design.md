# Messenger Vitana Cards ΓÇö Design

## Overview

Extend the deployed Vitana Companion Messages engine to carry personalized
Unified Card System cards in the direct Vitana chat, one per day, gated on
existing completion/usage signals, with two recurring weekly reminders. No new
delivery path, renderer, pacer, or table in Phase 1.

## Existing components reused (file evidence from investigation)

- `services/gateway/src/services/companion/moments.ts` ΓÇö `COMPANION_MOMENTS`,
  `pickMoment`, `MomentCandidate` (`cardType`, English `intent`, `priority`,
  `repeatAfterDays`), `tipAlreadyCovered()` (the "don't promote what they use"
  pattern).
- `services/gateway/src/services/companion/signals.ts` ΓÇö builds `MemberContext`
  (usage signals, batched per page of members).
- `services/gateway/src/services/companion/delivery.ts` ΓÇö inserts the Vitana DM
  with `metadata.card`, records the pacer touch (`messenger_companion`).
- `services/gateway/src/services/enrichment/completion-resolver.ts` +
  `card-catalog.ts` `eligibleEnrichmentCards()` ΓÇö computes incomplete
  enrichment cards (E1ΓÇôE11) from source tables; designed for reuse by companion.
- `services/gateway/src/services/guide/presence-pacer.ts` ΓÇö
  `canSurfaceProactively(id, 'messenger_companion')`.
- `services/gateway/src/data/enrichment-card-tips.ts`,
  `services/gateway/src/data/feature-tips.ts` ΓÇö localized copy.
- vitana-v1 `src/components/messages/MessageBubble.tsx` ΓÇö renders the card
  payload inline (VTID-05100, live). No vitana-v1 change needed in Phase 1.

## Design

### 1. Enrichment completion in MemberContext
Add one batched read to `signals.ts` (or `companion-repository.ts`) that calls
the existing enrichment completion resolver for each member in the page, and
expose the incomplete-card set on `MemberContext` (e.g.
`ctx.incompleteEnrichmentCards: Set<EnrichmentCardType>`). This is one extra
read, batched with the existing signal reads.

### 2. New moments for enrichment cards
Add `COMPANION_MOMENTS` entries for E1ΓÇôE11, each:
- `cardType: 'EΓÇª'`
- eligibility predicate: member is in `ctx.incompleteEnrichmentCards`
- English `intent` describing what Vitana should say (never a hardcoded
  sentence ΓÇö ┬º13b / NEVER-41)
- `priority` matching the enrichment engagement order in the card catalog
Reuse `enrichment-card-tips.ts` copy; no new strings.

### 3. New moments for ship-now feature cards
Add moments for F1 (Guided Journey step ΓÇö reuse existing
`guided_journey_step`), F7 (Invite ΓÇö gated on `user_active_days` engagement),
F8 (feature tip ΓÇö existing `pickFeatureTip`). These reuse existing copy/signals.

### 4. Two recurring weekly reminders
Add moments:
- "Improve your Vitana Index" ΓÇö `repeatAfterDays: 7`. To avoid changing the
  shared `vitana_index` moment (which uses 3 today on other surfaces), add a
  distinct Messenger-scoped weekly moment rather than retuning the shared one.
- "Make a diary entry" ΓÇö `repeatAfterDays: 7`, nudge if the member's diary is
  lapsed (existing `diary_entries` recency signal).
Both reuse `companion_messages_ledger` for cadence tracking.

### 5. Surface wiring
Confirm the companion tick evaluates these moments for the Messenger surface
and that the pacer surface key `messenger_companion` is used consistently.
Document the run-mode (shadow default) and how verification runs without live
member sends.

## Phase 2 (held ΓÇö separate lanes, not started until signals exist)
- F4 Talk to Vitana ΓÇö needs `voice_session_facts` applied+backfilled.
- F5 Find a Match ΓÇö needs a durable "ever used Matches" signal.
- F10 Upload Video/Music ΓÇö needs a "has uploaded media" signal.

## Testing strategy
Follow `vtid-05100-companion-delivery.test.ts` and the completion-resolver
tests. Cover: gated selection (incomplete ΓåÆ eligible, complete ΓåÆ never),
weekly cadence via ledger, one-per-day pacing, delivery payload shape, locale
coverage, and a read-only staging test.

## Decisions taken
- One card per day (companion model), not a strip. (owner)
- Lab tests out of scope ΓåÆ follow-up plan. (owner)
- F4/F5/F10 held for Phase 2, not shown ungated. (owner intent; conservative)
- Weekly Index reminder is a distinct Messenger moment, not a retune of the
  shared `vitana_index` moment, to avoid affecting other surfaces. (planner;
  sparring may challenge)
