-- VTID-05023 part 6 — WINDOW STEP, run on SUPABASE (project inmkhvwdcuyhnxkgfvsb) only
-- inside the cutover window. NOT run now. Rollback: supabase-cutover-unschedule-rollback.sql.
--
-- Stops every Supabase-side side effect of docs/validation/VTID-05023/side-effects.md
-- sections A and B so nothing fires twice once Aurora is the writer:
--   * the 25 pg_cron jobs (A) are unscheduled by name;
--   * the 2 pg_net triggers (B) are disabled.
--
-- Order in the window:
--   1. this file (Supabase);
--   2. scripts/aws/aurora-cutover-cron.sql (Aurora pg_cron, jobs 6-33);
--   3. AWS-PROD-SETUP-SCHEDULED-EDGE-CALLS.yml with enable=true (jobs 1 and 4);
--   4. OUTBOUND_HTTP_WORKER_ENABLED=true on the production gateway (section B).
--
-- Step 0 snapshots cron.job into vtid_05023_backup.cron_job_snapshot BEFORE anything
-- is unscheduled. The rollback restores from that snapshot, so it is exact even for
-- the jobs whose command is not in git (4, 15, 16). The backup schema gets no grants:
-- PostgREST/anon/authenticated cannot see it.
--
-- One statement per line (psql or the SQL editor). Idempotent: re-running neither
-- overwrites the first snapshot nor fails on an already-unscheduled job.
CREATE SCHEMA IF NOT EXISTS vtid_05023_backup;
REVOKE ALL ON SCHEMA vtid_05023_backup FROM PUBLIC;
CREATE TABLE IF NOT EXISTS vtid_05023_backup.cron_job_snapshot (jobid bigint, jobname text PRIMARY KEY, schedule text NOT NULL, command text NOT NULL, database text, username text, active boolean, snapshot_at timestamptz NOT NULL DEFAULT now());
INSERT INTO vtid_05023_backup.cron_job_snapshot (jobid, jobname, schedule, command, database, username, active) SELECT jobid, jobname, schedule, command, database, username, active FROM cron.job WHERE jobname IN ('appointment-reminders-hourly', 'run-api-integration-tests', 'oasis-events-info-retention', 'dev-autopilot-auto-archive', 'tenant-kpi-daily-retention', 'voice-healing-dedupe-prune', 'voice-healing-spec-memory-prune', 'voice-healing-history-prune', 'voice-healing-shadow-log-prune', 'vitana-id-mirror-reconcile', 'intent-matches-archival', 'vitana_id_mirror_reconcile_daily', 'intent_matches_archive_daily', 'compute_user_reputation_daily', 'intent_supply_seeder_daily', 'intent_matches_recompute_daily', 'feedback-classifier', 'feedback-auto-triage', 'community-search-history-retention', 'billing_feature_usage_prune', 'billing_reconcile_grants', 'billing_lifecycle_notifications', 'reap_stale_live_streams', 'conversation-metrics-hourly', 'purge-memory-transcript-turns') ON CONFLICT (jobname) DO NOTHING;
-- Fail loudly (and unschedule nothing) unless all 25 jobs are in the snapshot.
DO $chk$ DECLARE n integer; BEGIN SELECT count(*) INTO n FROM vtid_05023_backup.cron_job_snapshot; IF n <> 25 THEN RAISE EXCEPTION 'VTID-05023: expected 25 jobs in the snapshot, found % — stop, compare cron.job with side-effects.md section A', n; END IF; END $chk$;
-- A. the 25 pg_cron jobs
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'appointment-reminders-hourly';
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'run-api-integration-tests';
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'oasis-events-info-retention';
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'dev-autopilot-auto-archive';
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'tenant-kpi-daily-retention';
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'voice-healing-dedupe-prune';
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'voice-healing-spec-memory-prune';
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'voice-healing-history-prune';
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'voice-healing-shadow-log-prune';
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'vitana-id-mirror-reconcile';
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'intent-matches-archival';
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'vitana_id_mirror_reconcile_daily';
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'intent_matches_archive_daily';
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'compute_user_reputation_daily';
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'intent_supply_seeder_daily';
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'intent_matches_recompute_daily';
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'feedback-classifier';
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'feedback-auto-triage';
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'community-search-history-retention';
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'billing_feature_usage_prune';
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'billing_reconcile_grants';
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'billing_lifecycle_notifications';
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'reap_stale_live_streams';
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'conversation-metrics-hourly';
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'purge-memory-transcript-turns';
-- B. the 2 pg_net triggers (the 7 auth.users triggers of section C belong to the part-4 auth bridge, not here)
ALTER TABLE public.test_user_applications DISABLE TRIGGER trg_send_test_user_confirmation;
ALTER TABLE public.user_discount_codes DISABLE TRIGGER on_discount_code_created_send_email;
