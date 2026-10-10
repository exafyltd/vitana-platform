# VTID-05023 part 6 — side effects that live in Supabase's database

Live inventory, read-only, Supabase project `inmkhvwdcuyhnxkgfvsb`, 2026-10-10.
Every line needs a replacement or a recorded drop before the window (plan part
6; the window checklist in part 11 requires every line resolved). At the flip,
every Supabase-side item below is unscheduled or disabled, so nothing fires
twice.

Queried: `cron.job`; every trigger whose function calls `net.http_*` or
`supabase_functions.http_request`, in any schema; every trigger on
`auth.users`. `supabase_functions.hooks` does not exist in this project, so
there are no dashboard database webhooks.

## A. pg_cron jobs (25 active)

| job | schedule | what | replacement |
|---|---|---|---|
| 1 appointment-reminders-hourly | `0 * * * *` | `net.http_post` → edge fn `send-appointment-reminder` | `.github/workflows/AWS-PROD-SETUP-SCHEDULED-EDGE-CALLS.yml`: Scheduler `cron(0 * * * ? *)` UTC → bus `vitana-scheduled-edge-calls` → rule → API destination (connection `vitana-supabase-edge-calls`, `Authorization: Bearer` from Secrets Manager), same body `{"triggered_by":"cron","timestamp":…}`, no retries; created DISABLED. The function then reads Aurora through the part-5 data client. |
| 4 run-api-integration-tests | `*/15 * * * *` | `net.http_post` → edge fn `run-api-tests` (body `{}`, public anon key; read live 2026-10-10) | `.github/workflows/AWS-PROD-SETUP-SCHEDULED-EDGE-CALLS.yml` with `run_api_tests_body='{}'` (created DISABLED). The owner may drop it instead (it is a test runner) |
| 6 oasis-events-info-retention | `0 3 * * *` | `CALL oasis_events_cleanup_batched(14,5000,200)` | `scripts/aws/aurora-cutover-cron.sql` (pg_cron on Aurora, identical name/schedule/command) |
| 7 dev-autopilot-auto-archive | `23 3 * * *` | UPDATE autopilot_recommendations … | `scripts/aws/aurora-cutover-cron.sql` (pg_cron on Aurora, identical name/schedule/command) |
| 8 tenant-kpi-daily-retention | `17 3 * * *` | DELETE tenant_kpi_daily > 90 d | `scripts/aws/aurora-cutover-cron.sql` (pg_cron on Aurora, identical name/schedule/command) |
| 9 voice-healing-dedupe-prune | `15 3 * * *` | `voice_healing_dedupe_prune()` | `scripts/aws/aurora-cutover-cron.sql` (pg_cron on Aurora, identical name/schedule/command) |
| 10 voice-healing-spec-memory-prune | `20 3 * * *` | `voice_healing_spec_memory_prune()` | `scripts/aws/aurora-cutover-cron.sql` (pg_cron on Aurora, identical name/schedule/command) |
| 11 voice-healing-history-prune | `25 3 * * *` | `voice_healing_history_prune()` | `scripts/aws/aurora-cutover-cron.sql` (pg_cron on Aurora, identical name/schedule/command) |
| 12 voice-healing-shadow-log-prune | `30 3 * * *` | `voice_healing_shadow_log_prune()` | `scripts/aws/aurora-cutover-cron.sql` (pg_cron on Aurora, identical name/schedule/command) |
| 13 vitana-id-mirror-reconcile | `0 4 * * *` | `reconcile_vitana_id_mirror()` | `scripts/aws/aurora-cutover-cron.sql` (pg_cron on Aurora, identical name/schedule/command) |
| 14 intent-matches-archival | `30 4 * * *` | `archive_old_intent_matches(90,500)` | `scripts/aws/aurora-cutover-cron.sql` (pg_cron on Aurora, identical name/schedule/command) |
| 15 vitana_id_mirror_reconcile_daily | `15 3 * * *` | `vitana_id_mirror_reconcile()` | `scripts/aws/aurora-cutover-cron.sql`: function body and command read live from Supabase 2026-10-10 (not in git), created on Aurora before scheduling |
| 16 intent_matches_archive_daily | `30 3 * * *` | `intent_matches_archive_old()` | `scripts/aws/aurora-cutover-cron.sql`: function body and command read live from Supabase 2026-10-10 (not in git), created on Aurora before scheduling |
| 17 compute_user_reputation_daily | `0 4 * * *` | `compute_user_reputation_daily()` | `scripts/aws/aurora-cutover-cron.sql` (pg_cron on Aurora, identical name/schedule/command) |
| 18 intent_supply_seeder_daily | `45 4 * * *` | `intent_supply_seeder_run()` | `scripts/aws/aurora-cutover-cron.sql` (pg_cron on Aurora, identical name/schedule/command) |
| 19 intent_matches_recompute_daily | `15 5 * * *` | `intent_matches_recompute_daily()` | `scripts/aws/aurora-cutover-cron.sql` (pg_cron on Aurora, identical name/schedule/command) |
| 20 feedback-classifier | `*/5 * * * *` | `classify_pending_feedback_tickets()` | `scripts/aws/aurora-cutover-cron.sql` (pg_cron on Aurora, identical name/schedule/command). **Verify on the clone** that the function body makes no HTTP call. |
| 21 feedback-auto-triage | `*/5 * * * *` | `auto_triage_pending_feedback_tickets()` | `scripts/aws/aurora-cutover-cron.sql` (pg_cron on Aurora, identical name/schedule/command); as job 20, verify no HTTP call |
| 22 community-search-history-retention | `15 4 * * *` | DELETE > 30 d | `scripts/aws/aurora-cutover-cron.sql` (pg_cron on Aurora, identical name/schedule/command) |
| 23 billing_feature_usage_prune | `0 3 * * *` | `fn_prune_feature_usage()` | `scripts/aws/aurora-cutover-cron.sql` (pg_cron on Aurora, identical name/schedule/command) |
| 24 billing_reconcile_grants | `10 3 * * *` | `fn_reconcile_redemption_grants()` | `scripts/aws/aurora-cutover-cron.sql` (pg_cron on Aurora, identical name/schedule/command) |
| 25 billing_lifecycle_notifications | `15 * * * *` | `fn_process_lifecycle_notifications()` | `scripts/aws/aurora-cutover-cron.sql` (pg_cron on Aurora, identical name/schedule/command). It inserts `user_notifications`; pushes go out through the gateway's `/push-dispatch` scan (`push_sent_at IS NULL`), which moves to Aurora with the gateway. |
| 26 reap_stale_live_streams | `15 * * * *` | `fn_reap_stale_live_streams()` | `scripts/aws/aurora-cutover-cron.sql` (pg_cron on Aurora, identical name/schedule/command) |
| 32 conversation-metrics-hourly | `7 * * * *` | `conversation_metrics_rollup_hour(…)` ×2 | `scripts/aws/aurora-cutover-cron.sql` (pg_cron on Aurora, identical name/schedule/command) |
| 33 purge-memory-transcript-turns | `17 3 * * *` | `purge_memory_transcript_turns(90)` | `scripts/aws/aurora-cutover-cron.sql` (pg_cron on Aurora, identical name/schedule/command) |

