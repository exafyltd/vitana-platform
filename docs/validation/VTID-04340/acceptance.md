# VTID-04340 — Conversation rebuild WS-0.3: profile narrative freshness guard

Plan v1 (Conversation Intelligence Rebuild), Phase 0, workstream WS-0.3.
Ships in the same PR as VTID-04339 (the PR gate keys on one VTID per PR;
same precedent as VTID-04246's companion VTIDs).

## What was wrong (confirmed live, read-only, 2026-09-23)

- `user_assistant_state` holds 26 `user_profile_narrative_v1` rows; the newest
  was written 2026-07-06 and none in the last 7 days. AP-0911 (the nightly
  synthesis) last ran 2026-07-06 per `automation_runs`.
- `readUserProfileNarrative()` had no age check, and the profiler injected the
  text under the fixed header `[PROFILE SYNTHESIS — nightly, …]`. Every voice
  session for those 26 users was handed an 11-week-old profile presented as
  last night's.

## Fix

- `user-model-synthesis.ts`: `readUserProfileNarrative()` returns null when
  `generated_at` is missing, unparseable, or older than the max age, and
  returns `age_ms` otherwise. Max age defaults to 7 days,
  `PROFILE_NARRATIVE_MAX_AGE_DAYS` overrides (non-positive or garbage falls
  back to 7). New pure helper `describeNarrativeAge()`.
- `user-context-profiler.ts`: the header now states the real age —
  `[PROFILE SYNTHESIS — generated 5 hours ago, …]` — computed inside the
  existing lazy import, so the profiler still does not load the synthesis
  module (and the LLM router) eagerly.

Effect today: none of the 26 July narratives is injected any more. The
section returns once AP-0911 runs again (WS-0.2, owner action).

## Acceptance criteria

AC-1: A narrative older than the max age (e.g. the July rows) is not returned.
TEST: services/gateway/test/services/vtid-04340-profile-narrative-freshness.test.ts

AC-2: A fresh narrative is returned with its age; the boundary (exactly max age kept, just past dropped) holds.
TEST: services/gateway/test/services/vtid-04340-profile-narrative-freshness.test.ts

AC-3: Missing, unparseable or non-string generated_at, an empty narrative, no row, or a read error all return null.
TEST: services/gateway/test/services/vtid-04340-profile-narrative-freshness.test.ts

AC-4: The max age defaults to 7 days and only a positive PROFILE_NARRATIVE_MAX_AGE_DAYS overrides it.
TEST: services/gateway/test/services/vtid-04340-profile-narrative-freshness.test.ts

AC-5: The injected header states the real age and no longer says "nightly".
TEST: services/gateway/test/services/vtid-04340-profile-narrative-freshness.test.ts

AC-6: Existing synthesis behaviour (inputs-hash gating, upsert shape, model_failed) is unchanged.
TEST: services/gateway/test/services/user-model-synthesis.test.ts
