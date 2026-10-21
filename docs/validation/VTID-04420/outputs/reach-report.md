# Providers and greeting steps — what actually runs (30 days to 2026-09-23, read-only)

Source tables:

- **`orb_wake_timelines`** (one row per voice session): per-provider results from `continuation_decision_finished` and the ranker's pick from `wake_brief_selected`.
- **`oasis_events`**: `orb.live.diag` with `stage=greeting_sent`, which says which greeting step fired. The query was bounded by topic and time window.

Queries: `commands.log`. No row was written.

## Continuation providers (candidate sources): 249 openings

| Provider | Returned a candidate | Suppressed | Skipped | Errored (all `provider_timeout`, 800 ms) |
|---|---|---|---|---|
| unread_messages_announce | 215 | 25 | 0 | 9 |
| feature_discovery_teacher | 148 | 76 | 0 | 25 |
| login_briefing | 128 | 76 | 0 | **45 (18%)** |
| journey_guide | 62 | 180 | 0 | 7 |
| goal_completion_inquiry | 59 | 183 | 0 | 6 (+1 `life_compass_fetch_failed`) |
| guided_topic_narration | 20 | 0 | 229 | 0 |
| new_day_return | 18 | 224 | 0 | 7 |
| contextual_next_action | 16 | 223 | 0 | 10 |
| voice_wake_brief | 5 | 244 | 0 | 0 |
| first_time_welcome | **0** | 245 | 0 | 4 |
| partner_health_result_ready | **0** | 68 | 0 | 0 |
| real_life_invite | **0** | 246 | 0 | 3 |
| conversation_flow_v3 | **0** | 0 | 249 | 0 |

The ranker picked these candidate kinds:

| Kind | Picks |
|---|---|
| `wake_brief` | 199 |
| `feature_discovery` | 19 |
| nothing (`no_provider_returned_a_candidate`) | 16 |
| `check_in` | 13 |
| `next_step` | 2 |

## Greeting steps (the phrasing layer): 469 `greeting_sent` events

| Step | Fired | Last seen |
|---|---|---|
| newday_overview | 140 | 2026-09-22 |
| legacy default (recorded with no `wake_opener`) | 131 | 2026-09-22 |
| conv_resume | 84 | 2026-09-23 |
| safe_fast_proactive | 60 | 2026-09-22 |
| safe_fast_newday_overview | 25 | 2026-09-22 |
| override_v2 (speaks the ranker's winner) | 15 | 2026-09-22 |
| day_close | 12 | 2026-09-22 |
| safe_fast_first_time_welcome | **1** | 2026-09-19 |
| safe_fast_pending_context | **1** | 2026-09-16 |
| safe_fast_newday | **0** | — |
| silent_reconnect | **0** | — |
| silenced_on_cadence | **0** | — |
| support_report | **0** | new in VTID-04395, not deployed long |

## What this says

1. **The ranker's winner reached the user as the opening only about 15 times out of ~233 openings that had a winner.** Only `override_v2` speaks the winning candidate; the higher steps (newday_overview, conv_resume, day_close) outrank it. Until this VTID nothing recorded that. Every `greeting_sent` now carries these fields (`resolveCandidateOutcome`), and the brain inspector shows them per session:
   - `candidate_provider`
   - `candidate_spoken`
   - `candidate_outranked_by`
2. **`login_briefing` times out on 18% of openings** at the 800 ms per-provider cap (VTID-03741). It is the main source of `wake_brief` lines. Raising the cap trades first-speech latency for candidates. It is left for WS-2.2's scoring and a measured decision, and is not changed here.

## For the owner's decision: never or almost never reached

Nothing below was removed. Each is a flag or a step that telemetry shows is dead today.

| Item | Evidence | Options |
|---|---|---|
| `conversation_flow_v3` provider | skipped 249/249, flag `vitana_journey_conversation_v2_enabled` off | remove, or turn the flag on for a staging trial |
| `real_life_invite` provider | returned 0/249, flag `vitana_real_life_invite_enabled` off | remove, or turn the flag on |
| `first_time_welcome` provider | returned 0/249 | keep (only fires for brand-new users; few in the window), or merge into the greeting step |
| `partner_health_result_ready` provider | returned 0/68 since it was registered | keep (only fires when a partner result exists) |
| `safe_fast_newday` step | 0 fires | remove; its content now shares the phrasing rule, so removal is safe either way |
| `safe_fast_pending_context` step | 1 fire | keep as the safe-fast fallback, or merge with the legacy default |
| `silent_reconnect` / `silenced_on_cadence` steps | 0 fires as `greeting_sent`, because both are silent by design and emit no `greeting_sent` | not evidence of death: they produce no event to count |
| `greeting-pools.ts` `buildFirstTimeWelcomeLine` | no caller in `src` after this VTID (only its own test and an unused import in `orb-live.ts`) | delete in a cleanup VTID |
