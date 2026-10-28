# Plan sparring record — Life Timeline v2 (VTID-05167 … VTID-05172)

- **VTIDs (one per phase):** P1 VTID-05167 (platform) · P2 VTID-05168 (platform) · P3 VTID-05169 (platform) · P4 VTID-05170 (vitana-v1) · P5 VTID-05171 (platform) · P6 VTID-05172 (vitana-v1). Phases P2–P6 reference this record through `sparring_record` in their `scope.json`.
- **Plan hash** (sha256 of the text between the plan markers, trimmed as written): `535ddb70f2564168b5e817eae7191872498736f1d09dd509cd09a905bc232b04`
- **Partner:** plan-sparring-partner (independent, read-only), one agent across both cycles.
- **Cycles:** v1 plan — rounds 1–2, CONVERGED. Owner revision 2026-10-13 (five pillars + Vitana Index spotlight) — v2 rounds 3–5, **CONVERGED**.
- **Owner approval:** owner (d.stevanovic@exafy.io), Claude Code session `session_01BRavW51BdMPjaEFJrJV11G`, 2026-10-13 — "Yes" in reply to the revised Gate 1 message (final plan, every round's findings with responses, the verdict, the files in scope and the test plan). Recorded in each ledger row's metadata (`owner_approval`, `plan_hash`, `sparring_record`).
- **Change class:** standard.

---

# Plan v2 — Life Timeline, Vitana Index spotlight & Companion Memory rebuild

Owner revision 2026-10-13 (after v1 Gate 1): *"Vitanaland is built on 5 pillars of health — Nutrition, Hydration, Exercise, Sleep, Mental health — keeping them in balance is the main formula, shown by the Vitana Index. The Timeline has a spotlight among all other entries highlighting the Vitana Index and the entries for each single pillar and its influence on the Vitana Index."*

<!-- plan:begin -->

**Change class:** standard (migrations, gateway routes, ORB context, frontend screens). 6 phases, one VTID each, each its own PR and its own staging verification.

**Repos:** `exafyltd/vitana-platform` (P1, P2, P3, P5) and `exafyltd/vitana-v1` (P4, P6).

## 0. What is broken today (verified in code)

| # | Problem | Evidence |
|---|---|---|
| B1 | Internal assistant telemetry lands on the member's timeline (~8 `orb.livekit.next_action.candidate` rows per ORB wake, incl. `status:"skipped"`). | `services/gateway/src/services/timeline-projector.ts:62` passes every `orb.*` topic; emitter `assistant-continuation/providers/next-action/emit-telemetry.ts:218-243`; projector runs for every OASIS event (`oasis-event-service.ts:146-157`). |
| B2 | Every card labelled "Activity", generic icon, title-cased raw type. | `vitana-v1/src/pages/memory/Timeline.tsx:208,190-196,216`. |
| B3 | "View Details" = `console.log`; body = `JSON.stringify(activityData).slice(0,200)`. | `Timeline.tsx:233-237,264`. |
| B4 | Search has no handler; Calendar badge counts upcoming calendar events. | `Timeline.tsx:302-319`, `UniversalCalendarButton.tsx:45,75`. |
| B5 | Not responsive: fixed grid `40px_1fr_minmax(120px,auto)`, non-shrinking badge+timestamp, stacked paddings. | `standard-horizontal-card.tsx:277,303-319`, `horizontal-card-list.tsx:229`, `Timeline.tsx:293-294`. |
| B6 | 9 infinite queries + 18 realtime channels per mount. | `Timeline.tsx:60,69-76`, `useActivityHistory.ts:345-388`. |
| B7 | Banner says "NOT used by AI" — false. | `user-context-profiler.ts:9-16`, `live-system-instruction.ts:1043-1060`. |
| B8 | Hardcoded English, raw palette, hand-built tab bar (i18n hard rule; Spotlight SR-02/03/09/16/26). | `Timeline.tsx:27-36`, `horizontal-card-list.tsx:139-171`. |
| B9 | Profiler reads newest 400 rows then filters → noise starves Vitana. | `user-context-profiler-repository.ts:30-37`, `user-context-profiler.ts:557-572`. |
| B10 | Screen visits stored but never turned into habits; archive never scheduled. | `guide/pattern-extractor.ts:72-80`; `vitana-v1/supabase/migrations/20251006130209_*.sql:50-66`. |
| B11 | Memory Overview has dead mock data and toast-only actions. | `vitana-v1/src/pages/Memory.tsx:25-131,45-53`. |
| **B12** | **The Vitana Index and its 5 pillars are absent from the timeline.** `index.recomputed` events are not mapped by the projector; Index changes never reach `user_activity_log`. | `timeline-projector.ts:41-91`; emitters `routes/calendar.ts:95-112`, `routes/guided-journey.ts:185-200`. |
| **B13** | **Nothing records *why* the Index moved.** `vitana_index_scores` is one upserted row per day (`feature_inputs.subscores` overwritten each recompute). Only calendar and guided-journey paths emit a delta event; voice `log_*`, manual log (`routes/integrations.ts:129-208`), diary (`routes/memory.ts:~1725`, `services/memory/diary.ts:~101`) and wearable bridge recomputes emit none. The calendar `index.recomputed` has no `actor_id`, so the profiler's `last_movement` lookup (filters by actor) misses it. | `vitana_index_compute_v3.sql:402-413`; `user-context-profiler-repository.ts:72-81`; `voice-tools/health-log.ts:168,186`. |
| **B14** | **Pillar logging leaves no trace for the member.** Voice `log_water/log_sleep/log_exercise/log_meditation/log_meal/log_mood` and the manual log dialog write `health_features_daily` but emit no event → never on the timeline. | `voice-tools/health-log.ts:29-54`, `orb-tools/health-depth-tools.ts:204,328`, `routes/integrations.ts:129`. |
| **B15** | **Two overloads of the user-callable compute.** `health_compute_vitana_index(DATE,TEXT)` (used by the frontend self-heal `useVitanaIndex.ts:119-122` and `routes/health-repository.ts:38`) lacks the community→Mental tags that `(DATE)` and the canonical per-user function include, so the same day can be scored two ways. Any movement log built on top would show phantom Mental jumps. | `vitana_index_compute_v3.sql:121` vs `pillar_tags_community_engagement.sql:36,389`. To confirm read-only against the live function list before P2. |

## 1. Design principles

From mature lifelogging / companion products (Google Maps Timeline: visits, not pings; Apple Journal: moments, not signals; Oura/Whoop: one daily score with contributors first, samples on drill-down; ChatGPT/Pi "Manage memory": plain-language, forgettable; GDPR Art. 9 for health):

1. **The Vitana Index is the headline.** The timeline opens on the Index and the balance of the 5 pillars; everything below explains what moved it.
2. **Every pillar entry shows its influence — honestly.** A pillar entry shows the change it caused ("+6 Exercise") only when that change was actually measured at the moment it was recorded; otherwise it says what it counted toward ("Counted for Hydration · streak day 5"). Never an invented number.
3. **Balance is the formula.** The real compute multiplies the total by a balance factor (min/max pillar ratio: ≥0.70 → ×1.0, ≥0.50 → ×0.9, ≥0.30 → ×0.8, else ×0.7; `vitana_index_compute_v3.sql:365-381`). The spotlight shows it in plain words: "Your pillars are in balance — full score" / "Hydration is holding your balance back (−10%)".
4. **Moments, not logs.** One human sentence in the member's language; never IDs/JSON/system decisions.
5. **Progressive disclosure.** Index spotlight → day → moments → one detail sheet.
6. **Store everything, show little.** Screen visits, dwell, single assistant turns are stored for learning, never listed; surfaced only as confident insights.
7. **Honest transparency + control.** Per-category learning switches, hide-from-Vitana, delete, export.
8. **The companion closes the loop.** Vitana can say what moved the Index and which pillar to balance next; at most one "Vitana noticed" card per day.
9. **Special categories protected.** Health/mood/medication follow VTID-04798 sensitivity rules; never in shared surfaces.

## 2. Tiers

| Tier | Stored | Shown | Used by Vitana | Examples |
|---|---|---|---|---|
| `spotlight` | yes | Vitana Index card + Index-moment cards | yes | Index changed for the day, tier reached, balance changed, pillar slipping/recovering |
| `moment` | yes | one card each | yes | pillar entries (water logged, workout synced, sleep synced, mood check-in), diary, RSVP, post |
| `digest` | yes | inside daily "Your day" card | aggregated | reactions, music, notifications opened |
| `silent` | yes | never individually | via habit rollups | page view, dwell, tab switch, single ORB turn |
| `system` | not in `user_activity_log` (stays in `oasis_events`, 14 days) | never | never | `orb.livekit.*`, `orb.navigator.*`, next-action telemetry |

## 3. Timeline catalog

Every activity type has: `pillar` (one of `nutrition|hydration|exercise|sleep|mental` or null), optional `secondary_pillar`, `category`, `topic`, `tier`, `icon`, `sensitivity`, i18n `summary_key`, allowed `params`. Pillar keys and the tag/feature mapping are taken from the compute itself (`vitana_index_compute_v3.sql:61-78`, `pillar_tags_community_engagement.sql:94-98`) and the canonical list `services/gateway/src/lib/vitana-pillars.ts:21-27` — the catalog is checked against them in CI so a pillar can never drift from what actually scores.

### A. Vitana Index (spotlight)
- Index updated for the day (total + per-pillar change, top contributor) · tier reached (e.g. new tier from `lib/vitanaIndex.ts` tiers) · balance improved / balance penalty applied · pillar on a streak (7/14/30 days, matching compute streak tiers) · pillar slipping (pillar-momentum "slipping") · pillar recovered · baseline survey completed · Index plan created with Vitana (`create_index_improvement_plan`)

### B. The five pillars (moments, each with pillar colour/icon and influence badge)
1. **Nutrition** — meal logged (voice/manual/diary) · macro balance recorded · glucose / HbA1c biomarker uploaded · nutrition calendar activity completed · recipe saved [digest]
2. **Hydration** — water logged (voice/manual/diary) · daily hydration goal reached · hydration calendar activity completed
3. **Exercise** — workout synced from wearable · workout logged · steps synced / step goal reached · VO2max update · movement calendar activity completed (walk, workout)
4. **Sleep** — sleep synced (duration, efficiency, stages) · sleep logged · HRV / recovery update · rest/recovery calendar activity completed
5. **Mental** — mood check-in ⚕ · stress level ⚕ · meditation / breathing minutes · journal or diary entry (always counts for Mental, per `diary-health-extractor`) · mindfulness/learning calendar activity completed · **social activity that the compute counts for Mental** (meetup attended, group joined, connection/match, chat started — tagged `secondary_pillar: mental` because the compute's community tags feed Mental)
- Cross-pillar: Guided Journey session listened (+2 bonus, `journey-index-award.ts:17-20`) · calendar activity matching no pillar ("halo", +1 to all five) · wearable connected/disconnected

### C. Life (moments without a pillar unless the compute tags them)
6. **Diary & Reflection** — diary entry (text/voice/photo) · daily learning · reflection answered · memory saved to knowledge
7. **Goals & Life Compass** — Life Compass set/changed · goal created · sub-goal done · milestone · alignment check you answered
8. **My Journey** — step completed · audiobook episode finished · stage advanced · episode started [digest]
9. **Conversations with Vitana** — conversation (one card per session, 1-line summary) · Vitana remembered something new · you asked to forget · reminder created · recommendation accepted · recommendation dismissed/snoozed [digest] · single turn [silent]
10. **Community** — post published · comment [digest] · reaction [digest] · group joined/left · connection/match · chat started (no content) · profile updated
11. **Events & Calendar** — RSVP · attended · created · calendar event added · reminder fired [digest]
12. **Live & Media** — joined/hosted live room · music [digest] · video [digest]
13. **Discover & Shop** — product saved [digest] · order placed · service booked · offer opened [silent]
14. **Wallet & Rewards** — VTNA earned · reward redeemed · subscription changed · payment
15. **Account & Privacy** — new-device sign-in · language changed · consent changed · data export · notification settings [digest]
16. **App usage (silent)** — screen visited · time on screen · tab/filter switched · search · app open/close · notification opened [digest] · feature card seen

Unknown types default to `silent` (never shown, counted in a metric).

## 4. Influence on the Index — how it is measured (new)

- New table **`vitana_index_movements`** (`id, tenant_id, user_id, at, trigger, source_kind, source_ref, before jsonb, after jsonb, delta_total int, delta_pillars jsonb, balance_before numeric, balance_after numeric`), RLS owner-read, service-role write.
- New SQL function **`vitana_index_recompute_and_record(p_user, p_date, p_trigger, p_source_kind, p_source_ref)`**, one transaction: `pg_advisory_xact_lock(hashtextextended('vitana_index:'||p_user,0))` → read today's row (before) → call the canonical `health_compute_vitana_index_for_user` → read after → insert a movement row **only if anything changed**. The lock serialises every recompute for the same member, so two near-simultaneous entries each get their own correct delta. **Every** recompute path goes through it — no path calls the canonical function directly any more (incl. the nightly scheduler and the user-callable overloads), so no unlocked writer can interleave. Both the gateway helper `recomputeVitanaIndexForUser` (`routes/calendar.ts:59-129`) and the calendar trigger `trg_calendar_completion_recompute` switch to it; every recompute path listed in B13 (voice `log_*`, manual log, diary, wearable bridge, guided-journey, nightly 02:00 scheduler) passes its own `trigger` + `source_ref`.
- **Attribution rule:** a pillar entry's influence = the movement recorded by the recompute that entry triggered. Batch sources (wearable sync) attribute to the sync moment ("Wearable sync — Sleep +15, Exercise +5"). The nightly movement (streak changes, 30-day window rolling) is labelled "Daily update" and shown only inside the day's Index card. Zero-change entries show what they counted toward, never a number.
- The Guided Journey +2 that today is added only on read in the profiler (`user-context-profiler.ts:451-452`) is shown as its own labelled contribution, not folded into a movement it did not cause.
- **B15 fix:** `health_compute_vitana_index(DATE,TEXT)` stays `SECURITY DEFINER` with its existing GRANT to `authenticated`, resolves `auth.uid()` itself and calls `vitana_index_recompute_and_record(auth.uid(), p_date, 'self_heal', …)` (which calls the canonical function); the `(DATE)` overload is aligned the same way. `health_compute_vitana_index_for_user` and the recording function keep their REVOKE from `authenticated` (service/definer only) — no privilege widening. Every path now scores identically. This can raise some members' Mental pillar (community activity now counted on every path, as it already is nightly). Listed as owner decision D4.
- Calendar `index.recomputed` gets `actor_id` so the profiler's `last_movement` works.
- Pillar logs emit timeline moments: voice `log_*`, `log_meal`, `log_mood`, manual log write a `health.log.<pillar>` moment via `writeTimelineRow` (same direct path diary uses, `routes/diary.ts:714-730`), with `source_ref` linking to the movement.
- Movements feed the timeline as `spotlight` items (projector maps them; no duplicate OASIS topic needed).

## 5. Phases

### P1 — Stop the noise + classify (platform) — VTID A
- `timeline-catalog.json` + loader `services/gateway/src/services/timeline/catalog.ts` (pillar, secondary_pillar, category, topic, tier, icon, sensitivity, summary_key, params). CI test: every pillar-tagged type maps to a pillar in `vitana-pillars.ts`; every entry has DE+EN keys.
- Projector: catalog lookup replaces the `orb.*` pass-through; `system` never projected; projector sets `pillar/category/topic/tier` itself.
- Migration (`vitana-platform/supabase/migrations/`): add `pillar, category, topic, tier (check incl. spotlight), hidden_from_ai, hidden_at` to `user_activity_log` **and** `user_activity_log_archive`; `activity_catalog` table seeded from the JSON (CI parity test); BEFORE INSERT trigger `classify_activity()` fills only NULL fields (frontend-written rows); index `(user_id, tier, created_at desc)` and `(user_id, pillar, created_at desc)`.
- Backfill outside the migration: `backfill_activity_tiers(5000)` on pg_cron every minute, newest first, self-unscheduling; UPDATE only, no deletes; NULL tier read as `silent`.
- Replace `archive_old_activity_logs()` with explicit column list, archiving only `silent`/`system` older than 180 days; schedule with pg_cron.
- Mirror all DDL into `services/postgrest-aurora-proxy/aurora-restore-0{1,2,3,6}-*.sql`.
- Tests: projector never writes `orb.livekit.next_action.candidate`; trigger never overwrites; catalog/seed parity; pillar parity.

### P2 — Vitana Index movements & pillar logging (platform) — VTID B
- Confirm B15 read-only against the live function list; migration: `vitana_index_movements` + `vitana_index_recompute_and_record()`; `(DATE,TEXT)` overload → wrapper over canonical; calendar trigger switched to the recording function. Mirror DDL into Aurora restore scripts.
- Baseline survey (`routes/health.ts:746-779` → `health-repository.ts:52` `upsertVitanaIndexScore`, today a TypeScript-computed direct upsert): saves the survey answers as today, then calls the recording function with `trigger='baseline_survey'` instead of upserting a TS-computed score; `upsertVitanaIndexScore` is removed once it has no caller. The canonical compute already scores the baseline from `vitana_index_baseline_survey`, so the member's starting Index is the one the nightly run would give them anyway, and the timeline shows "Your health survey set your starting Vitana Index". CI guard test: no gateway code writes `vitana_index_scores` directly (grep-based), so the "single locked writer" invariant cannot regress.
- `scheduler_vitana_index_compute_daily` calls the recording function per user with `trigger='daily'` (zero-change guard writes nothing for unchanged members; cost = one extra indexed SELECT per member per night).
- Gateway: `recomputeVitanaIndexForUser` calls the recording RPC; voice `log_*` (`voice-tools/health-log.ts`), `log_meal`/`log_mood` (`orb-tools/health-depth-tools.ts`), manual log (`routes/integrations.ts`), diary recompute (`routes/memory.ts`, `services/memory/diary.ts`, `orb-tools-shared.ts`), wearable bridge (`wearable-features-bridge.ts`), guided-journey award, nightly `daily-recompute-service.ts` all pass trigger + source_ref; calendar `index.recomputed` gets `actor_id`.
- Pillar log moments written to `user_activity_log` with pillar + movement link.
- Tests: SQL concurrency test — two recording calls for the same member in parallel sessions produce two movements whose deltas sum to the total change; grant test — `authenticated` cannot execute `_for_user` or the recording function directly. Jest — each recompute path records a movement with the right trigger; no movement row when nothing changed; zero-change entry has no number; SQL test for before/after/delta and balance factor; overload parity test (same inputs → same scores on both overloads); `npm run test:support`/`test:roles` stay green.

### P3 — Timeline API (platform) — VTID C
- `GET /api/v1/timeline/spotlight` — today's Index: total, tier, change today and over 7 days, 5 pillars (score 0–200, change, momentum), balance factor + plain-language reason key, weakest pillar, top contributors today (from movements). Reads `vitana_index_scores` + movements + pillar momentum; no recompute on read.
- `GET /api/v1/timeline?cursor&pillar&category&from&to&q` — spotlight + moments (+ day digest when ≥3 digest items or ≥10 min app usage; never special-category), each item `{id, at, tier, pillar, secondary_pillar, category, topic, icon, summary:{key,params}, influence:{kind:'measured'|'counted', delta_pillars?, delta_total?, streak_day?}, deep_link?, sensitivity, hidden_from_ai}`.
- `GET /api/v1/timeline/:id` (readable detail incl. "how this affected your Vitana Index"), `POST /:id/hide-from-ai`, `DELETE /:id` (own rows), `GET /api/v1/timeline/summary` (counts per pillar/category for chips and date jump).
- Responses are `{key, params}`; frontend renders.
- Tests: auth, cross-user isolation, tier/pillar filtering, influence only from movements, hidden rows, contract snapshot.

### P4 — Timeline screen rebuild (v1) — VTID D
- `src/pages/memory/Timeline.tsx` on `ScreenFrame archetype="collection"` + `VCard`; one `useTimeline` infinite query + `useTimelineSpotlight`; remove the 9 hooks / 18 channels (one realtime invalidation channel).
- **Vitana Index spotlight** at the top (mobile: full-width card; desktop: sticky context rail): total + tier + today's change; the 5 pillars as bars (0–200) with the existing pillar icons (`VitanaIndexDetail.tsx:73-79`) and new design tokens `--pillar-nutrition|hydration|exercise|sleep|mental` (light + dark, added to the token sheet; the raw palette gradients in `PillarsOfHealth.tsx:13-17` are not copied), each with today's change; balance line in plain words; weakest pillar with one suggested action (deep link); tap → `/health/vitana-index`.
- **Pillar chips first:** All · Nutrition · Hydration · Exercise · Sleep · Mental · Life (other categories in a "More" sheet).
- Day sections: "Index moment" card when the Index changed that day ("Your Vitana Index rose to 512 (+8): Sleep +6, Exercise +2"), then moments. Pillar moments show pillar icon/colour + influence badge ("+6 Exercise" measured; "Counted for Hydration · day 5" counted). Social moments counted for Mental show a small Mental tag.
- Detail: bottom sheet (mobile) / side panel (desktop) with readable detail, influence explanation, "Open", "Hide from Vitana", "Delete".
- Real search; date-jump picker replaces the unrelated Calendar badge; "+" popup removed (moves to Permissions); honest one-line transparency text.
- States, RTL, logical props, DE-first i18n (`src/i18n/de/timeline.json`, pillar names reuse `vitanaIndex.json`), no dead controls.
- Tests: Vitest (summary + influence rendering, measured vs counted, unknown hidden); Playwright staging spec at 390×844 and 1440×900: spotlight renders 5 pillars, no horizontal overflow, no JSON, no generic "Activity", pillar chip filters, detail opens (GET only).

### P5 — Companion wiring (platform) — VTID E
- `fetchActivityLogRows` (`user-context-profiler-repository.ts:30-37`) gets the filter `tier in ('spotlight','moment','digest') and not hidden_from_ai` in the query itself, and the app-level prefix filter in `user-context-profiler.ts:557-572` is reduced accordingly (fixes B9); `[HEALTH]` block gains "what moved the Index this week" from movements (fixes `last_movement`).
- Habit rollups (`services/gateway/src/services/timeline/habit-rollup.ts`, own automation-registry entry; AP-0906 unchanged) → `user_routines` kinds `screen_habit`, `active_hours`, `feature_affinity`, **`pillar_rhythm`** (when each pillar is usually logged/synced).
- ORB tool `get_my_timeline(range, pillar?, category?)` returns structured items + movements; model composes speech (rule 41). Lowest priority tier in `vertex-tool-catalog-budget.ts`; test that the packed Vertex catalog stays ≤ budget with all high-priority tools kept. Existing `get_vitana_index`/`get_pillar_subscores` unchanged.
- "Vitana noticed" (≤1/day, `spotlight` tier): balance insights from movements + momentum ("Hydration has been your weakest pillar for 5 days — it costs you 10% of your score"); dismissible.
- `timeline_learning_prefs (user_id, category, learn, updated_at)` + `app_usage_learning`, RLS owner-only, missing row = on; `PUT /api/v1/timeline/learning-prefs`; read by profiler + rollup. Pillar data stays governed by existing health consent/sensitivity, not by these switches alone.
- Tests: profiler excludes system/hidden/learn-off; rollup unit tests; tool contract; roles suite green.

### P6 — Memory section refresh (v1) — VTID F
- Overview (`/memory`): remove mock arrays; "What Vitana knows about you" (facts, routines incl. pillar rhythms, goals) with edit/forget via existing endpoints; this week's Index story (biggest pillar gain, balance); link into timeline.
- Permissions (`/memory/permissions`): per-category learning switches, app-usage switch, usage-data count, export, delete-all-usage-data.
- Tests: Vitest + read-only Playwright.

## 6. Out of scope
- New pillar data writers that do not exist yet (meal photo logging, hydration reminders, Apple Health/Oura/Whoop connectors listed as roadmap in `routes/integrations.ts:83-89`). Their catalog entries exist and render the day a writer ships.
- Changing the Index formula, weights or balance factors (only B15 alignment so every path uses the formula that already runs nightly).
- Enabling `WEARABLE_FEATURE_BRIDGE_ENABLED` in production (separate decision; the bridge is instrumented in P2 so it is ready).
- `product_analytics_events`. What's New card (redesign of an existing screen).

## 7. Owner decisions taken as defaults
- D1: `silent`/`system` rows archived after 180 days; spotlight/moments kept until the member deletes them; Index movements kept as long as `vitana_index_scores`.
- D2: "Learn from my app usage" defaults on; off stops rollups and deletes app-usage routines.
- D3: Existing noise rows reclassified, not deleted.
- D4: Align the `(DATE,TEXT)` compute overload with the canonical one (may raise some members' Mental pillar to what the nightly run already gives them).
- D4b: The baseline survey's starting score comes from the canonical compute instead of the separate TypeScript calculation (same inputs; the value the nightly run already converges to).
- D5: No historical movements are back-filled — influence appears from the P2 release onward; earlier days show the daily Index change only (from `vitana_index_scores` history).

## 8. Files in scope
Platform: `services/gateway/src/services/timeline-projector.ts`; `services/gateway/src/services/timeline/*` (new: catalog, habit-rollup); `services/gateway/src/routes/timeline.ts` (new) + mount in `index.ts`; `routes/calendar.ts`, `routes/integrations.ts`, `routes/memory.ts`, `routes/guided-journey.ts`, `services/memory/diary.ts`, `services/orb-tools-shared.ts`, `services/voice-tools/health-log.ts`, `services/orb-tools/health-depth-tools.ts`, `services/wearable-features-bridge.ts`, `services/daily-recompute-service.ts`; `services/user-context-profiler*.ts`; `orb/live/tools/live-tool-catalog.ts`, `orb/live/tools/vertex-tool-catalog-budget.ts`; automation registry; `supabase/migrations/<new>` (×3); `services/postgrest-aurora-proxy/aurora-restore-0{1,2,3,6}-*.sql`; `DATABASE_SCHEMA.md`; tests.
Platform also: `routes/health.ts`, `routes/health-repository.ts`.
v1: `src/pages/memory/Timeline.tsx`; `src/hooks/useTimeline.ts`, `useTimelineSpotlight.ts` (new); `src/components/timeline/*` (new); `src/pages/Memory.tsx`; `src/pages/memory/Permissions.tsx`; `src/i18n/{de,en,…}/timeline.json`; `src/design/screen-manifest.json`; `docs/SCREEN_INVENTORY.md`; Playwright spec + `docs/validation/<VTID>/staging-tests.json`. `useActivityHistory.ts` and its other consumers untouched; `useVitanaIndex.ts` self-heal unchanged (it benefits from the D4 alignment server-side).

## 9. Test plan
Per phase as above. Every phase: local lint/typecheck/unit, PR CI, merge → staging deploy → STAGING-VERIFY (read-only), Gate 2 per deploying phase. No writes against production or staging data in any test; write paths and Index movements proven by Jest/Vitest and SQL tests.

<!-- plan:end -->

---
## Sparring history
- v1 cycle (rounds 1–2): findings F1–F9, all accepted/closed; verdict CONVERGED (see plan-life-timeline.md).
- Owner revision 2026-10-13 (5 pillars + Vitana Index spotlight) → second cycle with the same partner.

## Planner responses — Round 3 (cycle 2, pass 1)
- **F10 (concurrency) — ACCEPTED.** Per-member transaction-scoped advisory lock inside the recording function, and *every* recompute path (gateway helper, calendar trigger, user-callable overloads, nightly scheduler) routed through it so no unlocked writer remains. SQL concurrency test added.
- **F11 (privileges) — ACCEPTED.** Wording adopted: overloads stay `SECURITY DEFINER` + existing `authenticated` grant, resolve `auth.uid()` themselves; `_for_user` and the recording function keep the REVOKE. Grant test added.
- **F12 (raw palette) — ACCEPTED.** New `--pillar-*` tokens (light+dark); only the icon map is reused.
- **F13 (nightly batch) — ACCEPTED (wrapper path chosen).** Nightly calls the recording function per member with `trigger='daily'`; the zero-change guard keeps rows down; cost is one indexed SELECT per member. Chosen over the score-diff alternative because otherwise the nightly batch would be an unlocked writer that breaks F10's guarantee.
- **F14 (profiler query) — ACCEPTED.** `fetchActivityLogRows` gets the tier/hidden filter in the query; app-level filter reduced.
- **Q1 —** advisory lock (see F10). **Q2 —** yes, via the wrapper (see F13).

## Planner responses — Round 4 (cycle 2, pass 2)
- F10–F14 closed by partner.
- **F15 (baseline survey direct upsert) — ACCEPTED, option (a).** Survey route saves answers then calls the recording function (`trigger='baseline_survey'`); direct `upsertVitanaIndexScore` removed; `routes/health.ts` + `health-repository.ts` added to scope; CI grep guard that no gateway code writes `vitana_index_scores` directly. Decision D4b recorded.
- **Q1 —** option (a): it appears on the timeline as the starting point of the member's Index story.

## Round 5 (cycle 2, pass 3)
- F15 closed by partner. All 15 findings closed. **Verdict: CONVERGED.**

## Owner approval
- **Approved by owner (d.stevanovic@exafy.io) in Claude Code session session_01BRavW51BdMPjaEFJrJV11G on 2026-10-13 — "Yes" — plan hash `535ddb70f2564168`.**

---

## Cycle 1 (v1 plan, before the owner revision) — findings as reported by the partner

Round 1 verdict NOT CONVERGED:
- F1 [major] get_my_timeline vs the Vertex tool-catalog byte budget (48 KB, VTID-04026) — state its priority tier.
- F2 [major] Aurora migration interaction — DMS does not carry triggers; mirror DDL.
- F3 [major] trigger vs projector precedence — fill only NULL fields.
- F4 [major] `memory_visibility_prefs` has no gateway reader and means "who can see".
- F5 [minor] where summaries render (client keys vs server `tt()`).
- F6 [minor] day-digest threshold unspecified.
- F7 [minor] archive function repo + tier filter.
- F8 [minor] no What's New card — aligned.
- F9 [minor] other consumers of `useActivityHistory`.
- Q1 trigger fires for service-role REST inserts? Q2 backfill size? Q3 extend pattern-extractor or sibling?

Round 2 verdict: all closed — **CONVERGED**. (Planner responses: see the v1 file's "Planner responses — Round 1", carried into the v2 plan body.)

## Planner responses — Round 1

- **F1 (Vertex tool budget) — ACCEPTED.** `get_my_timeline` goes at the LOWEST priority tier in `vertex-tool-catalog-budget.ts` (trimmed first for Vertex sessions; Nova/cascade keep it). P4 adds a test asserting the packed Vertex catalog for an authenticated community session stays ≤ `VERTEX_TOOL_CATALOG_BYTE_BUDGET` and that every previously-kept high-priority tool is still kept.
- **F2 (Aurora) — ACCEPTED.** Supabase stays primary (backend.md §3). DMS does not carry triggers/functions, so P1 also mirrors the new columns, check constraint, index, `activity_catalog` table, `classify_activity()` trigger and the replaced archive function into the Aurora restore DDL (`services/postgrest-aurora-proxy/aurora-restore-01-defaults.sql`, `-02-check-unique-constraints.sql`, `-03-indexes.sql`, `-06-policies.sql`), same pattern those files already use for `user_activity_log`. `activity_catalog` is a read-only reference table and is added to that DDL too.
- **F3 (trigger precedence) — ACCEPTED.** Trigger fills `category`/`topic`/`tier` only when NULL (`COALESCE(NEW.x, lookup)`). The projector sets them from the catalog; the trigger only classifies frontend-written rows. Jest asserts the projector payload carries all three; a SQL test asserts the trigger never overwrites a provided value.
- **F4 (`memory_visibility_prefs`) — ACCEPTED (scope corrected).** Verified: no gateway reader exists, and its values (`private|connections|professionals|custom`) mean *who can see*, not *may Vitana learn*. P4 therefore does NOT reuse it. P4 adds a new table `timeline_learning_prefs (user_id, category, learn boolean, updated_at)` + `app_usage_learning boolean` (one row per user/category, RLS owner-only) and the reader in the profiler/rollup. P5's Permissions screen writes it through a new `PUT /api/v1/timeline/learning-prefs`. Missing row = learn on (D2).
- **F5 (where summaries render) — ACCEPTED, decision made.** P2 API returns `{key, params}`; the frontend renders with its 11-locale catalogs (DE first). The ORB tool does NOT return rendered sentences: it returns structured items `{date, category, topic, params}` and the model composes speech in the member's language — required by Part 1 rule 41 (never hardcode a spoken sentence). So no new `tt()` keys are needed.
- **F6 (digest threshold) — ACCEPTED.** A `day_digest` item is generated only when a day has ≥3 digest-tier items OR ≥10 minutes of recorded app usage; otherwise no digest card for that day. Health/mood (special-category) never appear in a digest.
- **F7 (archive function repo + tier filter) — ACCEPTED, and an extra bug found.** The migration lives in `vitana-platform/supabase/migrations/` (the repo already owns `user_activity_log` changes, e.g. `20260420120000_BOOTSTRAP_history_aware_timeline.sql`). The replaced function archives only `tier in ('silent','system')`. Additionally: the current function does `INSERT … SELECT *`, so adding columns to `user_activity_log` would break it — P1 adds the same columns to `user_activity_log_archive` and switches to an explicit column list.
- **F8 — acknowledged, no change.**
- **F9 (consumers) — ACCEPTED.** Verified consumers of `useActivityHistory`: `Timeline.tsx`, `useUserActivityLogRealtimeRelay.ts`, `PromoteToKnowledgeDialog.tsx`, `ViewStatisticsDialog.tsx`. `MemoryTimelineTab` uses `useKnowledgeBase`, not this hook. P3 only stops `Timeline.tsx` from using it; the hook and its other three consumers are untouched. Removal is not in this plan.
- **Q1 —** Yes, triggers fire for PostgREST inserts regardless of role (service role bypasses RLS, not triggers). Covered by the F3 test.
- **Q2 (backfill size) — ACCEPTED as a change.** The backfill is NOT done inside the migration. P1 ships a `backfill_activity_tiers(batch int)` function scheduled by pg_cron every minute, 5,000 rows per run ordered by `created_at desc` (newest first, so the live timeline is clean first), self-unscheduling when no NULL-tier rows remain. Readers treat NULL tier as `silent` until classified, so nothing noisy is ever shown during the backfill. Row count is read at implementation time with a read-only `reltuples` estimate.
- **Q3 —** New sibling automation (`habit-rollup.ts`, its own automation-registry entry), not a change to `extractPatternsForUser()`; AP-0906 behaviour is unchanged.

## Cycle 2 (v2 plan) — findings as reported by the partner

Round 3 verdict NOT CONVERGED:
- F10 [major] Concurrency race in the before/after recording wrapper (two near-simultaneous recomputes read the same "before").
- F11 [major] `(DATE,TEXT)` overload wrapper must keep SECURITY DEFINER + `auth.uid()` and must not grant `_for_user` to `authenticated`.
- F12 [minor] `PillarsOfHealth.tsx:13-17` uses raw palette classes — define pillar tokens.
- F13 [minor] nightly batch per-user overhead of the recording function.
- F14 [minor] `fetchActivityLogRows` must carry the tier filter in the query.

Round 4 verdict NOT CONVERGED:
- F15 [major] Baseline survey direct-upserts `vitana_index_scores` (`routes/health.ts:779` → `health-repository.ts:52`), bypassing the recording function and lock.

Round 5: F15 closed; all 15 findings closed — **CONVERGED**.
