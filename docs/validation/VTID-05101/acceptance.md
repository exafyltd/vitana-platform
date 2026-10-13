# VTID-05101 — Vitana Companion Messages, Phase 3: remaining moments + back-off (shadow)

Plan: Vitana Companion Messages — sparred 5 rounds, CONVERGED, owner approved 2026-10-12. Record: `docs/validation/VTID-05099/plan-sparring.md` (plan hash `494738ed…ba63`; stub `docs/validation/VTID-05101/plan-sparring.md`).

This part adds four moment generators, the ledger-only back-off and a pause check to the engine. The engine still runs in shadow only (Phase 1 config: no sending mode). There is no migration and no schema change: it reads existing tables (`user_guided_journey_state`, `diary_entries`, `user_active_days`, `companion_messages_ledger`).

AC-1 `guided_journey_step` → card F1 (health): fires when the member is in guided mode, the onboarding status is not `skipped`/`completed`, and they have not listened to an episode on their local today (`metadata.daily_listen.date`). Facts: `next_session` (current_session), `onboarding_status`, `completed_practice_count`, `qualification_threshold`, `last_opened_topic_id`. Priority 65, not repeated within 2 days. It ranks above a quiet Vitana Index and below one that moved a lot. The health switch is respected.
TEST: services/gateway/test/vtid-05101-companion-generators.test.ts ("VTID-05101: guided_journey_step (card F1)")

AC-2 `diary_nudge` → card F3 (health): fires when the member's latest `diary_entries` row inside the 30-day window is 3 or more days old. A member who has not written in the window is never nudged. Facts: `days_since_last_entry`. Priority 40–50 (grows with the gap), not repeated within 4 days. The health switch is respected.
TEST: services/gateway/test/vtid-05101-companion-generators.test.ts ("VTID-05101: diary_nudge (card F3)")

AC-3 `feature_tip` → card F8 (community), low priority (20), not repeated within 5 days. It fires only for a member with at least 1 active day (`user_active_days`, 30 days). It rotates through `data/feature-tips.ts` from a stable per-member offset. The last 6 tips used (ledger `facts.tip_key`) are skipped, and so are features the member evidently uses (Index present → no Index tip; diary entry → no diary tip). The business tip is skipped while the business topic is off. Facts: `tip_key` plus the English name and summary, as source data for the model.
TEST: services/gateway/test/vtid-05101-companion-generators.test.ts ("VTID-05101: feature_tip (card F8)")

AC-4 `invite_friend` → card F7 (community), lowest Phase 3 priority (15), not repeated within 14 days. It fires only after 5 active days in the last 30. Facts: `active_days_last_30`. The intent forbids rewards and earnings talk.
TEST: services/gateway/test/vtid-05101-companion-generators.test.ts ("VTID-05101: invite_friend (card F7)")

AC-5 Every moment (Phase 1 + 3, `COMPANION_MOMENTS`) names a catalog card and carries an English intent that describes what to convey, never a finished sentence (CLAUDE.md rule 41). `MOMENTS` (Phase 1) is unchanged; `pickMoment` now ranks `COMPANION_MOMENTS`, and the morning greeting stays the fallback.
TEST: services/gateway/test/vtid-05101-companion-generators.test.ts ("VTID-05101: every moment")

AC-6 Back-off, read only from the ledger (pure `backoffDecision`). Only real sends count (`status = 'sent'`, mode ≠ shadow, before today). The unreplied streak is counted from the newest send. With 2 unreplied, Vitana stays daily. With 3, she skips the consecutive day and may write the next. With 7, she writes weekly. Any reply resets the streak. Shadow, failed and pending rows never count.
TEST: services/gateway/test/vtid-05101-companion-generators.test.ts ("VTID-05101: back-off (ledger only)")

AC-7 The tick applies the back-off as skip reason `backoff`, after the once-a-day and onboarding checks and before the pacer. A reply lets Vitana write again. The ledger lookback grows from 14 to 60 days, enough for the weekly level and every anti-repeat window. The ledger read now also selects `status`, `replied_at` and `facts`, and pages past PostgREST's 1000-row cap.
TEST: services/gateway/test/vtid-05101-companion-generators.test.ts ("back-off: 3 unreplied real sends skip …", "back-off never counts shadow rows …")

AC-8 Signals are read in ONE batch per page of in-window members: one query per table per id chunk, paged, never one per member. A failed signal source is reported as `signals_unavailable`; only its moments go quiet. The tick still writes no table and calls only the claim/finish RPCs.
TEST: services/gateway/test/vtid-05101-companion-generators.test.ts ("reads the signals in one batch …", "the default signal reads hit the real tables …", "a signal source that fails …")

AC-9 `user_proactive_pause` is honoured. The presence pacer's `canSurfaceProactively` already checks it first (`isPaused`, channel `text` for `messenger_companion`), so no new check was added. The test runs the real pacer: a paused member is skipped as `pacer_paused` and nothing is claimed.
TEST: services/gateway/test/vtid-05101-companion-generators.test.ts ("a proactive pause (user_proactive_pause) skips the member …")

AC-10 Phase 1 contract unchanged: all VTID-05099 tests stay green.
TEST: services/gateway/test/vtid-05099-companion-messages.test.ts

## Decisions taken
- `MOMENTS` stays the Phase 1 list, because the VTID-05099 contract test iterates it with a context that has no Phase 3 signals. The ranked list is the new `COMPANION_MOMENTS`.
- The diary nudge uses F3 only. The G3 "Streak at Risk" variant waits for the card system (VTID-05086/05087).
- Activity signal: `user_active_days` (distinct days in the last 30). There is no cheap per-feature usage table that maps to `FEATURE_TIPS` keys (`user_capability_awareness` uses different keys), so feature tips rotate with anti-repeat and skip the features the member's own signals show they use.
- A signal read that fails leaves the signal absent instead of failing the tick: the moment simply does not fire.
