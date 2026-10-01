# VTID-04422 — Conversation rebuild WS-2.2: relevance scoring of continuation candidates, shadow mode

This is Plan v1 (Conversation Intelligence Rebuild), Phase 2, workstream WS-2.2.
It ships in PR #3614 as a companion to VTID-04339.

## Why

`decideContinuation` ranks the providers' candidates by a fixed priority. The only adjustment is a rotation penalty for openers served recently. So the pick cannot learn from:

- what the user actually accepted;
- the screen they are on;
- the time of day.

The plan asks for a transparent weighted score that runs in shadow first: both rankings are logged and compared before the score may take over.

## Change

### `services/conversation/candidate-scoring.ts` (pure, except two reads)

Every feature is in [0, 1]. A null feature is dropped from both sums, never guessed.

| Feature | Meaning |
|---|---|
| **urgency** | the provider's priority / 100 |
| **freshness** | 0 for the opener served last, rising to 1 past the rotation window |
| **screen** | 0.2 when navigating to the current screen; 0.8 within the same section; else 0.5 |
| **time_of_day** | from the weights row's kind → part-of-day table; 0.5 when absent |
| **outcome** | the user's smoothed acceptance rate for that provider, from WS-2.4's table |
| **profile** | reserved for WS-4.1, null today |

- **`rankInShadow`**: ties keep the live order, so equal scores never create a disagreement.
- **Weights**: loaded from `conversation_scoring_weights` (highest active version, 5-minute cache). Built-in defaults identical to the seeded version 1 are used when the table cannot be read.

### Migration `20260923200000_vtid_04422_conversation_scoring_weights.sql`

- Applied live, additive. Version 1 is seeded active.
- RLS on, with no browser access.

### Wiring (`wake-brief-wiring.ts`)

- **After the decision is made, off the session-start path, the same candidates are scored.**
  - Explicit selections (a tapped topic or focus step) are skipped.
  - The result is recorded as a new `continuation_shadow_ranked` wake-timeline event: both winners, whether they agree, the scores and the weights version.
  - The decision the session uses is unchanged.
- **The controller now passes `currentRoute`** (for the screen feature).
- **Wake-brief offers now record the producing provider key** instead of the candidate kind, so outcomes can be joined to providers.
- **The locked wake-timeline event list grows from 16 to 17.** It is a deliberate addition; no name changed.

### Read and Command Hub

- **`GET /api/v1/admin/conversation/shadow-ranking?days=`** (exafy_admin, 1 to 30 days, at most 1,000 timelines, started_at-indexed) reports:
  - agreement rate;
  - winner pairs where the two rankings differ;
  - wins per provider;
  - recent disagreements.
- **Conversation → Monitor**: a "Ranking: live vs shadow score" section.
- **Brain inspector › Candidates**: the per-session shadow scores, and whether they agree with the live pick.

## Acceptance criteria

AC-1: The features are computed as specified; a null feature is left out of the score; neutral signals are 0.5.
TEST: services/gateway/test/services/conversation/vtid-04422-candidate-scoring.test.ts

AC-2: The shadow ranking agrees when only priority differs, disagrees when the live winner is stale and often declined, and keeps the live order on ties.
TEST: services/gateway/test/services/conversation/vtid-04422-candidate-scoring.test.ts

AC-3: Weights come from the highest active DB version, are cached, and fall back to defaults. The seeded version 1 equals the built-in defaults.
TEST: services/gateway/test/services/conversation/vtid-04422-candidate-scoring.test.ts

AC-4: Shadow scoring runs after the decision, is skipped for explicit selections, records a registered timeline event, and never changes the returned decision. Wake-brief offers carry the provider key.
TEST: services/gateway/test/services/conversation/vtid-04422-candidate-scoring.test.ts

AC-5: The comparison reads a bounded, indexed window and reports agreement, disagreement pairs and wins. The endpoint is admin-only, the Monitor section is mounted, and the inspector shows the per-session scores.
TEST: services/gateway/test/services/conversation/vtid-04422-candidate-scoring.test.ts

AC-6: The Monitor section renders at 1400×900 and 390×844 with no page overflow.
TEST: docs/validation/VTID-04422/outputs/shoot-report.json

About the screenshots (`outputs/monitor-shadow-*.png`):

- **The rankings in them are synthetic:** they are produced by the real scorer over made-up candidates, with no user data.
- **The "Could not load" box and the zeroed Suggestion outcomes above the new section** come from the harness stubbing those older endpoints with empty data.

CURL (post-deploy, anonymous): `curl -s -o /dev/null -w "%{http_code} %{content_type}" https://preview-aws-gateway.vitanaland.com/api/v1/admin/conversation/shadow-ranking` should return `401 application/json`.

## Taking over from the fixed ranker: not done, by design

- **The switch needs evidence.** The score may replace the fixed priority only after the comparison view shows where they differ and the outcome data says the shadow picks are accepted more often.
- **That is a later, owner-visible decision**, as the plan says: "Only then does it take over."

## Not verified live

- **Staging ECS could not place tasks at the time of writing.**
- **The first real signal** is a `continuation_shadow_ranked` event in a staging session's `orb_wake_timelines` row, and the Monitor section counting it.
