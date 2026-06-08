-- VTID-03175 — Production drift audit (read-only diagnostic).
--
-- HOW TO RUN
--   Paste this file into the Supabase SQL editor for the production project
--   and click Run. This script performs SELECT-only queries; no DDL, no
--   INSERT/UPDATE/DELETE, no transaction, no schema cache reload. Safe to
--   run any time, including production hours.
--
-- WHAT IT DOES
--   Compares the production public schema against the canonical list of
--   tables created by `supabase/migrations/*.sql` (including
--   `data-fixups/`). Surfaces three diagnostics:
--
--     Q1 GHOST TABLES — tables that EXIST in production but are NOT
--                       created by any in-repo migration. These are the
--                       VTID-03152 / VTID-03165 pattern: ad-hoc DB state
--                       made outside the canonical migration path. Any
--                       new migration touching those names will collide.
--
--     Q2 REVERSE DRIFT — tables that the in-repo migrations CREATE but
--                       are NOT present in production. Should be empty
--                       if every migration has been applied. Non-empty
--                       means a migration is on disk but never ran on
--                       prod (or the table was dropped after creation).
--
--     Q3 SUMMARY      — table + column count for every public-schema
--                       table, ordered by name. Useful as a reference
--                       artifact alongside Q1 / Q2.
--
-- INPUT — IN-REPO TABLE LIST
--   The VALUES list below was extracted via:
--     python3 -c "import re,glob,os; ..."
--     # see supabase/ops/2026-05-28_VTID_03175_production_drift_audit.md
--     # (or this file's commit message) for the exact extraction script.
--   Generated against main @ b5d8f4e9 (post-VTID-03174 hardening merge).
--   345 distinct table names. Update this list before re-running the
--   audit if new migrations have landed.
--
-- KNOWN LIMITATION
--   This audit detects table-name drift only. Column-level drift on
--   shared table names is NOT covered here — that requires a separate
--   per-table introspection (handled by per-migration pre-condition
--   guards on the tables a given migration touches).