Aurora needs `shared_preload_libraries` to include `pg_cron` and `cron.database_name = vitana` in the cluster parameter group: `scripts/aws/aurora-cluster-params-cutover.sh` (dry run by default, `--apply`; also sets `rds.logical_replication=1` and creates the R3 alarms on `OldestReplicationSlotLag` and `TransactionLogsDiskUsage`). That takes the same reboot as `rds.logical_replication=1` (owner-approved; the script prints the reboot commands and never runs them), then `CREATE EXTENSION pg_cron` (first line of `aurora-cutover-cron.sql`, run with `aurora-run-sql.sh`). At the flip, `scripts/aws/supabase-cutover-unschedule.sql` unschedules all 25 Supabase jobs after snapshotting them; `scripts/aws/supabase-cutover-unschedule-rollback.sql` restores them byte-identical from that snapshot.

## B. Triggers that make HTTP calls (2)

| table | trigger → function | replacement |
|---|---|---|
| `public.test_user_applications` | `trg_send_test_user_confirmation` → `notify_test_user_confirmation()` (pg_net) | Outbox, `scripts/aws/aurora-cutover-outbox.sql`: on Aurora the function inserts a row into `public.outbound_http_requests` (the secret header stored as `{"secret_ref":"email_trigger_secret"}`), and `services/gateway/src/services/outbound-http-worker.ts` sends it (`OUTBOUND_HTTP_WORKER_ENABLED=true`; the gateway needs `EMAIL_TRIGGER_SECRET`). Retries with backoff, 5 attempts, idempotent on row id. The Supabase trigger is disabled by `supabase-cutover-unschedule.sql`. |
| `public.user_discount_codes` | `on_discount_code_created_send_email` → `notify_welcome_discount()` (pg_net) | Same outbox and worker (`scripts/aws/aurora-cutover-outbox.sql`; `Authorization` stored as `{"secret_ref":"supabase_service_role_bearer"}`; the base URL came from vault `supabase_url` — **verify** on the clone that it is `https://inmkhvwdcuyhnxkgfvsb.supabase.co`). **Blocking risk:** Aurora has no `pg_net`. If this function exists there unchanged, every insert into `user_discount_codes` errors, including the one new-member provisioning makes. Verify on the clone and fix before the bridge goes live. |

## C. Triggers on `auth.users` (7) — handled by the auth bridge (part 4)

| trigger → function | at the flip |
|---|---|
| `on_auth_user_created` → `handle_new_user` | disabled on Supabase; the same provisioning runs on Aurora through the bridge (`ensure_provisioned`, webhook, reconciliation) |
| `on_auth_user_created_generate_discount` → `generate_maxina_discount_code` | disabled; bridge (writes `user_discount_codes` → outbox email, B) |
| `on_auth_user_created_preferences` → `initialize_user_preferences` | disabled; bridge |
| `on_auth_user_created_wallet` → `provision_wallet_accounts` | disabled; bridge |
| `on_auth_user_platform_provision` → `provision_platform_user` | disabled; bridge |
| `on_user_journey_created` → `initialize_user_journey` | disabled; bridge |
| `before_auth_user_delete_cleanup_contacts` → `cleanup_identifierless_contacts_before_user_delete` | **kept** on Supabase (it unblocks auth.users deletion); the bridge's deletion path does the Aurora side |

## D. Not database side effects (moved by other parts)

- Push notifications: the gateway's notification service and its `/push-dispatch` scan move to Aurora with the gateway (part 3, R1 b).
- The gateway's B5 realtime relay (`services/realtime/generic-cursor-relay.ts`) polls tables through the gateway and moves with it.
