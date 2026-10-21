# Tasks — Life Timeline

<!-- lane: p1 -->
## p1 — VTID-05167 — Stop the noise + classify (platform)
- [ ] timeline-catalog.json + catalog.ts; projector never writes `system` types
- [ ] migration: classification columns, activity_catalog (generated seed), classify trigger, pg_cron backfill, tier-aware archive, indexes; Aurora restore mirrors
- [ ] SQL test (SQL-ACTIVITY-TIERS.yml) + Jest parity/projector test
- Acceptance: `docs/validation/VTID-05167/acceptance.md`

<!-- lane: p2 -->
## p2 — VTID-05168 — Vitana Index movements + pillar logging (platform)
- [ ] vitana_index_movements + locked vitana_index_recompute_and_record(); every recompute path routed through it (incl. nightly, both overloads, baseline survey); CI guard: no direct writer of vitana_index_scores
- [ ] pillar log moments (voice log_*, log_meal, log_mood, manual log); calendar index.recomputed gets actor_id

<!-- lane: p3 -->
## p3 — VTID-05169 — Timeline API (platform)
- [ ] GET /timeline/spotlight, GET /timeline (pillar/category/date/q, cursor), GET /timeline/:id, hide-from-ai, delete, summary

<!-- lane: p4 -->
## p4 — VTID-05170 — Timeline screen (vitana-v1)
- [ ] ScreenFrame collection + VCard; Index spotlight; pillar chips; day cards; influence badges; detail sheet/panel; --pillar-* tokens; DE-first i18n; RTL; read-only Playwright on staging

<!-- lane: p5 -->
## p5 — VTID-05171 — Companion wiring (platform)
- [ ] profiler tier filter in query; habit-rollup automation (incl. pillar_rhythm); get_my_timeline (lowest Vertex priority); Vitana-noticed insights; timeline_learning_prefs + PUT route

<!-- lane: p6 -->
## p6 — VTID-05172 — Memory section refresh (vitana-v1)
- [ ] Overview "What Vitana knows" + this week's Index story; Permissions learning switches, usage data, export/delete
