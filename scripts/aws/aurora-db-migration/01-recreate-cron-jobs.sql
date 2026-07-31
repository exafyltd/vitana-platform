-- VTID-03450: pg_cron job recreation for Aurora (vitana-aurora-prod)
--
-- DO NOT RUN THIS AGAINST AURORA UNTIL DMS REPLICATION HAS BEEN STOPPED AND
-- AURORA IS THE SOLE WRITER FOR THESE TABLES.
--
-- Running these jobs while DMS CDC is still replicating Supabase -> Aurora
-- would put a second, competing writer on DMS-managed tables (this script's
-- jobs run DELETEs/UPDATEs), which is the kind of thing that corrupts
-- replication consistency. This file exists so the exact statements are
-- ready and reviewed ahead of time -- it is not meant to be executed as
-- part of routine deployment.
--
-- Source of truth for what's actually scheduled on Supabase today:
--   select jobid, jobname, schedule, command, active from cron.job order by jobid;
-- (run against the VITANA Supabase project, inmkhvwdcuyhnxkgfvsb)
--
-- 21 of the 23 live Supabase cron.job rows are reproduced below -- pure SQL
-- (DELETEs or public.*() function calls), no external HTTP dependency, and
-- every function/table they touch has been confirmed to already exist on
-- Aurora (VTID-03450 verification, 2026-07-31).
--
-- The other 2 Supabase jobs (`appointment-reminders-hourly`,
-- `run-api-integration-tests`) call net.http_post() against Supabase Edge
-- Functions. Aurora doesn't have the pg_net extension, but neither job reads
-- or writes app data in its own SQL body -- they're just timers pinging an
-- HTTP endpoint. Recommendation: leave those 2 running on Supabase's own
-- pg_cron indefinitely; nothing about the DB-layer cutover requires moving
-- them, and doing so would need pg_net installed on Aurora for no benefit.

select cron.schedule('oasis-events-info-retention', '0 3 * * *',
  $$DELETE FROM oasis_events WHERE status = 'info' AND created_at < NOW() - INTERVAL '7 days'$$);

select cron.schedule('dev-autopilot-auto-archive', '23 3 * * *', $$
  UPDATE autopilot_recommendations
  SET status = 'auto_archived',
      updated_at = NOW()
  WHERE source_type = 'dev_autopilot'
    AND status = 'new'
    AND last_seen_at < NOW() - (
      COALESCE((SELECT auto_archive_days FROM dev_autopilot_config WHERE id = 1), 30)
      * INTERVAL '1 day'
    );
$$);

select cron.schedule('tenant-kpi-daily-retention', '17 3 * * *',
  $$DELETE FROM public.tenant_kpi_daily WHERE snapshot_date < (NOW() - INTERVAL '90 days')::date;$$);

select cron.schedule('voice-healing-dedupe-prune', '15 3 * * *', $$SELECT public.voice_healing_dedupe_prune()$$);
select cron.schedule('voice-healing-spec-memory-prune', '20 3 * * *', $$SELECT public.voice_healing_spec_memory_prune()$$);
select cron.schedule('voice-healing-history-prune', '25 3 * * *', $$SELECT public.voice_healing_history_prune()$$);
select cron.schedule('voice-healing-shadow-log-prune', '30 3 * * *', $$SELECT public.voice_healing_shadow_log_prune()$$);
select cron.schedule('vitana-id-mirror-reconcile', '0 4 * * *', $$SELECT public.reconcile_vitana_id_mirror()$$);
select cron.schedule('intent-matches-archival', '30 4 * * *', $$SELECT public.archive_old_intent_matches(90, 500)$$);
select cron.schedule('vitana_id_mirror_reconcile_daily', '15 3 * * *', $$ SELECT public.vitana_id_mirror_reconcile() $$);
select cron.schedule('intent_matches_archive_daily', '30 3 * * *', $$ SELECT public.intent_matches_archive_old() $$);
select cron.schedule('compute_user_reputation_daily', '0 4 * * *', $$ SELECT public.compute_user_reputation_daily() $$);
select cron.schedule('intent_supply_seeder_daily', '45 4 * * *', $$ SELECT public.intent_supply_seeder_run() $$);
select cron.schedule('intent_matches_recompute_daily', '15 5 * * *', $$ SELECT public.intent_matches_recompute_daily() $$);
select cron.schedule('feedback-classifier', '*/5 * * * *', $$SELECT public.classify_pending_feedback_tickets()$$);
select cron.schedule('feedback-auto-triage', '*/5 * * * *', $$SELECT public.auto_triage_pending_feedback_tickets()$$);

select cron.schedule('community-search-history-retention', '15 4 * * *',
  $$DELETE FROM public.community_search_history WHERE created_at < now() - interval '30 days'$$);

select cron.schedule('billing_feature_usage_prune', '0 3 * * *', $$SELECT public.fn_prune_feature_usage();$$);
select cron.schedule('billing_reconcile_grants', '10 3 * * *', $$SELECT public.fn_reconcile_redemption_grants();$$);
select cron.schedule('billing_lifecycle_notifications', '15 * * * *', $$SELECT public.fn_process_lifecycle_notifications();$$);
select cron.schedule('reap_stale_live_streams', '15 * * * *', $$SELECT public.fn_reap_stale_live_streams();$$);

-- After running (at actual cutover time, post-DMS-stop), verify:
--   select jobid, jobname, schedule, active from cron.job order by jobid;
-- should show 21 rows matching the Supabase list minus the 2 excluded above,
-- and a decision recorded on whether Supabase's copies of these 21 jobs get
-- unscheduled (cron.unschedule) at the same time to avoid double-running the
-- maintenance logic against two databases.
