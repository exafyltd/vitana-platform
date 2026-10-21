-- VTID-05023 part 6 — ROLLBACK of supabase-cutover-unschedule.sql, run on SUPABASE
-- (project inmkhvwdcuyhnxkgfvsb). Restores the 25 pg_cron jobs with their exact
-- schedules and commands and re-enables the 2 pg_net triggers.
--
-- The jobs come back from vtid_05023_backup.cron_job_snapshot, which the forward
-- script wrote from cron.job BEFORE unscheduling anything — byte-exact schedules and
-- commands, including jobs 4, 15 and 16 whose commands are not in git. A job that was
-- inactive when snapshotted is restored inactive. Job ids change (pg_cron assigns new
-- ones); nothing in the platform refers to a job by id except the historical
-- cron.alter_job(6, ...) in 20260916150000_vtid_03972, which is already applied.
--
-- Before running this, turn the Aurora side off so nothing fires twice:
--   * Aurora: SELECT cron.unschedule(jobid) FROM cron.job;   (jobs from aurora-cutover-cron.sql)
--   * AWS-PROD-SETUP-SCHEDULED-EDGE-CALLS.yml with enable=false (jobs 1 and 4)
--   * OUTBOUND_HTTP_WORKER_ENABLED=false on the gateway (pending outbox rows stay
--     queued on Aurora; nothing is lost, nothing is sent twice).
--
-- One statement per line. Idempotent: an existing job of the same name is replaced.
DO $chk$ DECLARE n integer; BEGIN SELECT count(*) INTO n FROM vtid_05023_backup.cron_job_snapshot; IF n <> 25 THEN RAISE EXCEPTION 'VTID-05023 rollback: expected 25 jobs in vtid_05023_backup.cron_job_snapshot, found %', n; END IF; END $chk$;
SELECT cron.unschedule(j.jobid) FROM cron.job j JOIN vtid_05023_backup.cron_job_snapshot s ON s.jobname = j.jobname;
SELECT cron.schedule(s.jobname, s.schedule, s.command) FROM vtid_05023_backup.cron_job_snapshot s ORDER BY s.jobid;
SELECT cron.alter_job(j.jobid, active => s.active) FROM cron.job j JOIN vtid_05023_backup.cron_job_snapshot s ON s.jobname = j.jobname WHERE s.active IS DISTINCT FROM j.active;
DO $chk$ DECLARE n integer; BEGIN SELECT count(*) INTO n FROM cron.job j JOIN vtid_05023_backup.cron_job_snapshot s ON s.jobname = j.jobname AND s.schedule = j.schedule AND s.command = j.command; IF n <> 25 THEN RAISE EXCEPTION 'VTID-05023 rollback: only % of 25 jobs restored identically', n; END IF; END $chk$;
ALTER TABLE public.test_user_applications ENABLE TRIGGER trg_send_test_user_confirmation;
ALTER TABLE public.user_discount_codes ENABLE TRIGGER on_discount_code_created_send_email;
