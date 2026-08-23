# Triage — the 103 declared-but-absent tables

**VTID-03511** · 2026-08-05 · verified against production

Every migration below was **dry-run against production inside `BEGIN … ROLLBACK`**.
Nothing was persisted; verdicts are measured, not inferred.

Regenerate with `node scripts/ci/triage-missing-tables.cjs --live <file>`.

## Result

| verdict | migrations | tables |
|---|---|---|
| **Applies cleanly** | 27 | 69 |
| **Cannot apply** | 15 | 34 |
| total | 42 | 103 |

The `INSPECT` heuristic — *this migration also declares a table that already
exists, so `CREATE TABLE IF NOT EXISTS` will skip it* — predicted
unappliability with **100% accuracy**: all 8 flagged migrations failed.

---

## APPLIED 2026-08-05 (VTID-03514)

All 15 group-A migrations were applied to production, each dry-run immediately
beforehand (state changes as earlier ones land) and each wrapped in a single
transaction.

**Baseline: 103 → 61 missing tables. 42 recovered. Live public tables: 510 → 554.**

Safety check performed before applying: every `DELETE FROM` in the group is
*inside a function body* (idempotency logic on the migration's own new tables),
and every `ALTER … DROP` is `DROP CONSTRAINT IF EXISTS` on its own new
`shop_*` tables. The group is purely additive to production.

The 64 `autopilot_logs` call sites across 27 files are now backed by a real
table for the first time.

### What remains — and it is not homogeneous

| disposition | migrations | tables | action |
|---|---|---|---|
| `VERIFY` | 16 | 35 | apply cleanly, but no code references them — decide apply vs delete the `CREATE` |
| `INSPECT` | 8 | 22 | **cannot apply** — `CREATE TABLE IF NOT EXISTS` masks a diverged existing table |
| `APPLY` | 2 | 4 | clean + code-referenced, but failed dry-run earlier for unrelated reasons — recheck |

Do not bulk-apply the remainder. The `INSPECT` group in particular needs each
migration's schema reconciled against what production actually has.

---

## A — APPLY THESE (as analysed, before the apply) (clean + code actually queries them)

Highest value: live code references these tables today, so every query against
them is currently failing or dead.

| migration | tables | code call sites |
|---|---|---|
| `20260317000000_openclaw_bridge_tables.sql` | 2: autopilot_logs, user_consents | **68** |
| `20251231100000_vtid_01084_community_personalization_v1.sql` | 4: community_groups, community_meetups, community_memberships, community_recommendations | **14** |
| `20260607000000_VTID_03237_video_shop_schema.sql` | 4: shop_saved_products, shop_video_anchors, shop_video_events, shop_videos | **14** |
| `20260102200000_vtid_01130_financial_monetization_engine.sql` | 7: financial_sensitivity_cache, monetization_attempts, monetization_audit, monetization_cooldowns, monetization_signals, value_profiles, value_signals | **10** |
| `20260102000000_vtid_01136_context_fusion_engine.sql` | 3: d42_domain_weights, d42_fusion_audit, d42_priority_cache | **5** |
| `20260102100000_vtid_01124_life_stage_awareness.sql` | 3: life_stage_assessments, life_stage_goals, life_stage_rules | **3** |
| `20260102000000_vtid_01120_emotional_cognitive_signals.sql` | 2: emotional_cognitive_rules, emotional_cognitive_signals | **3** |
| `20260517000000_VTID_02917_orb_wake_timelines.sql` | 1: orb_wake_timelines | **3** |
| `20260101000000_vtid_01116_memory_confidence_trust_engine.sql` | 3: memory_confidence_history, memory_confidence_reasons, memory_source_trust | **2** |
| `20260102200000_vtid_01122_health_capacity_awareness.sql` | 3: capacity_overrides, capacity_rules, capacity_state | **2** |
| `20260520000000_VTID_02932_continuity_tables.sql` | 2: assistant_promises, user_open_threads | **2** |
| `20251231100000_vtid_01099_memory_governance_v1.sql` | 4: memory_deletions, memory_exports, memory_locks, memory_visibility_prefs | **1** |
| `20260318100000_role_admission_system.sql` | 1: user_permitted_roles | **1** |
| `20260428001000_analytics_celebrate_events.sql` | 1: analytics_celebrate_events | **1** |
| `20260607010000_BOOTSTRAP_ORB_R4_teacher_capability_refresh_schedule.sql` | 1: teacher_capability_refresh_schedule | **1** |

**`autopilot_logs` alone has 64 call sites across 27 files** and its migration
(`20260317000000_openclaw_bridge_tables.sql`) applies cleanly. That is the single
highest-value fix in the list.

---

## B — VERIFY THEN APPLY OR DELETE (clean, but no code reference)

These apply without error but nothing queries them. Applying them adds unused
tables; deleting the `CREATE` shrinks the baseline honestly. Needs a human call
on whether the feature is planned or abandoned.

| migration | tables |
|---|---|
| `20251231000001_vtid_01083_longevity_signal_layer.sql` | 2: longevity_signal_rules, longevity_signals_daily |
| `20251231000001_vtid_01093_topics_layer.sql` | 1: topic_registry |
| `20251231100000_vtid_01100_memory_quality_metrics.sql` | 1: memory_quality_metrics |
| `20260102000000_vtid_01112_context_assembly_engine.sql` | 1: context_assembly_audit |
| `20260102000000_vtid_01121_feedback_trust_repair.sql` | 5: behavior_constraints, feedback_propagation_log, safety_flags, trust_scores, user_corrections |
| `20260102000001_vtid_01129_social_context_relationships.sql` | 3: social_comfort_profiles, social_context_audit, social_proximity_cache |
| `20260102110000_vtid_01133_taste_alignment_engine_v1.sql` | 6: taste_alignment_audit, taste_alignment_bundles, taste_reactions, taste_signals, user_lifestyle_profiles … |
| `20260102200000_vtid_01127_availability_readiness_engine.sql` | 3: availability_assessments, availability_config, availability_overrides |
| `20260103000001_vtid_01141_d47_social_alignment_engine.sql` | 3: social_alignment_audit, social_alignment_signals, social_alignment_suggestions |
| `20260117100000_vtid_01180_recommendation_inbox.sql` | 1: recommendation_interactions |
| `20260610120000_BOOTSTRAP_journey_session_index_award.sql` | 1: journey_session_index_awards |
| `20260706100000_vtid_02779_voice_clock.sql` | 1: voice_clock_items |

---

## C — CANNOT APPLY (needs rewriting)

Each fails against the current schema. The error is the starting point, not the
whole story — most are downstream of a table that exists with a diverged shape.

| migration | tables | code | blocked by | error |
|---|---|---|---|---|
| `20251231100000_vtid_01092_services_products_memory.sql` | 4 | 27 | relationship_edges | `ERROR:  42703: column "user_id" does not exist` |
| `20251231000001_vtid_01094_match_feedback_loop.sql` | 6 | 13 | relationship_edges | `ERROR:  42703: column "source_user_id" does not exist` |
| `20260421140000_BOOTSTRAP_awareness_registry.sql` | 2 | 5 | — | `Failed to run sql query: ERROR:  42703: column u.exafy_admin does not ` |
| `20251231000001_vtid_01088_matchmaking_engine.sql` | 2 | 4 | relationship_edges | `ERROR:  42703: column "is_active" does not exist` |
| `20260318000000_vtid_01250_autopilot_automations_engine.sql` | 1 | 3 | automation_runs, referrals, sharing_links | `ERROR:  42710: policy "Service role full access on automation_runs" fo` |
| `20251231000001_vtid_01089_autopilot_prompts.sql` | 2 | 1 | — | `Failed to run sql query: ERROR:  42703: column "id" referenced in fore` |
| `20260102100000_vtid_01119_user_preference_modeling_v1.sql` | 5 | 0 | user_preferences | `ERROR:  42703: column "tenant_id" does not exist` |
| `20260103000000_vtid_01145_overload_detection.sql` | 3 | 0 | — | `ERROR:  42703: column "created_at" does not exist` |
| `20251231000001_vtid_01085_memory_retrieve_router.sql` | 2 | 0 | memory_garden_nodes | `ERROR:  42703: column "last_seen_at" does not exist` |
| `20260102000000_vtid_01117_context_window_metrics.sql` | 2 | 0 | — | `ERROR:  42703: column "id" referenced in foreign key constraint does n` |
| `20251231000001_vtid_01087_relationship_graph_memory.sql` | 1 | 0 | relationship_edges, relationship_nodes | `ERROR:  42703: column "user_id" does not exist` |
| `20251231000001_vtid_01098_memory_timeline_causality.sql` | 1 | 0 | — | `ERROR:  42601: syntax error at or near "window"` |
| `20260119000000_vtid_01190_persistent_vtid_specs.sql` | 1 | 0 | — | `ERROR:  42809: cannot create index on relation "vtid_specs"` |
| `20260201000000_vtid_01225_cognee_extractor.sql` | 1 | 0 | — | `ERROR:  23502: null value in column "topic" of relation "oasis_events"` |
| `20260418060000_tenant_assistant_speeches.sql` | 1 | 0 | assistant_speech_audit | `ERROR:  42703: column "id" referenced in foreign key constraint does n` |

---

## Recommended order

1. **Apply group A** one migration at a time, dry-run first (the script and the
   `BEGIN … ROLLBACK` harness are reproducible). Start with `openclaw_bridge_tables`.
2. **Lower the drift baseline** after each apply so the ratchet locks in progress.
3. **Triage group B** with whoever owns those features — apply or delete the `CREATE`.
4. **Group C is real work**, not cleanup. Each needs its schema reconciled against
   what production actually has. Do not attempt in bulk.

## Why this is not just cleanup

Group C proves the migration files are **not a description of the intended
schema**. `relationship_edges` is declared by four different migrations with
mutually incompatible column sets, and the one in production matches none of the
versions in group C. Any plan that rebuilds a schema by replaying these files
— including the Aurora migration's Phase 3 — will produce the wrong tables, and
will do so silently where `IF NOT EXISTS` masks the difference.