WITH in_repo_tables (table_name) AS (
  VALUES
    ('action_ledger'), ('active_threads'), ('admin_insights'), ('agent_audit_log'),
    ('agent_kb_bindings'), ('agent_kb_bindings_tenant'), ('agent_persona_versions'), ('agent_personas'),
    ('agent_personas_tenant_overrides'), ('agent_routing_keywords_tenant'), ('agent_third_party_connections'), ('agent_tool_bindings'),
    ('agent_tools'), ('agent_voice_config_changes'), ('agent_voice_configs'), ('agents_registry'),
    ('ai_assistant_credentials'), ('ai_consent_log'), ('ai_provider_policies'), ('ai_usage_log'),
    ('analytics_celebrate_events'), ('anticipatory_guidance'), ('app_users'), ('architecture_reports'),
    ('assistant_promises'), ('assistant_speech_audit'), ('automation_runs'), ('autopilot_analyzer_sources'),
    ('autopilot_logs'), ('autopilot_loop_state'), ('autopilot_processed_events'), ('autopilot_prompt_prefs'),
    ('autopilot_prompts'), ('autopilot_recommendation_runs'), ('autopilot_recommendations'), ('autopilot_run_state'),
    ('availability_assessments'), ('availability_config'), ('availability_overrides'), ('awareness_config'),
    ('awareness_config_audit'), ('behavior_constraints'), ('biomarker_results'), ('biometric_events'),
    ('biometric_trends'), ('bootstrap_cache'), ('canonical_fact_key_review_queue'), ('canonical_fact_keys'),
    ('capability_awareness_events'), ('capability_play_log'), ('capacity_overrides'), ('capacity_rules'),
    ('capacity_state'), ('catalog_sources'), ('catalog_vocabulary'), ('catalog_vocabulary_synonyms'),
    ('chat_group_members'), ('chat_groups'), ('chat_messages'), ('cognee_extraction_requests'),
    ('community_group_invitations'), ('community_groups'), ('community_meetups'), ('community_memberships'),
    ('community_recommendations'), ('community_search_history'), ('condition_product_mappings'), ('connector_registry'),
    ('connector_webhooks_log'), ('consolidator_runs'), ('content_items'), ('context_assembly_audit'),
    ('context_window_configs'), ('context_window_logs'), ('conversation_messages'), ('credit_packs'),
    ('d42_domain_weights'), ('d42_fusion_audit'), ('d42_priority_cache'), ('daily_recompute_runs'),
    ('decision_compatibility_score'), ('decision_conflict_pair'), ('decision_policy'), ('default_feed_config'),
    ('dev_autopilot_config'), ('dev_autopilot_executions'), ('dev_autopilot_impact_rules'), ('dev_autopilot_outcomes'),
    ('dev_autopilot_plan_versions'), ('dev_autopilot_prompt_learnings'), ('dev_autopilot_runs'), ('dev_autopilot_scanners'),
    ('dev_autopilot_signals'), ('dev_autopilot_worker_queue'), ('drift_adaptation_plans'), ('emotional_cognitive_rules'),
    ('emotional_cognitive_signals'), ('event_attendance'), ('feature_entitlements'), ('feature_usage'),
    ('feedback_handoff_events'), ('feedback_propagation_log'), ('feedback_tickets'), ('financial_sensitivity_cache'),
    ('geo_policy'), ('goal_plan_steps'), ('goal_plans'), ('governance_catalog'),
    ('governance_categories'), ('governance_enforcements'), ('governance_evaluations'), ('governance_proposals'),
    ('governance_rules'), ('governance_violations'), ('health_features_daily'), ('index_delta_observations'),
    ('kb_documents'), ('knowledge_docs'), ('lab_reports'), ('life_stage_assessments'),
    ('life_stage_goals'), ('life_stage_rules'), ('lifecycle_notification_state'), ('limitation_bypass_log'),
    ('live_highlights'), ('live_room_access_grants'), ('live_room_attendance'), ('live_room_sessions'),
    ('live_rooms'), ('livekit_test_cases'), ('livekit_test_results'), ('livekit_test_runs'),
    ('llm_allowed_models'), ('llm_allowed_providers'), ('llm_routing_policy'), ('llm_routing_policy_audit'),
    ('llm_vtid_policy_snapshot'), ('location_preferences'), ('location_visits'), ('locations'),
    ('longevity_signal_rules'), ('longevity_signals_daily'), ('marketplace_sources_config'), ('match_feedback'),
    ('match_targets'), ('matches_daily'), ('mem_episodes'), ('mem_facts'),
    ('mem_graph_edges'), ('mem_turn_log'), ('memory_access_grants'), ('memory_audit_log'),
    ('memory_categories'), ('memory_category_mapping'), ('memory_confidence_history'), ('memory_confidence_reasons'),
    ('memory_deletions'), ('memory_diary_entries'), ('memory_exports'), ('memory_facts'),
    ('memory_garden_config'), ('memory_garden_nodes'), ('memory_items'), ('memory_locks'),
    ('memory_node_sources'), ('memory_quality_metrics'), ('memory_retrieve_audit'), ('memory_source_trust'),
    ('memory_timeline_snapshots'), ('memory_visibility_prefs'), ('memory_write_dlq'), ('merchants'),
    ('monetization_attempts'), ('monetization_audit'), ('monetization_cooldowns'), ('monetization_signals'),
    ('mood_pattern_aggregates'), ('nav_catalog'), ('nav_catalog_audit'), ('nav_catalog_i18n'),
    ('news_items'), ('notification_categories'), ('oasis_events'), ('oasis_events_v1'),
    ('oasis_spec_approvals'), ('oasis_spec_quality_reports'), ('oasis_spec_validations'), ('oasis_specs'),
    ('onboarding_invitations'), ('orb_wake_timelines'), ('overload_baselines'), ('overload_detections'),
    ('overload_patterns'), ('paywall_events'), ('pending_connector_actions'), ('personalization_change_log'),
    ('policy_render_block'), ('preference_categories'), ('processed_stripe_events'), ('product_clicks'),
    ('product_orders'), ('product_outcomes'), ('products'), ('products_catalog'),
    ('recommendation_interactions'), ('recommendations'), ('redemption_codes'), ('redemption_redemptions'),
    ('referrals'), ('relationship_dates'), ('relationship_edges'), ('relationship_health_context'),
    ('relationship_nodes'), ('relationship_signals'), ('reminders'), ('repair_patterns'),
    ('routine_runs'), ('routines'), ('safety_constraints'), ('safety_flags'),
    ('self_healing_log'), ('self_healing_snapshots'), ('services_catalog'), ('sharing_links'),
    ('signup_attempts'), ('social_alignment_audit'), ('social_alignment_signals'), ('social_alignment_suggestions'),
    ('social_comfort_profiles'), ('social_connections'), ('social_context_audit'), ('social_proximity_cache'),
    ('social_share_log'), ('social_share_prefs'), ('software_versions'), ('subscription_plan_prices'),
    ('subscription_plans'), ('system_capabilities'), ('system_config'), ('system_control_audit'),
    ('system_controls'), ('taste_alignment_audit'), ('taste_alignment_bundles'), ('taste_reactions'),
    ('taste_signals'), ('tenant_admin_audit_log'), ('tenant_assistant_config'), ('tenant_assistant_speeches'),
    ('tenant_autopilot_bindings'), ('tenant_autopilot_runs'), ('tenant_autopilot_settings'), ('tenant_catalog_overrides'),
    ('tenant_health_index_daily'), ('tenant_invitations'), ('tenant_kb_baseline_optouts'), ('tenant_kpi_current'),
    ('tenant_kpi_daily'), ('tenant_settings'), ('tenants'), ('test_contract_runs'),
    ('test_contracts'), ('test_cycles'), ('test_results'), ('test_runs'),
    ('thread_summaries'), ('topic_registry'), ('trust_scores'), ('usage_outcomes'),
    ('user_action_permissions'), ('user_active_days'), ('user_active_role'), ('user_active_roles'),
    ('user_assistant_state'), ('user_blocklist'), ('user_capability_awareness'), ('user_capability_preferences'),
    ('user_category_preferences'), ('user_connections'), ('user_consents'), ('user_constraints'),
    ('user_corrections'), ('user_dampening'), ('user_device_session_log'), ('user_device_tokens'),
    ('user_feature_introductions'), ('user_feedback_reports'), ('user_integrations'), ('user_intent_cover_library'),
    ('user_journey'), ('user_journey_overrides'), ('user_lifestyle_profiles'), ('user_limitations'),
    ('user_location_history'), ('user_location_settings'), ('user_match_preferences'), ('user_notification_preferences'),
    ('user_notifications'), ('user_nudge_state'), ('user_offers_memory'), ('user_open_threads'),
    ('user_permitted_roles'), ('user_personality_profile'), ('user_preference_audit'), ('user_preference_bundles'),
    ('user_preference_inferences'), ('user_preferences'), ('user_proactive_pause'), ('user_proactive_touches'),
    ('user_profiler_version'), ('user_routines'), ('user_session_summaries'), ('user_subscriptions'),
    ('user_taste_profiles'), ('user_tenants'), ('user_topic_profile'), ('vaea_config'),
    ('vaea_detected_questions'), ('vaea_listener_channels'), ('vaea_referral_catalog'), ('vaea_reply_drafts'),
    ('value_profiles'), ('value_signals'), ('vitana_index_baseline_survey'), ('vitana_index_scores'),
    ('vitana_index_trajectory_snapshots'), ('vitana_pillar_agent_outputs'), ('voice_active_provider_changes'), ('voice_architecture_reports'),
    ('voice_canary_baselines'), ('voice_healing_dedupe'), ('voice_healing_history'), ('voice_healing_quarantine'),
    ('voice_healing_shadow_log'), ('voice_healing_spec_memory'), ('voice_parity_drifts'), ('voice_providers'),
    ('vtid_ledger'), ('vtid_specs'), ('wallet_balances'), ('wallet_transactions'),
    ('wearable_daily_metrics'), ('wearable_samples'), ('wearable_waitlist'), ('wearable_workouts'),
    ('worker_registry')
),
prod_tables AS (
  SELECT
    t.table_name::text AS table_name,
    (SELECT count(*)::int FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = t.table_name) AS column_count
  FROM information_schema.tables t
  WHERE t.table_schema = 'public'
    AND t.table_type = 'BASE TABLE'
)

