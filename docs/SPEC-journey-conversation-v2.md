# SPEC — Vitana Assistant Conversation Flow Restructuring (Journey Conversation V2)

**Status:** developer-ready, implemented behind `vitana_journey_conversation_v2_enabled`
**Governance:** VTID-03307 (ledger spec approved 2026-06-12, approval fc1ffed6-5c54-47b7-a7a1-97e36e5fb9ed)
**Owner:** d.stevanovic@exafy.io

## 1. Core direction

The conversation flow is restructured around the My Journey guided learning
experience **without** creating a parallel assistant architecture. Vitana
Brain, the awareness model, proactive opener, initiative engine,
feature-introduction tracking, pause/frequency controls, Daily Diary voice
tools, Autopilot activation tools, Life Compass logic, and community signals
remain the foundation.

> My Journey teaches. Life Compass gives direction. Daily Diary collects
> lived data. Autopilot turns guidance into action. Vitana Assistant connects
> everything through voice.

## 2. Systems preserved and extended

- `services/gateway/src/services/vitana-brain.ts` — flag-gated V2 path only
- `services/gateway/src/services/guide/types.ts` — `UserAwareness` extended
- `services/gateway/src/services/guide/awareness-context.ts` — extension fetch
- `services/gateway/src/services/guide/opener-mvp.ts` — unchanged (legacy path)
- `services/gateway/src/services/guide/initiative-registry.ts` — unchanged
- `services/gateway/src/services/guide/feature-introductions.ts` — unchanged
- `services/gateway/src/services/guide/presence-pacer.ts` — one new surface
- `services/gateway/src/services/guide/pause-check.ts` — unchanged, reused
- `save_diary_entry` / `activate_recommendation` voice tools — unchanged
- `user_journey`, `user_guided_journey_state`, `journey_checklist_topics`,
  `user_proactive_pause`, `user_proactive_touches`,
  `user_feature_introductions` tables — unchanged, read/reused

No second conversation-state system is introduced. `UserAwareness` is the
single source of assistant awareness; V2 adds one optional `journey_v2` block.

## 3. Awareness state extension (Phase 1)

`UserAwareness.journey_v2` (optional — absent on read failure, so every
existing consumer is unaffected):

- `extended_tenure_stage` — see §4
- `experience_level` — see §4
- `vitana_index_maturity` — see §4 clarification A
- `journey_progress` — mode (guided|full), onboarding status, current
  session, completed topic count/ids, last opened topic, next recommended
  topic (see clarification C)
- `profile_completion_status` — first_name, last_name, birthday,
  profile_picture, gender, location booleans + completion_percent
- `completed_priority_tasks` — life_compass_defined (user-defined, NOT
  system-seeded), profile_completed, diary_started, autopilot_used
- `diary_entry_today` — boolean
- `proactive_pause_state` — paused_all, paused_categories, paused_nudge_keys
- `recent_greeting_openings` — anti-repetition memory from `user_journey`

**Mode detection (§12 resolution):** the durable source of truth for
guided/full mode is `user_guided_journey_state.mode`, read server-side.
`BrainTurnInput.ui_context` may carry a screen/route and, when the frontend
later passes a mode, that value wins for the turn. No frontend change is
required for this slice; a separate frontend spec covers a dedicated My
Journey surface.

### Clarification A — `vitana_index_maturity` derivation

There is no existing field. It derives from `fetchVitanaIndexForProfiler`
(the same snapshot `/api/v1/my-journey` serves) plus engagement:

- snapshot absent → `none`
- else richness = `active_usage_days + 2 × diary_streak_days`:
  `< 7` → `baseline`, `< 20` → `emerging`, `< 45` → `stable`, else `rich`

### Clarification C — journey completion read path

Canonical read path, in this order:

1. `user_guided_journey_state` — `current_session`, `completed_topic_ids`,
   `mode`, `onboarding_status`, `last_opened_topic_id` (curriculum progress)
2. `journey_checklist_topics` (status='published', enabled) ordered by
   `session, position` — next recommended topic = first not in
   `completed_topic_ids`
3. `user_journey` — wave arc, `recent_greeting_openings`, first-session flag

No other table defines "completed" for conversation purposes.

## 4. Maturity model (Phase 2)

`TenureStage` is kept. Two new derived concepts in
`guide/journey-experience.ts` (pure functions, unit-tested):

- `ExtendedTenureStage`: day0 | day1 (1–2) | day3 (3–6) | day7 (7–13) |
  day14 (14–29) | day30plus (30–59) | day60plus (60–89) | day90plus
  (90–179) | day180plus (180+). Calendar only.
- `JourneyExperienceLevel`: first_time | orientation | learning | building |
  active | advanced | mature | returning_low_data.

### Clarification B — composite scoring, not max-signal

A max-of-signals rule over-promotes (one 30-day diary streak with nothing
else would read as "advanced"). The implemented formula is a **capped
additive score** — every signal contributes bounded points:

| Signal | Points | Cap |
|---|---|---|
| active_usage_days | ×1 | 60 |
| completed journey topics | ×4 | 40 |
| completed journey sessions | ×3 | 30 |
| diary_streak_days | ×2 | 30 |
| autopilot activations (lifetime) | ×5 | 25 |
| connections ×2 / groups ×3 | — | 10 / 9 |
| each completed priority task | ×10 | 40 |
| index maturity none/baseline/emerging/stable/rich | 0/5/10/20/30 | 30 |

