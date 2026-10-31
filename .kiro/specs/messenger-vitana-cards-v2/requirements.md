# Messenger Vitana Cards ΓÇö Requirements

## Introduction

The direct Vitana chat inside the Messenger
(`/inbox/u/00000000-0000-0000-0000-000000000001`) should carry deeply
personalized, one-per-day Vitana recommendation cards ΓÇö the same Unified Card
System cards the member sees elsewhere, but shown only when relevant to that
member. This reuses the deployed Vitana Companion Messages engine
(VTID-05099/05100/05101); it extends that engine's moment list and wires the
enrichment completion signals into it.

## Requirements

### Requirement 1 ΓÇö Personalized enrichment cards in the Vitana chat
**User story:** As a member, I want Vitana to suggest a setup step I have not
done yet (connect calendar, add a photo, write a bio), so that completing my
profile feels guided and never repetitive.

#### Acceptance Criteria
1. WHEN the companion engine picks a moment for a member for the Messenger
   surface THEN it SHALL only offer an enrichment card (E1ΓÇôE11) whose
   completion signal shows the member has NOT completed it.
2. WHEN a member has completed an enrichment action (e.g. connected Instagram)
   THEN the corresponding card SHALL never be offered again.
3. WHEN the completion state is read THEN it SHALL come from the existing
   completion resolver source tables only (no new `completed_at` column).

### Requirement 2 ΓÇö Recurring weekly reminders
**User story:** As a member, I want Vitana to remind me weekly to improve my
Vitana Index and to make a diary entry, so that healthy habits are kept front
of mind regardless of completion.

#### Acceptance Criteria
1. WHEN a week has passed since the last "Improve your Vitana Index" reminder
   THEN the moment SHALL be eligible again (via `repeatAfterDays: 7`).
2. WHEN a week has passed since the last diary reminder THEN the diary moment
   SHALL be eligible again.
3. WHEN adding the weekly cadence THEN it SHALL reuse the existing
   `companion_messages_ledger` and pacer ΓÇö no new cadence mechanism or table.

### Requirement 3 ΓÇö One card per day, paced
**User story:** As a member, I do not want Vitana to flood my chat, so cards
should arrive at most once a day and respect pauses.

#### Acceptance Criteria
1. WHEN the engine runs THEN it SHALL deliver at most one card per member per
   local day on the `messenger_companion` surface (existing pacer).
2. WHEN a member has paused proactive guidance THEN no card SHALL be delivered.
3. WHEN a card is delivered THEN it SHALL be a Vitana DM carrying
   `metadata.card = { kind:'vitana_card', card_type, params }`, rendered by the
   existing `MessageBubble`.

### Requirement 4 ΓÇö Non-regression and run-mode safety
**User story:** As the platform owner, I want this change to be verifiable
without any write to production.

#### Acceptance Criteria
1. WHEN this plan is implemented THEN it SHALL NOT enable member-facing live
   sends as part of the change; enabling live delivery is a separate owner step.
2. WHEN verifying THEN tests SHALL exercise selection logic in shadow/staff mode
   and staging tests SHALL be read-only.
3. WHEN new user-visible copy is added THEN it SHALL have full gateway-locale
   coverage (enforced by the locale-coverage test).

### Requirement 5 ΓÇö Phase 2 usage-gated cards (held)
**User story:** As a member, I want Vitana to suggest a feature only if I do not
already use it.

#### Acceptance Criteria
1. WHEN the voice-usage signal (`voice_session_facts`, VTID-04776) is applied and
   backfilled THEN the "Talk to Vitana" card MAY be added, gated on "never used
   voice".
2. WHEN a durable "ever used Matches" signal exists THEN the "Find a Match" card
   MAY be added, gated on "does not use matches".
3. UNTIL those signals exist THEN F4/F5/F10 SHALL NOT be shown on the Messenger
   surface (not even ungated).

### Requirement 6 ΓÇö Lab tests out of scope
#### Acceptance Criteria
1. WHEN this plan is implemented THEN lab-test cards SHALL NOT be included; they
   are a separate follow-up plan (`messenger-vitana-cards-labs`).
