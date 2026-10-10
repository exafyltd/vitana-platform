-- aurora-realtime-setup.sql — database side of the self-hosted Supabase Realtime
-- server on Aurora (VTID-05023, plan part 7a; services/realtime-aurora/README.md).
--
-- Run with:  bash scripts/aws/aurora-run-sql.sh scripts/aws/aurora-realtime-setup.sql
-- (RDS Data API as the cluster master user, database `vitana`; one statement
-- per line, comment lines skipped, stops at the first failure). Idempotent:
-- every statement can be re-run. Run it AFTER the approved reboot that makes
-- rds.logical_replication=1 effective (statement 1 refuses otherwise).
--
-- No password here. The login role is created without one; the password is
-- set from Secrets Manager by scripts/aws/aurora-realtime-set-password.sh as a
-- SCRAM verifier, so the plaintext never appears in SQL, logs or the repo.
--
-- Lines ending in "-- @tables" are the production publication / replica
-- identity part. The local delivery test (services/realtime-aurora/test/
-- local-delivery.sh) runs every other line of this file unchanged against a
-- local Postgres and replaces the @tables lines with its own probe table.
--
-- 1. Logical decoding must be on (rds.logical_replication=1 after reboot).
DO $$ BEGIN IF current_setting('wal_level') <> 'logical' THEN RAISE EXCEPTION 'wal_level is %, need logical: set rds.logical_replication=1 in the cluster parameter group and reboot (owner-approved), then re-run', current_setting('wal_level'); END IF; END $$;
-- 1b. Realtime's postgres_changes decodes WAL with the wal2json output plugin
--     (pg_create_logical_replication_slot(..., 'wal2json', true)). Newer
--     PostgreSQL minors only let non-superuser REPLICATION roles use plugins
--     listed in output_plugin_libraries (default "pgoutput, test_decoding");
--     where that parameter exists it must include wal2json (cluster parameter
--     group). Then prove the plugin loads: a temporary slot, dropped in the
--     same statement, so nothing retains WAL.
DO $$ DECLARE v text := current_setting('output_plugin_libraries', true); BEGIN IF v IS NOT NULL AND position('wal2json' IN v) = 0 THEN RAISE EXCEPTION 'output_plugin_libraries is "%": add wal2json in the cluster parameter group, then re-run', v; END IF; END $$;
DO $$ BEGIN PERFORM pg_create_logical_replication_slot('realtime_setup_probe', 'wal2json', true); PERFORM pg_drop_replication_slot('realtime_setup_probe'); END $$;
-- 2. Refuse to adopt a realtime/_realtime schema someone else owns (for example
--    a copy of Supabase's own realtime schema from the data load): Realtime
--    keeps its migration state there and would skip or clash with migrations.
DO $$ DECLARE r record; BEGIN FOR r IN SELECT n.nspname, pg_get_userbyid(n.nspowner) AS owner FROM pg_namespace n WHERE n.nspname IN ('realtime', '_realtime') AND pg_get_userbyid(n.nspowner) <> 'realtime_admin' LOOP RAISE EXCEPTION 'schema % exists and is owned by %, not realtime_admin: inspect it (it may be a copy of Supabase''s realtime schema) and drop or rename it by review before re-running', r.nspname, r.owner; END LOOP; END $$;
-- 3. Login role for the Realtime server. INHERIT (needed for the ownership of
--    objects its own migrations hand to supabase_realtime_admin); no
--    superuser, no CREATEROLE, no BYPASSRLS. Password set separately.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'realtime_admin') THEN CREATE ROLE realtime_admin WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT 60; END IF; END $$;
ALTER ROLE realtime_admin WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT 60;
-- 4. Logical replication slots + the replication protocol (Aurora: the
--    rds_replication role; plain Postgres: the REPLICATION attribute).
GRANT rds_replication TO realtime_admin;
-- 5. CONNECT; CREATE on the database for the publication Realtime creates for
--    database broadcasts (supabase_realtime_messages_publication).
GRANT CONNECT, CREATE ON DATABASE vitana TO realtime_admin;
-- 6. Realtime's own state (_realtime: tenants, extensions, migrations) and the
--    tenant schema its migrations fill (realtime: subscription, messages,
--    list_changes, apply_rls, ...). Both owned by realtime_admin.
CREATE SCHEMA IF NOT EXISTS _realtime AUTHORIZATION realtime_admin;
CREATE SCHEMA IF NOT EXISTS realtime AUTHORIZATION realtime_admin;
-- 7. Roles the tenant migrations reference. supabase_realtime_admin is what
--    migration 20240401105812 would create (needs CREATEROLE, which
--    realtime_admin does not get); it then does GRANT supabase_realtime_admin
--    TO postgres, so realtime_admin holds it WITH ADMIN OPTION. A NOLOGIN
--    "postgres" role is created only if the cluster has none (the
--    20231204144023 grants name it).
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_realtime_admin') THEN CREATE ROLE supabase_realtime_admin WITH NOINHERIT NOLOGIN NOREPLICATION; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres WITH NOLOGIN; END IF; END $$;
--    dashboard_user (a Supabase platform role) is named by the REVOKE on
--    realtime.schema_migrations in a later tenant migration; NOLOGIN, no grants.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dashboard_user') THEN CREATE ROLE dashboard_user WITH NOLOGIN; END IF; END $$;
GRANT supabase_realtime_admin TO realtime_admin WITH ADMIN OPTION, INHERIT TRUE, SET TRUE;
-- 8. The API roles Realtime switches to (set_config('role', ...)) to evaluate
--    RLS per subscriber in realtime.apply_rls. SET only, never INHERIT, so
--    realtime_admin gets none of service_role's table privileges.
GRANT anon, authenticated, service_role TO realtime_admin WITH INHERIT FALSE, SET TRUE;
-- 8b. realtime.list_changes is created with "SET log_min_messages TO 'fatal'"
--     (tenant migration 20230328144023 and later). log_min_messages is a
--     superuser parameter, so a non-superuser can neither create nor run that
--     function without this grant (PostgreSQL 15+). Proven necessary by the
--     local delivery test. UNVERIFIED ON AURORA: whether the master user
--     (rds_superuser, not superuser) may grant it — run this file on the
--     Aurora clone first (plan part 10); if this line fails, stop and decide
--     by review, never by running Realtime as the master user.
GRANT SET ON PARAMETER log_min_messages TO realtime_admin;
-- 9. REPLICA IDENTITY exactly as Supabase has it: FULL for these 29 (old row
--    values on UPDATE/DELETE events); autopilot_actions, chat_group_members,
--    chat_groups and user_notifications stay DEFAULT on Supabase and here.
--    Set before the tables are published, so no window exists in which a
--    published table without a key rejects UPDATE/DELETE.
ALTER TABLE public.ai_messages REPLICA IDENTITY FULL; -- @tables
ALTER TABLE public.api_integrations REPLICA IDENTITY FULL; -- @tables
ALTER TABLE public.api_performance_metrics REPLICA IDENTITY FULL; -- @tables
ALTER TABLE public.api_test_logs REPLICA IDENTITY FULL; -- @tables
ALTER TABLE public.api_test_notifications REPLICA IDENTITY FULL; -- @tables
ALTER TABLE public.calendar_events REPLICA IDENTITY FULL; -- @tables
ALTER TABLE public.calendar_invite_responses REPLICA IDENTITY FULL; -- @tables
ALTER TABLE public.chat_messages REPLICA IDENTITY FULL; -- @tables
ALTER TABLE public.conversation_messages REPLICA IDENTITY FULL; -- @tables
ALTER TABLE public.exchange_rates REPLICA IDENTITY FULL; -- @tables
ALTER TABLE public.global_community_profiles REPLICA IDENTITY FULL; -- @tables
ALTER TABLE public.global_message_threads REPLICA IDENTITY FULL; -- @tables
ALTER TABLE public.global_messages REPLICA IDENTITY FULL; -- @tables
ALTER TABLE public.global_thread_participants REPLICA IDENTITY FULL; -- @tables
ALTER TABLE public.global_typing_indicators REPLICA IDENTITY FULL; -- @tables
ALTER TABLE public.media_uploads REPLICA IDENTITY FULL; -- @tables
ALTER TABLE public.message_actions REPLICA IDENTITY FULL; -- @tables
ALTER TABLE public.message_reactions REPLICA IDENTITY FULL; -- @tables
ALTER TABLE public.message_threads REPLICA IDENTITY FULL; -- @tables
ALTER TABLE public.messages REPLICA IDENTITY FULL; -- @tables
ALTER TABLE public.notifications REPLICA IDENTITY FULL; -- @tables
ALTER TABLE public.profile_posts REPLICA IDENTITY FULL; -- @tables
ALTER TABLE public.profiles REPLICA IDENTITY FULL; -- @tables
ALTER TABLE public.thread_participants REPLICA IDENTITY FULL; -- @tables
ALTER TABLE public.typing_indicators REPLICA IDENTITY FULL; -- @tables
ALTER TABLE public.user_activity_log REPLICA IDENTITY FULL; -- @tables
ALTER TABLE public.user_follows REPLICA IDENTITY FULL; -- @tables
ALTER TABLE public.user_wallets REPLICA IDENTITY FULL; -- @tables
ALTER TABLE public.wallet_transactions REPLICA IDENTITY FULL; -- @tables
-- 10. The publication postgres_changes reads, with exactly the 33 public tables
--     of Supabase's supabase_realtime publication (read live from Supabase's
--     pg_publication_tables, 2026-10-10). SET TABLE makes it exact on re-run.
--     First: the 4 tables that stay REPLICA IDENTITY DEFAULT must have a primary
--     key, or every UPDATE/DELETE on them fails once they are published
--     ("cannot update table ... because it does not have a replica identity").
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['autopilot_actions', 'chat_group_members', 'chat_groups', 'user_notifications'] LOOP IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'public' AND c.relname = t AND i.indisprimary) THEN RAISE EXCEPTION 'public.% has no primary key: publishing it with REPLICA IDENTITY DEFAULT would make its UPDATE/DELETE fail', t; END IF; END LOOP; END $$; -- @tables
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN CREATE PUBLICATION supabase_realtime; END IF; END $$; -- @tables
ALTER PUBLICATION supabase_realtime SET TABLE public.ai_messages, public.api_integrations, public.api_performance_metrics, public.api_test_logs, public.api_test_notifications, public.autopilot_actions, public.calendar_events, public.calendar_invite_responses, public.chat_group_members, public.chat_groups, public.chat_messages, public.conversation_messages, public.exchange_rates, public.global_community_profiles, public.global_message_threads, public.global_messages, public.global_thread_participants, public.global_typing_indicators, public.media_uploads, public.message_actions, public.message_reactions, public.message_threads, public.messages, public.notifications, public.profile_posts, public.profiles, public.thread_participants, public.typing_indicators, public.user_activity_log, public.user_follows, public.user_notifications, public.user_wallets, public.wallet_transactions; -- @tables
ALTER PUBLICATION supabase_realtime SET (publish = 'insert, update, delete, truncate'); -- @tables
-- 11. Verify: 33 tables published, the 29 FULL and the 4 DEFAULT as listed.
DO $$ DECLARE n int; f int; d int; BEGIN SELECT count(*) INTO n FROM pg_publication_tables WHERE pubname = 'supabase_realtime'; SELECT count(*) FILTER (WHERE c.relreplident = 'f'), count(*) FILTER (WHERE c.relreplident = 'd') INTO f, d FROM pg_publication_tables p JOIN pg_namespace s ON s.nspname = p.schemaname JOIN pg_class c ON c.relnamespace = s.oid AND c.relname = p.tablename WHERE p.pubname = 'supabase_realtime'; IF n <> 33 OR f <> 29 OR d <> 4 THEN RAISE EXCEPTION 'supabase_realtime: % tables (want 33), % FULL (want 29), % DEFAULT (want 4)', n, f, d; END IF; END $$; -- @tables