Score bands: `<10` first_time, `<30` orientation, `<60` learning, `<100`
building, `<150` active, `<220` advanced, else mature.

Calendar guards (both directions):
- floor: `first_time` only within the first 3 calendar days
- caps: building ≥ day 14, active ≥ day 30, advanced ≥ day 90, mature ≥ day 180
- backfill: `days_since_signup ≥ 90` AND band ≤ orientation →
  `returning_low_data` (respectful re-entry, never beginner wording). An
  existing 6-month user with empty V2 fields is therefore NEVER treated as
  first-time.

Conversation style per level is encoded in `EXPERIENCE_STYLE_GUIDANCE` and
injected into the V2 prompt block.

## 5–7. Teaching center + Autopilot pillar + single proactive arbiter (Phases 3–4, 6)

`guide/conversation-focus.ts#pickConversationFocus` is the **single
arbiter**. The opener layering, initiative engine, and tip curriculum stop
being independent decision-makers on the V2 path — they are candidate
inputs. Exactly one proactive focus per turn.

Priority order (3–11; 1 user safety and 2 explicit user request are handled
upstream by the brain/LLM before any proactive content):

3. overdue Autopilot calendar event
4. missing user-defined Life Compass (system-seeded ≠ defined)
5. Daily Diary — no entry today (voice-first via `save_diary_entry`)
6. upcoming Autopilot event within 24 h
7. high-value open Autopilot recommendation (consent-gated
   `activate_recommendation`)
8. incomplete priority profile fields (early tenure / pre-mature only;
   identity stays authoritative in profile settings — voice never silently
   mutates protected identity fields)
9. next My Journey session/topic (teaching candidate; guided mode leads,
   full-app mode reconnects gently)
10. community connection / pending match
11. occasional inspirational or responsibility message (pacer-capped)

Arbiter rules: scoped pauses (`nudge_key`/`category`) skip to the next
candidate; `all`/`channel` pauses suppress everything. Already-introduced
features are not re-taught (feature_introductions check on the teaching
candidate). One focus per turn. The selected focus is recorded via
existing telemetry; the responsibility surface records a pacer touch.

### Clarification D — wave/DYK absorption compatibility

`user_journey.current_wave_id` and the wave-aware opener keep working: the
legacy path (`opener-mvp` + initiative + DYK tour blocks) remains fully
intact whenever `vitana_journey_conversation_v2_enabled` is OFF, and the
flag rolls out cohort by cohort. Wave fields stay populated; the DYK tip
curriculum is superseded on the V2 path only (its teaching role moves to
the journey-topic candidate) and is removed only after full rollout.

## 8–10. Speech intent, locale, frequency (Phase 5)

`guide/speech-intent.ts` defines structured speech intents
(`daily_inspiration`, `short_return_greeting`, `responsibility_reflection`)
rendered as prompt constraints — wording is always generated, never
hard-coded. Anti-repetition uses `user_journey.recent_greeting_openings`
(existing capped-5 array). Locale: the existing language-directive
injection (context-pack `buildLanguageDirective`, `i18n/llm-locale.ts`
register rules — DE default, du-form) is mandatory and restated inside the
intent block; German sessions must not leak English.

Frequency reuses `presence-pacer` + `user_proactive_touches` +
`user_proactive_pause`. New surface: `vitana_responsibility_message`
(nudge_key `daily_responsibility_reflection`, max once/day). Same-day
return sessions get the short greeting intent, never the full inspiration.
After a pause expires, no backlog dump.

## 11. Priority onboarding tasks

Tracked in `completed_priority_tasks` (derived, never stored separately):
Life Compass user-defined; profile fields complete; diary started;
Autopilot used (≥1 lifetime activation). The arbiter motivates the missing
ones via slots 4, 5, 7, 8.

## 14. Metrics

No per-turn funnel counters into OASIS. The V2 path emits through the
existing `emitGuideTelemetry` channel (`guide.focus.selected`,
`guide.focus.none`, `guide.focus.suppressed`) and the pacer touch log, the
same destinations the opener/initiative telemetry already uses.

## 15. Prompt budget

The V2 block injects only: experience style (≤6 lines), one focus
candidate, one speech intent, compact journey-progress line (IDs + counts,
never the 250-topic catalog). Target ≤ 1,200 tokens, hard max 1,500.

## 16. Rollout

`vitana_journey_conversation_v2_enabled` system control (default OFF).
Legacy flow is the fallback at every step. Stages: dev users → beta cohort
→ first-time users → 90-day onboarding cohort → all users.

## 17. Test coverage (implemented)

- `test/journey-experience.test.ts` — stage/level derivation incl. the five
  §18 scenarios and the single-signal over-promotion guard
- `test/awareness-extensions.test.ts` — extension builder from mocked
  tables; mature-user backfill behavior; fail-open defaults
- `test/conversation-focus.test.ts` — arbiter ordering (overdue > compass >
  diary > upcoming > rec > profile > journey > community > inspiration),
  one-candidate guarantee, scoped-pause skip vs all-pause suppression
- `test/speech-intent.test.ts` — intent selection (same-day short
  greeting), anti-repetition memory, language rule presence, no hard-coded
  motivational paragraphs leaking into intents
- `test/journey-conversation-v2.test.ts` — composed block: single ON-YES
  contract, experience-style injection, returning_low_data wording rules