-- ============================================================
-- Q1  GHOST TABLES — exist in prod but NOT created by any in-repo migration
-- ============================================================
-- Expected scenario: only `cart_items` (the known vitana-v1 Discover cart),
-- `checkout_sessions`, `cj_products`, `cj_orders`, `coupons`, and any other
-- vitana-v1 side tables that were created outside this repo.
-- A clean prod / in-repo alignment returns 0 rows.
-- Any UNEXPECTED row here = a new ghost table that must be investigated
-- BEFORE the next migration runs.
SELECT
  'Q1_GHOST' AS check_id,
  p.table_name,
  p.column_count,
  (SELECT string_agg(column_name, ', ' ORDER BY ordinal_position)
     FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = p.table_name) AS columns
FROM prod_tables p
LEFT JOIN in_repo_tables r ON r.table_name = p.table_name
WHERE r.table_name IS NULL
ORDER BY p.table_name;

-- ============================================================
-- Q2  REVERSE DRIFT — in-repo migration creates it, but prod is missing it
-- ============================================================
-- A clean alignment returns 0 rows. Non-empty means a migration is on disk
-- but never ran on prod (or someone manually DROPped the table). Investigate
-- before the next migration runs.
SELECT
  'Q2_REVERSE' AS check_id,
  r.table_name,
  NULL::int AS column_count,
  NULL::text AS columns
FROM in_repo_tables r
LEFT JOIN prod_tables p ON p.table_name = r.table_name
WHERE p.table_name IS NULL
ORDER BY r.table_name;

-- ============================================================
-- Q3  SUMMARY — every public table + column count + in_repo flag.
-- ============================================================
-- Reference snapshot to compare across audits. Order: in-repo first, then
-- ghosts (so the ghosts visually separate at the end).
SELECT
  'Q3_SUMMARY' AS check_id,
  p.table_name,
  p.column_count,
  CASE WHEN r.table_name IS NULL THEN 'GHOST' ELSE 'in_repo' END AS provenance
FROM prod_tables p
LEFT JOIN in_repo_tables r ON r.table_name = p.table_name
ORDER BY
  CASE WHEN r.table_name IS NULL THEN 1 ELSE 0 END,
  p.table_name;
