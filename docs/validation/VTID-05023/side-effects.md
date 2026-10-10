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
| 1 appointment-reminders-hourly | `0 * * * *` | `net.http_post` → edge fn `send-appointment-reminder` | EventBridge Scheduler → API destination (the edge function URL, auth header from Secrets Manager). The function then reads Aurora through the part-5 data client. |
| 4 run-api-integration-tests | `*/15 * * * *` | `net.http_post` → edge fn `run-api-tests` | Same as job 1. The owner may drop it instead, since it is a test runner; that would be recorded here. |
| 6 oasis-events-info-retention | `0 3 * * *` | `CALL oasis_events_cleanup_batched(14,5000,200)` | pg_cron on Aurora, identical |
| 7 dev-autopilot-auto-archive | `23 3 * * *` | UPDATE autopilot_recommendations … | pg_cron on Aurora, identical |
| 8 tenant-kpi-daily-retention | `17 3 * * *` | DELETE tenant_kpi_daily > 90 d | pg_cron on Aurora, identical |
| 9 voice-healing-dedupe-prune | `15 3 * * *` | `voice_healing_dedupe_prune()` | pg_cron on Aurora, identical |
| 10 voice-healing-spec-memory-prune | `20 3 * * *` | `voice_healing_spec_memory_prune()` | pg_cron on Aurora, identical |
| 11 voice-healing-history-prune | `25 3 * * *` | `voice_healing_history_prune()` | pg_cron on Aurora, identical |
| 12 voice-healing-shadow-log-prune | `30 3 * * *` | `voice_healing_shadow_log_prune()` | pg_cron on Aurora, identical |
| 13 vitana-id-mirror-reconcile | `0 4 * * *` | `reconcile_vitana_id_mirror()` | pg_cron on Aurora, identical |
| 14 intent-matches-archival | `30 4 * * *` | `archive_old_intent_matches(90,500)` | pg_cron on Aurora, identical |
| 15 vitana_id_mirror_reconcile_daily | `15 3 * * *` | `vitana_id_mirror_reconcile()` | pg_cron on Aurora, identical (jobs 13 and 15 overlap; that is today's behaviour, kept) |
| 16 intent_matches_archive_daily | `30 3 * * *` | `intent_matches_archive_old()` | pg_cron on Aurora, identical |
| 17 compute_user_reputation_daily | `0 4 * * *` | `compute_user_reputation_daily()` | pg_cron on Aurora, identical |
| 18 intent_supply_seeder_daily | `45 4 * * *` | `intent_supply_seeder_run()` | pg_cron on Aurora, identical |
| 19 intent_matches_recompute_daily | `15 5 * * *` | `intent_matches_recompute_daily()` | pg_cron on Aurora, identical |
| 20 feedback-classifier | `*/5 * * * *` | `classify_pending_feedback_tickets()` | pg_cron on Aurora, identical. **Verify on the clone** that the function body makes no HTTP call. |
| 21 feedback-auto-triage | `*/5 * * * *` | `auto_triage_pending_feedback_tickets()` | as job 20 |
| 22 community-search-history-retention | `15 4 * * *` | DELETE > 30 d | pg_cron on Aurora, identical |
| 23 billing_feature_usage_prune | `0 3 * * *` | `fn_prune_feature_usage()` | pg_cron on Aurora, identical |
| 24 billing_reconcile_grants | `10 3 * * *` | `fn_reconcile_redemption_grants()` | pg_cron on Aurora, identical |
| 25 billing_lifecycle_notifications | `15 * * * *` | `fn_process_lifecycle_notifications()` | pg_cron on Aurora, identical. It inserts `user_notifications`; pushes go out through the gateway's `/push-dispatch` scan (`push_sent_at IS NULL`), which moves to Aurora with the gateway. |
| 26 reap_stale_live_streams | `15 * * * *` | `fn_reap_stale_live_streams()` | pg_cron on Aurora, identical |
| 32 conversation-metrics-hourly | `7 * * * *` | `conversation_metrics_rollup_hour(…)` ×2 | pg_cron on Aurora, identical |
| 33 purge-memory-transcript-turns | `17 3 * * *` | `purge_memory_transcript_turns(90)` | pg_cron on Aurora, identical |

Aurora needs `shared_preload_libraries` to include `pg_cron` and `cron.database_name = vitana` in the cluster parameter group. That takes the same reboot as `rds.logical_replication=1` (owner-approved), then `CREATE EXTENSION pg_cron`.

## B. Triggers that make HTTP calls (2)

| table | trigger → function | replacement |
|---|---|---|
| `public.test_user_applications` | `trg_send_test_user_confirmation` → `notify_test_user_confirmation()` (pg_net) | Outbox: on Aurora the function inserts a row into `public.outbound_http_requests`, and a gateway worker sends it. Retries, idempotent on row id. |
| `public.user_discount_codes` | `on_discount_code_created_send_email` → `notify_welcome_discount()` (pg_net) | Same outbox. **Blocking risk:** Aurora has no `pg_net`. If this function exists there unchanged, every insert into `user_discount_codes` errors, including the one new-member provisioning makes. Verify on the clone and fix before the bridge goes live. |

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
