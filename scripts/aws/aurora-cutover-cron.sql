-- VTID-05023 part 6 — the 23 plain-SQL pg_cron jobs from Supabase, recreated on Aurora.
-- Source: docs/validation/VTID-05023/side-effects.md section A (jobs 6-33). Names,
-- schedules (UTC) and commands are identical to Supabase; each command is copied
-- byte for byte from the migration that created it (generated, not retyped).
-- Run with scripts/aws/aurora-run-sql.sh (one statement per line, -- lines skipped),
-- in the cutover window only, after scripts/aws/aurora-cluster-params-cutover.sh
-- --apply and the reboot it prints (pg_cron must be in shared_preload_libraries and
-- cron.database_name = vitana). Idempotent: every job is unscheduled by name first.
-- The HTTP jobs 1 and 4 are NOT here: see AWS-PROD-SETUP-SCHEDULED-EDGE-CALLS.yml.
CREATE EXTENSION IF NOT EXISTS pg_cron;
-- job 6 oasis-events-info-retention (live job created by hand; command from cron.alter_job in 20260916150000_vtid_03972_widen_oasis_events_retention.sql, schedule from the live inventory)
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'oasis-events-info-retention';
SELECT cron.schedule('oasis-events-info-retention', '0 3 * * *', $cron$CALL public.oasis_events_cleanup_batched(14, 5000, 200)$cron$);
-- job 7 dev-autopilot-auto-archive (20260416100000_dev_autopilot.sql)
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'dev-autopilot-auto-archive';
SELECT cron.schedule('dev-autopilot-auto-archive', '23 3 * * *', E'\n        UPDATE autopilot_recommendations\n        SET status = \'auto_archived\',\n            updated_at = NOW()\n        WHERE source_type = \'dev_autopilot\'\n          AND status = \'new\'\n          AND last_seen_at < NOW() - (\n            COALESCE((SELECT auto_archive_days FROM dev_autopilot_config WHERE id = 1), 30)\n            * INTERVAL \'1 day\'\n          );\n      ');
-- job 8 tenant-kpi-daily-retention (20260421230000_BOOTSTRAP_admin_kpi_retention_fix.sql)
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'tenant-kpi-daily-retention';
SELECT cron.schedule('tenant-kpi-daily-retention', '17 3 * * *', $cron$DELETE FROM public.tenant_kpi_daily WHERE snapshot_date < (NOW() - INTERVAL '90 days')::date;$cron$);
-- job 9 voice-healing-dedupe-prune (20260425600000_vtid_01959_voice_healing_dedupe.sql)
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'voice-healing-dedupe-prune';
SELECT cron.schedule('voice-healing-dedupe-prune', '15 3 * * *', $cron$SELECT public.voice_healing_dedupe_prune()$cron$);
-- job 10 voice-healing-spec-memory-prune (20260425700000_vtid_01960_voice_healing_spec_memory.sql)
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'voice-healing-spec-memory-prune';
SELECT cron.schedule('voice-healing-spec-memory-prune', '20 3 * * *', $cron$SELECT public.voice_healing_spec_memory_prune()$cron$);
-- job 11 voice-healing-history-prune (20260425800000_vtid_01962_voice_healing_sentinel.sql)
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'voice-healing-history-prune';
SELECT cron.schedule('voice-healing-history-prune', '25 3 * * *', $cron$SELECT public.voice_healing_history_prune()$cron$);
-- job 12 voice-healing-shadow-log-prune (20260426000000_vtid_01964_voice_healing_shadow_log.sql)
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'voice-healing-shadow-log-prune';
SELECT cron.schedule('voice-healing-shadow-log-prune', '30 3 * * *', $cron$SELECT public.voice_healing_shadow_log_prune()$cron$);
-- job 13 vitana-id-mirror-reconcile (20260427180000_vtid_01990_vitana_id_mirror_reconcile.sql)
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'vitana-id-mirror-reconcile';
SELECT cron.schedule('vitana-id-mirror-reconcile', '0 4 * * *', $cron$SELECT public.reconcile_vitana_id_mirror()$cron$);
-- job 14 intent-matches-archival (20260427190000_vtid_01991_intent_matches_archival_cron.sql)
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'intent-matches-archival';
SELECT cron.schedule('intent-matches-archival', '30 4 * * *', $cron$SELECT public.archive_old_intent_matches(90, 500)$cron$);
-- job 17 compute_user_reputation_daily (20260504040000_d6_reputation_cron.sql)
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'compute_user_reputation_daily';
SELECT cron.schedule('compute_user_reputation_daily', '0 4 * * *', $cron$ SELECT public.compute_user_reputation_daily() $cron$);
-- job 18 intent_supply_seeder_daily (20260504050000_d7_supply_seeder.sql)
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'intent_supply_seeder_daily';
SELECT cron.schedule('intent_supply_seeder_daily', '45 4 * * *', $cron$ SELECT public.intent_supply_seeder_run() $cron$);
-- job 19 intent_matches_recompute_daily (20260505000300_d12_match_recompute_daily_cron.sql)
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'intent_matches_recompute_daily';
SELECT cron.schedule('intent_matches_recompute_daily', '15 5 * * *', $cron$ SELECT public.intent_matches_recompute_daily() $cron$);
-- job 20 feedback-classifier (20260429110000_vtid_02604_feedback_classifier.sql)
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'feedback-classifier';
SELECT cron.schedule('feedback-classifier', '*/5 * * * *', $cron$SELECT public.classify_pending_feedback_tickets()$cron$);
-- job 21 feedback-auto-triage (20260429160000_vtid_02047_auto_triage.sql)
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'feedback-auto-triage';
SELECT cron.schedule('feedback-auto-triage', '*/5 * * * *', $cron$SELECT public.auto_triage_pending_feedback_tickets()$cron$);
-- job 22 community-search-history-retention (20260510000000_vtid_02754_community_search_history.sql)
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'community-search-history-retention';
SELECT cron.schedule('community-search-history-retention', '15 4 * * *', $cron$DELETE FROM public.community_search_history WHERE created_at < now() - interval '30 days'$cron$);
-- job 23 billing_feature_usage_prune (20260526050000_VTID_03107_cron_cleanup.sql)
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'billing_feature_usage_prune';
SELECT cron.schedule('billing_feature_usage_prune', '0 3 * * *', $cron$SELECT public.fn_prune_feature_usage();$cron$);
-- job 24 billing_reconcile_grants (20260526050000_VTID_03107_cron_cleanup.sql)
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'billing_reconcile_grants';
SELECT cron.schedule('billing_reconcile_grants', '10 3 * * *', $cron$SELECT public.fn_reconcile_redemption_grants();$cron$);
-- job 25 billing_lifecycle_notifications (20260526080000_VTID_03107_lifecycle_notifications.sql)
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'billing_lifecycle_notifications';
SELECT cron.schedule('billing_lifecycle_notifications', '15 * * * *', $cron$SELECT public.fn_process_lifecycle_notifications();$cron$);
-- job 26 reap_stale_live_streams (20260630120000_BOOTSTRAP_reap_stale_live_streams.sql)
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'reap_stale_live_streams';
SELECT cron.schedule('reap_stale_live_streams', '15 * * * *', $cron$SELECT public.fn_reap_stale_live_streams();$cron$);
-- job 32 conversation-metrics-hourly (20260923140000_vtid_04371_conversation_metrics_hourly.sql)
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'conversation-metrics-hourly';
SELECT cron.schedule('conversation-metrics-hourly', '7 * * * *', E'SELECT public.conversation_metrics_rollup_hour(date_trunc(\'hour\', NOW()) - INTERVAL \'1 hour\');\n            SELECT public.conversation_metrics_rollup_hour(date_trunc(\'hour\', NOW()) - INTERVAL \'2 hours\');');
-- job 33 purge-memory-transcript-turns (20260923160000_vtid_04387_memory_transcript_turns.sql)
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'purge-memory-transcript-turns';
SELECT cron.schedule('purge-memory-transcript-turns', '17 3 * * *', $cron$SELECT public.purge_memory_transcript_turns(90);$cron$);
-- TODO(VTID-05023) job 15 vitana_id_mirror_reconcile_daily (15 3 * * *): NOT in either repo.
--   Missing: the exact command text (inventory shows vitana_id_mirror_reconcile()) and the
--   function public.vitana_id_mirror_reconcile() itself. Copy both read-only from the clone:
--   SELECT schedule, command FROM cron.job WHERE jobname = 'vitana_id_mirror_reconcile_daily';
--   then add the unschedule/schedule pair here. Not guessed.
-- TODO(VTID-05023) job 16 intent_matches_archive_daily (30 3 * * *): NOT in either repo.
--   Missing: the exact command text (inventory shows intent_matches_archive_old()) and the
--   function public.intent_matches_archive_old() itself. Copy both read-only from the clone:
--   SELECT schedule, command FROM cron.job WHERE jobname = 'intent_matches_archive_daily';
--   then add the unschedule/schedule pair here. Not guessed.
